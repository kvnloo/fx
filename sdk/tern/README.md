# FX × Tern frontend (experimental)

The optional Node 22+ Tern frontend lets [FX](https://github.com/vercel-labs/fx) speak the [Tern Surface Protocol](https://docs.stencil.so/tern/protocol/) without altering the Zig terminal UI or implementing another agent runtime. The existing `fx acp` subprocess owns sessions, model requests, tool execution, permission checks, credentials, and persistence. The adapter owns only display and user input.

## Run

Build FX with the normal Zig build, then install the [official SDK](https://github.com/stencil-hq/tern-sdk) and start in Tern:

```sh
zig build
cd sdk/tern
npm ci
node cli.mjs --fx ../../zig-out/bin/fx
# Existing session: node cli.mjs --fx ../../zig-out/bin/fx --resume SESSION_ID
```

Launch the command inside a Tern pane. Tern negotiates native `main` transcript and `dock` composer rendering. The SDK handles negotiation, frame diffing, coalescing, and UTF-8. The frontend owns shutdown and TTY restoration. It retires unsent work before close because SDK 0.1.0 otherwise flushes pending frames beyond its credits. A normal terminal, `TERN_TSP=0`, or unsupported negotiation uses a line-oriented interface. Each fallback line is one prompt, not a multiline draft. `/cancel` interrupts a prompt and `/quit` exits. The regular Zig binary does not require Node or this package.

Tern edit, undo, and send events update a bounded local draft; only the verified atomic send invokes `session/prompt`. FX ACP streams agent messages and tool status into stable keyed cards. When FX asks for permission, Tern presents the **actual** ACP options and command arguments; choose the numbered option (or use its button). Escape rejects the pending tool if FX provides `reject_once`, otherwise Escape cancels the active turn or exits idle. No key or Tern action is allowed to execute a tool directly.

## Verify

Run builds and tests on your development build host. The real-runtime gates require the current checkout's built binary:

```sh
npm ci --prefix sdk/tern --ignore-scripts
node sdk/tern/build-receipt.mjs --build -- -Doptimize=ReleaseSafe
zig build test -Doptimize=ReleaseSafe
FX_TERN_REAL_BINARY="$PWD/zig-out/bin/fx" npm test --prefix sdk/tern
```

The tests cover mock transport regressions and the real built FX subprocess. The real gate uses an isolated profile and a synthetic loopback provider. It checks multiline Unicode at the HTTP boundary, real file writes behind allow/reject decisions, persistence, and new-process resume. Missing `FX_TERN_REAL_BINARY` fails the gate. The ordinary-terminal CLI gate uses a Python OS PTY and supported single-line Unicode input. Synthetic replies do not constitute live-provider evidence.

The enforced builder removes the old binary and receipt, runs Zig, and writes a version-2 receipt only after a successful build with unchanged exact source. Acceptance checks the native binary SHA-256, source head, and full source-content identity. Git builds reject dirty tracked files or an index that differs from HEAD. Archives must supply `FX_TERN_EXPECTED_HEAD` and `FX_TERN_SOURCE_MANIFEST` for both build and acceptance. The source manifest is `{sourceHead, files: {relativePath: {sha256, symlink}}}`; `sha256` covers file bytes or the UTF-8 symlink target. Every source file must be listed, excluding generated Zig outputs/caches and `node_modules`. Keep runner scripts outside the archive source tree. The receipt is a trusted build record, not a cryptographic compiler attestation.

The native Zig suite also executes the existing JS session-host fixture. Native fixture symbols use ordinary C linkage. WebAssembly builds retain the `fx` import module. A binding correction keeps that fixture executable without adding a native `libfx` dependency or replacing its assertions.

When a local build host cannot admit the gate, the registered `CI` workflow has an opt-in `tern_certify` mode. Set `FEATURE_BRANCH` to the published feature branch and `BASE_COMMIT` to its exact untouched merge-base SHA, then dispatch:

```sh
gh workflow run ci.yml --repo kvnloo/fx --ref "$FEATURE_BRANCH" \
  -f tern_certify=true -f tern_base_sha="$BASE_COMMIT"
```

This mode runs only four independent certification phases: base/root, head/root, head/real-runtime, and head/WASM. Both source checkouts retain full Git metadata (`fetch-depth: 0`), so ignore-sensitive fixtures keep their repository context. Each phase uses Zig 0.16.0, a 6 GiB / 2 CPU systemd scope, a 1800-second remote deadline, and `-j1`. The paired native root flags are `-Dtarget=x86_64-linux -Dcpu=baseline -Doptimize=ReleaseSafe -j1`. Evidence artifacts retain source SHA, output, actual resource counters, and the runtime binary/receipt for native Tern proof. A failed base gate does not cancel the other phases and is not a waiver. Ordinary CI is unchanged unless this explicit mode is selected.

For the separately authorized linkage comparison, add `-f tern_normalized_control=true`. This replaces only the base phase with `base-normalized-root`: it applies the native session-host linkage file from commit `12926a9f8fad012c8259c80b0473d82b6a27d115`, verifies that no other tracked file changed, and retains the exact patch/hash/provenance. It is a labelled modified-base control, never evidence that the untouched base passed.

If the full head gate reports the host-disabled ACP regression, retain its failure and run an additional bounded ACP diagnostic. The diagnostic replays the recorded compiler/module graph with ACP-only selection, direct runner output, and error traces, recording elapsed time and whether the target test actually appeared. Its different diagnostic flags and result do not replace or waive the full exact-head gate.

For actual native Tern evidence, create an owned idle Tern shell on an isolated Sway display and select a new session named `TRN1-FX-...`. Do not use an operator's existing window, session, or default control socket. Then run:

```sh
TERN_NATIVE_CONTROL=/absolute/owned/control.sock \
TERN_NATIVE_SESSION=TRN1-FX-example \
TERN_NATIVE_RECEIPT=/absolute/owned/new-evidence-directory \
TERN_NATIVE_OWNED_SWAY=1 \
FX_TERN_REAL_BINARY="$PWD/zig-out/bin/fx" \
node sdk/tern/native-smoke.mjs
```

The Linux driver refuses an existing evidence directory and checks that its control endpoint still selects the named owned session. It launches the real CLI/FX subprocess directly in Tern's PTY, without a nested PTY relay, and uses a synthetic provider. It requires each expected reply in the native transcript, every exact rendered/atomic send and HTTP user message, approval buttons and file effects, resize, cancellation, following-shell execution, and cooked TTY state. Screenshots use Tern's output directory unless `TERN_NATIVE_DISPLAY_WRAPPER` names an approved absolute helper accepting `screenshot PATH`. Inspect screenshots and retained JSON before acceptance. `wire.jsonl` records SDK traffic and the actually emitted direct close packet; `pty-output.log` independently captures the producer bytes. The ledger requires strict frame ordering, genuine cumulative ACKs within credit, acknowledged final close, and exact raw-output reconciliation. `app-exit.json` checks raw-mode restoration without an intervening relay. `app-fx-exit.json` must show a normal FX exit and clean stderr. A passing result is written only after teardown and evidence persistence succeed.

For a daemon-backed detach/reattach check, additionally set `TERN_NATIVE_REATTACH=1`. At `NATIVE_REATTACH_READY`, detach only the owned window. Wait for `detached.json`, which records the driver's observed control disconnect. Reattach the same owned session at the same control endpoint. Never stop a shared daemon or select another user's session. Write a JSON object containing the exact `runId` from `reattach-ready.json` to the new `reattached` file. The driver checks the fresh acknowledgement, unsent draft, and unchanged provider request count. Without this option, the result explicitly records that detach/reattach was not exercised.

The RFC and Draft PR distinguish automated tests, actual Tern evidence, and repository promotion gates. Do not commit credentials or private transcripts. Native receipt files contain only owned fixture data.

## Boundaries and limits

- Native Tern support is **opt-in**. There is no new Zig dependency, TUI replacement, separate session store, or competing ACP server.
- FX session titles and usage counters are display-only. Tool/permission outcomes come back from FX, not optimistic UI state.
- ACP messages are capped at 2 MiB per line; visible text and drafts are bounded. Terminal-control bytes from agent output are replaced before reaching a native Tern node or plain terminal.
- The frontend displays agent messages and tool status. Full parity with FX's Zig panels (file-approval diff, image attachments, session selection, complex MCP elicitation, and deep transcript navigation) is not claimed. Unsupported ACP client methods reject safely.
- On exit, pending tool approval is rejected when FX provides the rejection option, and the child process, Tern surface, and TTY are closed. Ordinary FX remains fully usable without Tern.

## References and credit

Based on [FX ACP](../../src/acp/server.zig), the [Tern TypeScript SDK](https://github.com/stencil-hq/tern-sdk/tree/main/typescript), and prior downstream exploration in [Hermes/Tern](https://github.com/kvnloo/hermes-tern), [Omnara](https://github.com/kvnloo/omnara/issues/12), [DeepSeek Harness](https://github.com/kvnloo/deepseek-harness/issues/6), and [God's Eye View](https://github.com/kvnloo/gods-eye-view/issues/251). Tern is by Can Bölük and Stencil Labs; FX's original design and ACP implementation belong to the FX contributors.
