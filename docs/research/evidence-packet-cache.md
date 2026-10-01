# Revision-pinned evidence packets for low-token OSS work

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Let repeated fx workers reuse trustworthy repository evidence without repeatedly rereading the same files, PRs, CI state, and test output.

This is an external cache contract, not a new fx memory system.

## Evidence packet

A packet is immutable and content-addressed. It contains:

- repository identity and exact revision;
- selected file/blob hashes and bounded excerpts;
- issue/PR identifiers and observed state;
- deterministic test/benchmark receipts;
- provenance and collection time;
- freshness/invalidating refs;
- explicit omissions.

No packet contains credentials, personal memory, or hidden permission grants.

## Frontier KB relationship

Frontier KB remains the public research/claims plane. It may store sanitized reusable conclusions or references to public evidence. Raw private workspace packets remain local or host-owned.

## fx integration

Preferred order:

1. external skill/MCP or libfx host supplies a packet;
2. fx reads it as bounded evidence;
3. live verification is required when the packet's invalidating refs moved;
4. permission/authority is evaluated independently.

## Tokenomics hypothesis

Repeated OSS triage should reduce model-visible bytes and network/API calls while preserving exact-ref verification. Measure avoided bytes/tokens separately from estimated savings.

## Acceptance criteria

- Content-addressed packet format with exact revision identity.
- Fresh/stale decision is deterministic.
- Bounded excerpts and explicit omission counts.
- Verification receipts distinguish measured from inferred.
- No packet can authorize a tool action.
- Cache miss/failure falls back to ordinary fx behavior.

## Kill criteria

Reject hidden prompt injection, mutable cache entries without version identity, or a centralized service required for normal fx use.
