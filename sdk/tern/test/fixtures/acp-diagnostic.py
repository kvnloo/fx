#!/usr/bin/env python3
"""Replay the recorded root compiler command with ACP-only, non-server diagnostics.

This is not an acceptance gate: the caller always preserves the full-root result.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time

root_log, evidence = Path(sys.argv[1]), Path(sys.argv[2])
command = None
for line in root_log.read_text().splitlines():
    try:
        args = shlex.split(line)
    except ValueError:
        continue
    if (len(args) > 2 and Path(args[0]).name == "zig" and args[1] == "test"
            and any(arg.startswith("-Mroot=") and arg.endswith("/src/main.zig") for arg in args)):
        command = args
        break
if command is None:
    raise SystemExit("ACP diagnostic cannot find the real verbose root compiler command")
# Keep the exact generated module graph and target/optimization flags. Expose
# error names/return traces instead of the build server's no-output summary.
command = [{"-fstrip": "-fno-strip", "-fno-error-tracing": "-ferror-tracing"}.get(arg, arg)
           for arg in command if arg not in ("--listen=-", "--test-no-exec")]
command += ["--test-filter", "acp.sessions"]
print("ACP_DIAGNOSTIC_START", shlex.join(command), flush=True)
started = time.monotonic()
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
timed_out = False
try:
    output = process.communicate(timeout=600)[0]
except subprocess.TimeoutExpired:
    timed_out = True
    os.killpg(process.pid, signal.SIGKILL)
    try:
        output = process.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired as error:
        output = error.output or b""
        process.stdout.close()
        process.wait(timeout=5)
elapsed = time.monotonic() - started
(evidence / "acp-diagnostic.log").write_bytes(output)
target_observed = b"ACP host-disabled new load and resume skip project MCP effects" in output
result = {"scope": "diagnostic-only-acp-suite", "sourceHead": (evidence / "source-head.txt").read_text().strip(),
          "command": command, "elapsedSeconds": elapsed, "returncode": process.returncode,
          "timedOut": timed_out, "targetObserved": target_observed}
(evidence / "acp-diagnostic.json").write_text(json.dumps(result, indent=2) + "\n")
sys.stdout.buffer.write(output)
sys.stdout.buffer.flush()
print(f"ACP_DIAGNOSTIC_FINISH elapsed_seconds={elapsed:.3f} returncode={process.returncode} timed_out={timed_out}", flush=True)
if process.returncode == 0 and not target_observed:
    raise SystemExit("Diagnostic returned success without observing the target test")
raise SystemExit(124 if timed_out else process.returncode)
