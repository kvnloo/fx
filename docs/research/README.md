# Cross-harness FX downstream research queue

Downstream-only tracker. Nothing here is approved for upstream promotion.

## P0 — reliability / correctness

- #3 bounded allocation ownership for long turns
- #4 credential lifetime + host-brokered secret custody
- #5 typed provider contract: routing, recovery, usage, response-head timeout
- #8 durable execution journal for uncertain-effect recovery

## P1 — leverage without growing core

- #6 Agent Plugins envelope over existing skills + MCP
- #9 revision-pinned evidence packet cache for low-token OSS work
- #10 AODL intent/authority envelope + verified outcome receipts
- #11 z0intelligence shadow decision bridge / local verified routing

## P2 — experimental adapters

- #7 bounded cross-harness session recall without a second memory database
- #12 libfx leaf-executor protocol for external RLM supervisors

## Existing experiment

- #1 frozen-judge autoresearch canary, corresponding to upstream vercel-labs/fx#411

## Source planes reviewed

- Hermes Agent: learning/session recall, recovery, provider breadth, subagents
- Oh My Pi: skills/memory/provider routing, interactive orchestration, leaf/runtime comparison
- DeepSeek Harness: append-only provenance plus inject/pre-step semantics
- AODL: typed intent, authority, topology, constraints, verified outcomes
- z0intelligence: evidence/state/authority separation, shadow routing, Jev/Laya verification
- z0evals: frozen exact-ref evaluation; runtime cannot grade itself
- Frontier KB: public research memory and provenance, never personal agentic memory
- Agent Orchestrator: durable worker/session/PR/CI state
- existing fx upstream work: allocation lifetime, plugins, provider/auth/recovery, local-model response-head timeout

## Promotion rule

Each draft must first produce a minimal deterministic experiment, explicit baseline, acceptance criteria, kill criteria, and current-main rebase.

Promote only the smallest independently useful slice. Keep orchestration, research memory, evaluation, routing authority, and recursive supervision outside fx core.


## Current-main implementation children — 2026-10-01

- #14 — bound subagent session-read scratch; current-main implementation of the useful #3 ownership slice.
- #15 — optional configured-provider response-head timeout; first concrete child of #5 / upstream #902.
- #16 — saturating Grok/ChatGPT auth expiry arithmetic; current-main port with upstream provenance.
- #17 — exact-capacity Grok/ChatGPT auth-session serialization; prevents abandoned plaintext token buffers.
- #8 was revised after the sessions-v2 audit: extend the existing durable log if needed; do not add a second journal.

### Superseded/stale ideas

- Old PR #3 auto-closed when its branch was rebased to current main; #14 is its implementation successor.
- The old refresh ownership fix from upstream #437 is not copied: current `refresh_replacement()` ownership makes its outer composite cleanup correct.
