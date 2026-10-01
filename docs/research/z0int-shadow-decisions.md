# Shadow decision bridge for local verified routing

Status: downstream research draft. Do not promote upstream as-is.

## Goal

Measure whether cheap local decision models can predict useful fx control decisions without granting them runtime authority.

z0intelligence already separates evidence, state, authority, action, outcome, and learned procedure. Preserve that distinction.

## Shadow-only first slice

At named decision opportunities, fx emits a bounded provider-neutral snapshot to an optional host callback:

- decision type;
- eligible choices;
- relevant evidence references;
- risk/quality requirements;
- current measured provider/runtime state.

The callback returns a candidate choice plus provenance/confidence. fx records it, but production behavior remains unchanged.

Candidate backends may include Laya/Jev-style local verification paths or other registered models. Backend registration never grants filesystem/tool/credential authority.

## Evaluation

Record:

- agreement with production decision;
- downstream outcome;
- Brier/log-loss/calibration where meaningful;
- latency and token/compute cost;
- abstentions;
- regime changes.

Use z0evals/frozen exact-ref studies for promotion evidence. Promotion is external to fx.

## Acceptance criteria

- Shadow path is fail-open and optional.
- Snapshot contains no credentials/private tool payloads by default.
- Decision records are replayable and source-versioned.
- Abstention is first-class.
- No automatic routing until an external evidence gate explicitly enables a capability.
- Deoptimization path exists when evidence no longer holds.

## Kill criteria

Reject model confidence as permission, teacher agreement as truth, or any design where a local classifier can execute tools directly.
