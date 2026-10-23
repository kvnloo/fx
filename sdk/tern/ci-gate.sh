#!/usr/bin/env bash
# Runs one exact-source gate; the workflow supplies the resource/deadline scope.
set -euo pipefail
gate="${1:?gate required}"
expected="${2:?source commit required}"
evidence="${3:?evidence directory required}"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected an exact source commit' >&2; exit 2; }
[[ "$(git rev-parse --verify HEAD)" == "$expected" ]] || { echo 'Selected checkout does not match the requested commit' >&2; exit 1; }
[[ "$(zig version)" == '0.16.0' ]] || { echo 'Zig 0.16.0 is required' >&2; exit 1; }
mkdir -p "$evidence"
printf '%s\n' "$expected" > "$evidence/source-head.txt"
printf 'TERN_CI_GATE=%s SOURCE_HEAD=%s\n' "$gate" "$expected"
node --version
zig version
native_flags=(-Dtarget=x86_64-linux -Dcpu=baseline -Doptimize=ReleaseSafe -j1)
case "$gate" in
  base-root|head-root)
    if [[ "$gate" == head-root ]]; then
      zig fmt --check src/core/session/js_host_session_store.zig
    fi
    printf 'FULL_ZIG_ROOT_START flags=%s\n' "${native_flags[*]}"
    zig build test "${native_flags[@]}"
    printf 'FULL_ZIG_ROOT_PASS source=%s\n' "$expected"
    ;;
  head-runtime)
    npm ci --prefix sdk/tern --ignore-scripts --no-audit --no-fund
    node --check sdk/tern/native-smoke.mjs
    node sdk/tern/build-receipt.mjs --build -- "${native_flags[@]}"
    cp -p zig-out/bin/fx zig-out/bin/fx.build.json "$evidence/"
    FX_TERN_REAL_BINARY="$PWD/zig-out/bin/fx" node --test sdk/tern/test/*.test.mjs
    printf 'REAL_FX_RUNTIME_PASS source=%s\n' "$expected"
    ;;
  head-wasm)
    zig build fx-core-wasm -Dwasm-surface=core -j1
    node --input-type=module -e '
      import {readFileSync} from "node:fs";
      import assert from "node:assert/strict";
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync("zig-out/bin/fx-core.wasm")));
      for (const name of ["fx_session_load", "fx_session_commit", "fx_session_list", "fx_session_remove"]) {
        assert.ok(imports.some(entry => entry.module === "fx" && entry.name === name), name);
      }
      console.log("WASM_SESSION_IMPORTS_PASS", JSON.stringify(imports.filter(entry => entry.name.startsWith("fx_session_"))));
    '
    cp -p zig-out/bin/fx-core.wasm "$evidence/"
    node --experimental-wasm-jspi sdk/tests/test-core.mjs
    printf 'WASM_CORE_PASS source=%s\n' "$expected"
    ;;
  *) echo "Unknown certification gate: $gate" >&2; exit 2 ;;
esac
