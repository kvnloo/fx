<!-- oss-factory:v1
{"id":"20261017-fx-canonical-queue","kind":"state","project":"fx","from":"chatgpt","to":["factory","lane5"],"status":"working","dedupe_key":"promotion-queue:vercel-labs/fx","origin_url":"https://github.com/vercel-labs/fx","civ":{"city_id":"oss:fx"}}
-->

# FX — canonical downstream promotion queue

**Origin:** [vercel-labs/fx](https://github.com/vercel-labs/fx) · **Implementation fork:** [kvnloo/fx](https://github.com/kvnloo/fx) · **Audit:** 2026-10-17 UTC

This is the single project-local promotion queue. It is **not an FX product change** and must not be submitted upstream. The previous [factory-local #146](https://github.com/kvnloo/oss-factory/issues/146) is a preserved historical source, not an active queue. Factory [#14](https://github.com/kvnloo/oss-factory/issues/14) is only the cross-repository directory. The [FX registration in factory PR #109](https://github.com/kvnloo/oss-factory/pull/109) remains unmerged.

## Ready for human upstream review

**None verified.** The user requested an FX promotion wave on October 16, 2026 (America/Chicago). This authorizes pursuing **eligible, nonduplicate FX contributions**; it does not waive signatures, tested behavior, current reviews, or upstream policy. This file and a green local fixture are not permission to merge an upstream default branch.

## Existing upstream review

- [vercel-labs/fx #1032](https://github.com/vercel-labs/fx/pull/1032) is **acking-you**'s still-open original subagent-memory fix. Preserve ownership; do not compete with it. Our [fork #14](https://github.com/kvnloo/fx/pull/14) is closed unmerged.
- [vercel-labs/fx #1316](https://github.com/vercel-labs/fx/pull/1316) already covers cross-tenant World delivery, implemented by **fazxes** with original contribution credit to **DarlingtonDeveloper** [#1191](https://github.com/vercel-labs/fx/pull/1191). Do not duplicate.

## Needs proof, sorted by promotion opportunity

| Candidate | Exact source or fork PR | Requirement/credit | Current gate |
| --- | --- | --- | --- |
| Multiline native libfx host-tool JSON framing | [original fork #21](https://github.com/kvnloo/fx/pull/21), new tests at `2e120a165d8fc3858bf86db06b960111254e25cd`; [**signed, current-main staging head**](https://github.com/kvnloo/fx/commit/6182da419b87b91a6c6299fe6a18a29f7699487e) `6182da419b87b91a6c6299fe6a18a29f7699487e` | Reproducible real native process crash [origin #1215](https://github.com/vercel-labs/fx/issues/1215), diagnosed by **jagenaujagenau**. **donavonguyot** independently tested and supplied the [allocation-error correction and regression](https://github.com/kvnloo/fx/pull/21#issuecomment-6227507070), now integrated. | **LIMITED / ORIGIN DRAFT BLOCKED 403**: clean single-commit backport to origin `d21c4a1c` is GitHub-verified signed; the upstream draft request was denied `403 Resource not accessible by integration`. Exact signed-head required CI, fresh-built `./zig-out/bin/fx` native path, Node 24 SDK and startup checks remain unverified here. Donavonguyot reported local Zig/Node/native/Wasm and synthetic-provider testing of the correction; not exact-head hosted CI. |
| Workflow World restart queue namespace | [fork #22](https://github.com/kvnloo/fx/pull/22), head `4677e44408a6eaeaa10888f9399a6a9ebd5d0850` | Real restart failure and proposed namespace fix [origin #1253](https://github.com/vercel-labs/fx/issues/1253) by **pranaygp**; depends on work in [vercel/workflow #4835](https://github.com/vercel/workflow/pull/4835). | **HOLD**: real world-local or world-postgres shared-store restart not executed; Node 24 and exact-head hosted CI not run; unsigned. Only creation namespace covered, not unfinished-turn replay. |
| Corrupt extreme auth expiration | [fork #16](https://github.com/kvnloo/fx/pull/16), `1fc89ca43bd0c6c2c36918bdcbecd92661466ef0` | Prior upstream work [#446](https://github.com/vercel-labs/fx/issues/446), [#756](https://github.com/vercel-labs/fx/issues/756); credit **beardthelion** and **adi-IL**. | **HOLD**: exact-head CI, Zig and binary acceptance; unsigned. |
| Auth credential JSON sizing | [fork #17](https://github.com/kvnloo/fx/pull/17), `e2eb2c5c0ea5f4e138b8c6e90f18e6a2495702d6` | Prior [#379](https://github.com/vercel-labs/fx/issues/379), credit **beardthelion**. | **HOLD**: native zeroization/error-path review, exact-head CI, signed commits. |
| Provider response-head timeout | [fork #15](https://github.com/kvnloo/fx/pull/15), `4a77bc334e8e40b19dafd898d4ec7c66f1bb605e` | Related [origin #902](https://github.com/vercel-labs/fx/issues/902). | **CHECK**: confirm supported demand and semantics; native and startup regressions. |
| Agent Plugins v1 inspect | [fork #19](https://github.com/kvnloo/fx/pull/19), `c82e6ba046f9fe8e17ad345f75733c67193e7b10` | Related [origin #390](https://github.com/vercel-labs/fx/issues/390). | **CHECK**: confirm maintainer direction, native validation and signatures. |

## Held, superseded, research-only

- [Fork #14](https://github.com/kvnloo/fx/pull/14) **CLOSED / OWNER_COVERED** by acking-you's original upstream #1032; its same-head fork CI passes are not authority for a duplicate origin PR.
- [Fork #18](https://github.com/kvnloo/fx/pull/18) **CLOSED / HOLD**; security path needs current-head review. Credit **beardthelion**, [origin #364](https://github.com/vercel-labs/fx/issues/364).
- [Fork #20](https://github.com/kvnloo/fx/pull/20) **CLOSED / SUPERSEDED** by #21.
- [Research index #13](https://github.com/kvnloo/fx/pull/13) and linked RFCs #1–#12 are not implementation promotions.

## Next executable action

1. For **#21**, a current-origin-base signed one-commit branch is prepared: `kvnloo:lane5/fx-1215-current-main-base-20261017` @ `6182da419b87b91a6c6299fe6a18a29f7699487e`. An authorized GitHub CLI session must open one **draft** PR against `vercel-labs/fx:main` (connected GitHub integration returned HTTP 403), with credit to jagenaujagenau and donavonguyot. Follow its exact-head CI; separately run Zig 0.17 build/tests, Node 24 native/Wasm host-tool integration, and freshly built binary/startup checks. Do not mark ready until these pass.
2. Run a real shared-store restart for **#22**, then follow the same exact-head checks. Do not conflate it with newer recovery PRs.
3. Sweep reviews, newer origin changes and signatures before any other candidate.

**Origin write attempt (2026-10-17 UTC):** `create_pull_request` on `vercel-labs/fx` with signed `kvnloo:lane5/fx-1215-current-main-base-20261017` returned HTTP 403 `Resource not accessible by integration`. The fork has push access; the GitHub integration has origin `pull` permission but not origin PR-write permission. **No origin PR URL exists from this attempt.** The staging [fork PR #25](https://github.com/kvnloo/fx/pull/25) was merged by GitHub to a **temporary non-default branch** to generate the verified signed commit. No factory or FX default branch was merged.

This queue tracks **READY**, **AUTHORIZED** and **PUBLISHED** separately. A publication is only a verified origin URL; a landing is only a verified merge commit. No origin write or merge is claimed in this snapshot.

Contributor diagnoses, branch history and previous evidence remain linked above and in the legacy issue.