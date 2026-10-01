# Minimal libfx leaf-executor protocol for recursive systems

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Use fx as a cheap, bounded worker inside RLM/recursive systems without implementing RLM inside fx.

The recursive supervisor should live in an independent executor/core. fx remains a leaf harness reachable through libfx or `fx ask --json`.

## Minimal protocol

Request:

- task;
- bounded context/evidence references;
- capability requirements;
- authority/budget limits;
- expected result schema.

Result:

- structured answer/artifacts;
- tool/effect receipts;
- usage and latency when measured;
- unresolved questions;
- bounded child references if subagents were used.

## Why this fits

fx is small, native, embeddable, model-agnostic, and already supports one-shot and libfx surfaces. Those properties are more valuable to a recursive supervisor than a second recursion implementation.

## Cross-harness relationship

OMP can keep richer interactive RLM/repl behavior. Hermes can keep orchestration/memory/gateway behavior. A generic RLM core can schedule leaves across FX/Hermes/OMP through the same narrow protocol.

## Experiments

Compare equivalent leaf tasks through:

1. direct libfx;
2. `fx ask --json --no-save`;
3. another harness adapter.

Measure cold start, context bytes, tool round-trips, completion quality, and cancellation semantics.

## Acceptance criteria

- No recursive supervisor state in fx.
- Request/result schema is provider-neutral.
- Cancellation is bounded and observable.
- Host can supply external state without prompt inflation when unused.
- Leaf failures are explicit and retry-safe.
- Existing interactive fx behavior is unchanged.

## Kill criteria

Reject persistent Python/JS REPL ownership, recursive scheduling, or global memory inside fx core.
