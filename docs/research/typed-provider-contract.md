# One typed provider contract for routing, recovery, and usage

Status: downstream research draft. Do not promote upstream as-is.

## Problem

fx now supports AI Gateway, subscription providers, and OpenAI-compatible connections. Provider-specific growth risks duplicating auth, catalog, retry, timeout, capability, usage, and tool-call state machines.

Issue #902 also exposes a concrete gap: response-head timeout policy is transport/provider sensitive, especially for cold local models.

## Proposed narrow waist

Define one host-owned typed provider contract with:

- provider identity and credential custody;
- model/capability metadata;
- request transport adapter;
- response-head and stream-idle timeout policy;
- retry classification;
- cancellation/uncertain-outcome semantics;
- usage accounting;
- explicit unsupported-capability errors.

Transport adapters remain different where protocols differ. Semantics above them should converge.

## Cross-harness lessons

OMP has broad provider routing and per-role models; Hermes supports many providers; z0intelligence separates capability eligibility from execution authority; Kerdoios owns quota/resource placement. fx should borrow the contracts, not their orchestration layers.

## First experiment

Implement no new provider. Instead, write a conformance fixture that can run existing Gateway, subscription, and OpenAI-compatible adapters through the same synthetic cases:

- cold response head;
- transient retry;
- malformed stream;
- cancellation before first byte;
- cancellation after acknowledged content;
- usage present/missing;
- unsupported tool/vision/reasoning capability.

## Acceptance criteria

- Same semantic result shape across provider adapters.
- Per-connection response-head timeout can vary without changing the default.
- Retry never duplicates an acknowledged mutation.
- Partial usage remains explicitly partial.
- Provider selection cannot mint permission/tool authority.
- No provider-specific branch is added to unrelated session/UI code.

## Kill criteria

Reject a "universal provider" abstraction that erases real protocol differences or grows fx into a quota/orchestration service.
