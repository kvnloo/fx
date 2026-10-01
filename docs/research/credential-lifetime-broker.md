# Bounded credential lifetime and host-brokered secret custody

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Make sensitive bytes have bounded lifetime, unique ownership, and explicit release/zeroization while preserving fx's permission-first, embeddable architecture.

## Inputs

Relevant upstream work includes the credential-lifetime issue/PR family and host authentication broker work such as #626. The broader z0/Hermes privilege-broker work adds one useful principle: permission to use a credential does not imply permission to read it.

## Proposed invariant

A provider/tool receives a scoped capability to perform an authenticated operation, not a durable plaintext credential, whenever the host can broker the operation.

For locally owned credentials:

- parse into bounded buffers;
- avoid plaintext growth via reallocating JSON;
- define exactly one owner across load/refresh/persist;
- zeroize before release where the platform permits;
- fail closed on corrupt/overflowing expiry metadata;
- never copy secret material into traces, session history, recovery checkpoints, or model-visible evidence.

## Embedding shape

libfx hosts may optionally provide a credential broker with:

- opaque credential reference;
- allowed provider/tool operation;
- expiry;
- cancellation identity;
- bounded result/error contract.

The CLI keeps its existing local credential path. No network broker becomes mandatory.

## Acceptance criteria

- Allocation-failure tests for every ownership transfer.
- No double-free or stale alias after refresh/persist failure.
- Corrupt expiry arithmetic fails safely.
- Host-brokered requests never materialize the secret in the fx sandbox.
- Cancellation cannot silently replay an uncertain authenticated mutation.
- Existing direct auth remains unchanged when no broker exists.

## Kill criteria

Reject any design that stores credential handles in project config, expands project authority, or makes a remote broker required for ordinary CLI use.


## 2026-10-01 current-main audit

The credential program now has concrete current-main evidence:

- **Expiry arithmetic still reproduces:** Grok and ChatGPT session refresh deadlines used unchecked subtraction on untrusted stored integers. Downstream #16 ports the bounded saturating fix from upstream #446/#756.
- **Persisted-session buffer growth still reproduces structurally:** both session serializers grew an allocating writer after access/refresh tokens were present. Downstream #17 ports the exact-capacity strategy from upstream #379.
- **Request-side secret buffers remain:** OAuth refresh/revoke and Grok/ChatGPT refresh/revoke paths still use growing allocating writers while holding credentials. This is the next independent slice.
- **Old refresh double-free #437 is no longer a current-main port candidate:** ownership moved into `refresh_replacement()`. Its local cleanup is disarmed on successful return; the returned replacement then owns access token, refresh token, and account id, so the outer `replacement.deinit()` is the correct save-failure cleanup. Do not apply the stale one-line patch blindly.
- Host-broker work such as upstream #626 remains architectural prior art, not a dependency for local CLI correctness.

### Implementation queue

1. #16 — corrupt expiry arithmetic.
2. #17 — exact-capacity persisted auth-session serialization.
3. Next — exact-capacity + explicit zeroization for secret-bearing request bodies.
4. Then reconsider a host-broker seam only if libfx/sandbox evidence requires it.
