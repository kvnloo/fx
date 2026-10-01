# AODL intent authority and verified outcome receipts at the libfx boundary

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Make fx easier to embed in larger orchestration systems without making fx itself the orchestrator.

AODL owns portable intent, constraints, topology, authority, and budgets. fx owns execution. The boundary should preserve that separation.

## Proposed request envelope

An embedder may provide a typed execution envelope containing:

- intent id;
- bounded task payload;
- workspace/resource references;
- authority snapshot reference;
- budget/step limits;
- evidence references;
- expected outcome/postcondition identifiers.

fx treats the envelope as host input. It does not invent new authority from model output.

## Proposed receipt

libfx returns an execution receipt with:

- request/intent id;
- action/effect identifiers;
- observed outcome;
- verification status;
- usage/latency when measured;
- artifact/evidence references;
- uncertainty and omissions.

The receipt is descriptive evidence, not a claim that the desired outcome is true.

## Cross-system fit

z0intelligence can consume receipts as observed state. z0evals can grade frozen cohorts. Evolution Lab can search over strategies. verified-oss-loop can attach claims/evidence. None of those roles move into fx core.

## Acceptance criteria

- Envelope and receipt are versioned typed contracts.
- Omitted authority remains omitted; no defaults widen it.
- Permission checks stay inside fx's existing permission boundary.
- Verification is independent from execution where possible.
- Text/JSON surfaces agree.
- No startup cost when the host envelope is unused.

## Kill criteria

Reject new AODL node kinds in fx, autonomous settlement/payment, or a second orchestration graph inside the agent.
