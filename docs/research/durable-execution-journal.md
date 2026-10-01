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
