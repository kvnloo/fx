# FX × Tern frontend (experimental)

The optional Node 22+ Tern frontend lets [FX](https://github.com/vercel-labs/fx) speak the [Tern Surface Protocol](https://docs.stencil.so/tern/protocol/) without altering the Zig terminal UI or implementing another agent runtime. The existing `fx acp` subprocess owns sessions, model requests, tool execution, permission checks, credentials, and persistence. The adapter owns only display and user input.

## Run

Build FX with the normal Zig build, then install the [official SDK](https://github.com/stencil-hq/tern-sdk) and start in Tern:

```sh
zig build
cd sdk/tern
npm install
node cli.mjs --fx ../../zig-out/bin/fx
# Existing session: node cli.mjs --fx ../../zig-out/bin/fx --resume SESSION_ID
```

Launch the command inside a Tern pane. Tern negotiates native `main` transcript and `dock` composer rendering. The SDK handles protocol handshake, ACK/credits, frame diffing, coalescing, UTF-8, and terminal teardown. A normal terminal, `TERN_TSP=0`, or a failed negotiation uses a readable line-oriented interface instead. In fallback, write a message and press Enter; `/cancel` interrupts an active FX prompt and `/quit` exits. The host does **not** need to install Node or this package to use the regular Zig binary.

Tern edit, undo, and send events update a bounded local draft; only the verified atomic send invokes `session/prompt`. FX ACP streams agent messages and tool status into stable keyed cards. When FX asks for permission, Tern presents the **actual** ACP options and command arguments; choose the numbered option (or use its button). Escape rejects the pending tool if FX provides `reject_once`, otherwise Escape cancels the active turn or exits idle. No key or Tern action is allowed to execute a tool directly.

## Verify

```sh
cd sdk/tern
npm test
TERN_TSP=0 node cli.mjs --fx ../../zig-out/bin/fx
# For Tern dogfood, run inside a Tern pane with:
TERN_TSP_RECORD=/tmp/fx-tern-tsp.jsonl node cli.mjs --fx ../../zig-out/bin/fx
```

The Node tests exercise ACP startup and resume against a local fake subprocess, streamed output, explicit allow/reject permissions, UTF-16 edits and stale send rejection, Ctrl+C cancellation, and the actual CLI plaintext fallback. They do **not** prove the unmocked real FX binary, real Tern renderer, or Linux/macOS build. Run these separately before promotion and attach sanitized TSP recording and screenshots to the draft PR. Do not commit credentials or raw private transcripts.

## Boundaries and limits

- Native Tern support is **opt-in**. There is no new Zig dependency, TUI replacement, separate session store, or competing ACP server.
- FX session titles and usage counters are display-only. Tool/permission outcomes come back from FX, not optimistic UI state.
- ACP messages are capped at 2 MiB per line; visible text and drafts are bounded. Terminal-control bytes from agent output are replaced before reaching a native Tern node or plain terminal.
- The frontend displays agent messages and tool status. Full parity with FX's Zig panels (file-approval diff, image attachments, session selection, complex MCP elicitation, and deep transcript navigation) is not claimed. Unsupported ACP client methods reject safely.
- On exit, pending tool approval is rejected when FX provides the rejection option, and the child process, Tern surface, and TTY are closed. Ordinary FX remains fully usable without Tern.

## References and credit

Based on [FX ACP](../../src/acp/server.zig), the [Tern TypeScript SDK](https://github.com/stencil-hq/tern-sdk/tree/main/typescript), and prior downstream exploration in [Hermes/Tern](https://github.com/kvnloo/hermes-tern), [Omnara](https://github.com/kvnloo/omnara/issues/12), [DeepSeek Harness](https://github.com/kvnloo/deepseek-harness/issues/6), and [God's Eye View](https://github.com/kvnloo/gods-eye-view/issues/251). Tern is by Can Bölük and Stencil Labs; FX's original design and ACP implementation belong to the FX contributors.
