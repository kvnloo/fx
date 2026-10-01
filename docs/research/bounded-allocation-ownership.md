# Bounded allocation ownership for long agent turns

Status: downstream research draft. Do not promote upstream as-is.

## Problem

Long parent/child tool loops can retain scratch allocations for the lifetime of a turn. Upstream reports #483, #686, and #1031 show that retained execution state can be tiny while process memory reaches GiB-scale or worse.

The useful abstraction is not "add a memory limit." It is an ownership map.

## Proposed contract

Every allocation belongs to exactly one lifetime class:

1. persistent session/transcript state;
2. current turn state;
3. current provider attempt;
4. current tool invocation;
5. recovery/checkpoint serialization scratch;
6. child-session read scratch.

Shorter-lived classes must never allocate from a longer-lived arena unless the surviving bytes are copied out into an explicitly owned destination.

## Experiment

Build one deterministic long-turn fixture with a parent, one persistent child, repeated tool output, retries, and checkpoint writes. Measure:

- peak RSS;
- retained transcript bytes;
- checkpoint bytes;
- allocations by lifetime class;
- cancellation and failure paths.

Use the same fixture for every candidate patch. Keep behavior and output invariant.

## Cross-harness lessons

Hermes and OMP both benefit from explicit phase boundaries and child-session ownership. z0intelligence treats runtime state as evidence with explicit provenance rather than one undifferentiated memory plane. Apply the same discipline here without importing their runtimes.

## Acceptance criteria

- One documented ownership map for all six lifetime classes.
- Repeated tool calls release invocation scratch before the next step.
- Checkpoint reconstruction uses disposable scratch.
- Child status/result reads retain only returned fields.
- Cancellation and retry paths do not leak ownership.
- Deterministic fixture completes at bounded RSS.
- No binary/startup regression outside the existing fx gates.

## Kill criteria

Reject any design that requires a second agent runtime, background GC subsystem, or hidden global state.
