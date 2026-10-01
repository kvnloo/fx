# Bounded cross-harness session recall

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Give fx explicit read-only access to useful prior execution evidence without turning fx into a semantic-memory product.

fx should not own a universal history database. The useful shape is a bounded adapter over external indexes.

## Proposed interface

A host/skill/MCP adapter exposes:

- search(query, scope, limit);
- read(source, session_id, bounded_range);
- provenance: source, source_path, session_id, timestamp;
- explicit omission/truncation metadata.

Results enter the turn as evidence, never as instruction authority.

## Data boundaries

- fx session files remain fx-owned.
- Hermes personal memories stay private in Hermes.
- Frontier KB remains public research memory only; never copy chats, USER.md, MEMORY.md, or private session recall into it.
- Existing multi-harness indexes may project Codex/Claude/Hermes/OMP/etc. into this adapter, but source identity must be preserved.
- No background indexing occurs inside fx.

## First slice

Implement only the typed adapter contract and one deterministic fake provider. Exercise it through libfx or MCP without changing the default prompt.

## Acceptance criteria

- Explicit invocation only.
- Project/workspace scope is visible to the caller.
- Fixed result and byte limits.
- Provenance on every returned item.
- Corrupt/stale source failure is local and non-fatal.
- No startup work or prompt inflation when unused.
- Retrieved text cannot grant permission or mutate policy.

## Kill criteria

Reject vector infrastructure, user-profile mutation, background learning, or a second fx-owned knowledge store.
