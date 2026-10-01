# Durable execution journal for uncertain-effect recovery

Status: downstream research draft. Do not promote upstream as-is.

## Problem

A crash or cancellation around an external mutation creates an epistemic problem: fx may know what it intended to do without knowing whether the effect happened.

A second persistence system would make this worse unless authority is explicit.

## Proposed seam

Define a minimal append-only execution journal for effectful operations:

1. intent admitted;
2. execution started;
3. external acknowledgement observed;
4. result recorded;
5. verification recorded.

Each record carries session id, action id, attempt id, authority snapshot id, and a stable effect identity when available.

The journal does not replace the transcript. It records only execution facts needed to avoid unsafe replay.

## Cross-harness lessons

DeepSeek Harness' append-only log and inject/pre-step seam show the value of durable provenance without forcing a new turn. Hermes recovery work shows that orchestration state should survive process boundaries. z0intelligence's dispatch authority adds the critical rule: uncertain prior execution must not be silently executed twice.

## Recovery rule

If a prior effect is uncertain, recovery returns an explicit uncertain state and requires verification/reconciliation before retry.

## Acceptance criteria

- One authoritative record named for each lifecycle phase.
- Crash injection at every transition.
- Acknowledged mutations are never replayed automatically.
- Uncertain effects remain uncertain until independently reconciled.
- Journal/session disagreement is detected, not silently merged.
- Storage and fsync cost are bounded and measured.
- Embedders may own persistence through libfx.

## Kill criteria

Reject a journal that becomes a second transcript, stores full model/tool payloads by default, or introduces a background scheduler.


## 2026-10-01 current-main audit

Current `main` already changed the design space substantially through sessions-v2:

- `Session.appendProgress()` persists each not-yet-finished call as a durable `tool_running` item before execution proceeds.
- Crash/close replay converts an unanswered running call into an interrupted tool result that explicitly says the tool may have partly run and its effects must be checked before retry.
- The session-manager log already has durable append/recovery semantics and outcome states including interrupted/lost.
- Regression coverage already exercises a crash with multiple running calls and verifies only unanswered calls are synthesized as uncertain.

Therefore the original proposal for a separate execution journal fails its own "single authority" criterion. Do **not** add another log beside sessions-v2.

### Revised smallest seam

Build on the existing session-v2 event log. Only add data that it cannot currently express when a real use case proves the need, for example:

- stable external effect identity / idempotency key when a tool or host exposes one;
- explicit acknowledgement/delivery certainty on a completed effect;
- reconciliation receipt that closes a previously uncertain effect.

These belong as versioned session events or result metadata, not a second database.

### Revised next experiment

Use crash injection around one deterministic effectful fixture and prove:

1. admitted-but-not-started work is safe to retry;
2. started-but-unacknowledged work restores as uncertain;
3. acknowledged work is not replayed;
4. a reconciliation receipt can close the uncertainty without re-executing the effect.

If existing sessions-v2 semantics already satisfy a case, add no code.

### Updated kill criterion

Any implementation that introduces a second execution ledger, journal directory, or competing replay authority is rejected.
