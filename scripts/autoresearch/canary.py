#!/usr/bin/env python3
"""Autoresearch v0 canary.

This is deliberately not an optimizer yet. It proves the safety contract first:

1. verify product source + frozen evaluator match the pinned upstream base;
2. build and benchmark the unchanged control;
3. apply one temporary, known-bad product mutation;
4. build the candidate, then restore source bytes before evaluation;
5. run the repository's existing startup benchmark unchanged;
6. require the frozen judge to reject the known regression.

No candidate source mutation is committed or pushed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "src/core/app/app_entry_runtime.zig"
BENCH = ROOT / "benchmarks/startup.sh"
RESULTS = ROOT / "benchmarks/results"
FX_BIN = ROOT / "zig-out/bin/fx"
CHECK_BUDGETS = ROOT / "benchmarks/check_budgets.py"
SUMMARIZE = ROOT / "benchmarks/summarize.py"

NEEDLE = """fn runBeforeInteractiveWithDeps(alloc: Allocator, args: []const [:0]const u8, cfg: Config, deps: RunDeps) !BeforeInteractiveResult {
    const run_result = deps.run_if_requested"""
REPLACEMENT = """fn runBeforeInteractiveWithDeps(alloc: Allocator, args: []const [:0]const u8, cfg: Config, deps: RunDeps) !BeforeInteractiveResult {
    io_mod.sleep(5 * std.time.ns_per_ms); // AUTORESEARCH_V0_KNOWN_REGRESSION
    const run_result = deps.run_if_requested"""

HYPERFINE_FILES = (
    "baseline.json",
    "startup.json",
    "help.json",
    "status.json",
    "doctor.json",
    "sessions.json",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def run(
    args: list[str],
    *,
    log: Path,
    env: dict[str, str] | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    proc = subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    elapsed = time.monotonic() - started
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        f"$ {' '.join(args)}\n"
        f"exit={proc.returncode} elapsed_s={elapsed:.6f}\n\n"
        f"{proc.stdout}",
        encoding="utf-8",
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(args)}")
    return proc


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def assert_frozen_base(product_base: str) -> None:
    # The controller/workflow may differ from upstream, but neither the product
    # nor the evaluator is allowed to drift before the experiment begins.
    proc = subprocess.run(
        [
            "git",
            "diff",
            "--quiet",
            product_base,
            "--",
            "src",
            "build.zig",
            "benchmarks",
        ],
        cwd=ROOT,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "product source or frozen benchmark differs from the pinned product base"
        )


def copy_benchmark_results(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in HYPERFINE_FILES:
        source = RESULTS / name
        if source.exists():
            shutil.copy2(source, destination / name)
    for name in ("summary.json", "summary.md"):
        source = RESULTS / name
        if source.exists():
            shutil.copy2(source, destination / name)


def benchmark(binary: Path, label: str, out: Path) -> tuple[int, dict[str, float]]:
    RESULTS.mkdir(parents=True, exist_ok=True)
    for child in RESULTS.iterdir():
        if child.is_file():
            child.unlink()
        elif child.is_dir():
            shutil.rmtree(child)

    FX_BIN.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, FX_BIN)
    FX_BIN.chmod(0o755)

    env = os.environ.copy()
    env["FX_AUTO_UPGRADE"] = "0"
    proc = run(
        [str(BENCH), "--ci"],
        log=out / "logs" / f"{label}-benchmark.log",
        env=env,
    )
    result_dir = out / label / "benchmark-results"
    copy_benchmark_results(result_dir)

    means: dict[str, float] = {}
    for name in HYPERFINE_FILES:
        path = result_dir / name
        if not path.exists():
            continue
        parsed = json.loads(path.read_text(encoding="utf-8"))
        rows = parsed.get("results") or []
        if rows and isinstance(rows[0].get("mean"), (int, float)):
            means[name.removesuffix(".json")] = float(rows[0]["mean"])
    return proc.returncode, means


def main() -> int:
    product_base = os.environ.get("FX_AUTORESEARCH_PRODUCT_BASE", "").strip()
    if len(product_base) != 40:
        raise RuntimeError("FX_AUTORESEARCH_PRODUCT_BASE must be an exact 40-char SHA")

    out = Path(os.environ.get("FX_AUTORESEARCH_OUT", "/tmp/fx-autoresearch-v0"))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    report: dict[str, object] = {
        "format_version": 1,
        "experiment": "known-startup-regression-canary",
        "product_base_sha": product_base,
        "controller_head_sha": git("rev-parse", "HEAD"),
        "target": str(TARGET.relative_to(ROOT)),
        "evaluator": {
            "startup_sh_sha256": sha256_file(BENCH),
            "check_budgets_sha256": sha256_file(CHECK_BUDGETS),
            "summarize_sha256": sha256_file(SUMMARIZE),
        },
    }

    original = TARGET.read_bytes()
    report["control_source_sha256"] = sha256_bytes(original)

    try:
        assert_frozen_base(product_base)

        run(
            ["zig", "build", "-Doptimize=ReleaseSafe"],
            log=out / "logs" / "control-build.log",
            check=True,
        )
        control_binary = out / "control" / "fx"
        control_binary.parent.mkdir(parents=True)
        shutil.copy2(FX_BIN, control_binary)
        report["control_binary_sha256"] = sha256_file(control_binary)

        control_rc, control_means = benchmark(control_binary, "control", out)
        report["control_benchmark_exit"] = control_rc
        report["control_mean_seconds"] = control_means
        if control_rc != 0:
            report["decision"] = "INVALID_BASELINE"
            return write_report(report, out, 2)

        source = original.decode("utf-8")
        if source.count(NEEDLE) != 1:
            raise RuntimeError("canary mutation anchor is not unique on this revision")
        mutated = source.replace(NEEDLE, REPLACEMENT, 1).encode("utf-8")
        TARGET.write_bytes(mutated)
        report["candidate_source_sha256"] = sha256_bytes(mutated)
        report["candidate_mutation"] = "inject 5 ms delay before CLI dispatch"

        candidate_build = run(
            ["zig", "build", "-Doptimize=ReleaseSafe"],
            log=out / "logs" / "candidate-build.log",
        )
        if candidate_build.returncode != 0:
            report["decision"] = "INVALID_CANARY"
            report["reason"] = "known-bad candidate failed to build"
            return write_report(report, out, 3)

        candidate_binary = out / "candidate" / "fx"
        candidate_binary.parent.mkdir(parents=True)
        shutil.copy2(FX_BIN, candidate_binary)
        report["candidate_binary_sha256"] = sha256_file(candidate_binary)

        # Restore the source before the candidate is judged. The evaluator sees
        # only immutable binaries and its own unchanged files.
        TARGET.write_bytes(original)
        if sha256_file(TARGET) != report["control_source_sha256"]:
            raise RuntimeError("failed to restore candidate source before evaluation")

        candidate_rc, candidate_means = benchmark(candidate_binary, "candidate", out)
        report["candidate_benchmark_exit"] = candidate_rc
        report["candidate_mean_seconds"] = candidate_means

        control_startup = control_means.get("startup")
        candidate_startup = candidate_means.get("startup")
        if control_startup and candidate_startup:
            report["startup_regression_ratio"] = candidate_startup / control_startup

        # The frozen repository judge must reject this canary. We also require
        # the measured startup mean to move materially in the expected direction
        # so an unrelated benchmark failure cannot masquerade as a successful test.
        ratio = report.get("startup_regression_ratio")
        if candidate_rc != 0 and isinstance(ratio, float) and ratio >= 1.5:
            report["decision"] = "DISCARD"
            report["reason"] = "frozen startup judge rejected known latency regression"
            return write_report(report, out, 0)

        report["decision"] = "CANARY_NOT_REJECTED"
        report["reason"] = (
            "candidate was not rejected with a >=1.5x measured startup regression"
        )
        return write_report(report, out, 4)
    finally:
        TARGET.write_bytes(original)


def write_report(report: dict[str, object], out: Path, code: int) -> int:
    path = out / "report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        out = Path(os.environ.get("FX_AUTORESEARCH_OUT", "/tmp/fx-autoresearch-v0"))
        out.mkdir(parents=True, exist_ok=True)
        failure = {
            "format_version": 1,
            "decision": "ERROR",
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
        (out / "report.json").write_text(
            json.dumps(failure, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(failure, indent=2, sort_keys=True), file=sys.stderr)
        raise
