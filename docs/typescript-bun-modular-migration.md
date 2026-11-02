# TypeScript + Bun + Get Modular migration

Status: **draft, implementation in progress**. This document is a migration
contract, not a claim that the Chrome extension has been ported or tested.

## Scope and authorities

- **Functional parity first**: preserve the current 1.6.1 runtime behavior,
  persistent state keys, payloads, in-flight operations, timing and Chrome
  permissions. Queue/goal mode remains future work.
- Apply [Agent Teams Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md)
  and [Engineering Foundation](https://github.com/agent-teams-ai/engineering-foundation).
  Foundation is **development-only**; never bundle it into the extension.
- Adopt public, exact-version [Get Modular](https://github.com/agent-teams-ai/get-modular)
  packages via their supported exports, not copied internals or a generic
  service locator. Treat its pre-1.0 APIs as version-pinned.
- Use **TypeScript >=7.0.2**, strict compiler project for all maintained
  application, build, tool and test source. No `@ts-nocheck`, unchecked
  `any`, suppressed type errors, or tests excluded from typecheck. Prefer
  regular `.ts` and package `"type": "module"`.
- Use **Bun** as package manager, build and test runner. Chrome executes
  browser-compatible generated JavaScript, never Bun APIs.
- Avoid feature flags, speculative abstraction layers, behavior redesign,
  broad permission changes, and generated files in Git.
- Leave existing upstream authorship/license intact.

## Current baseline (main: 47e3c9a)

- 20 hand-written extension JavaScript files (~236 KB), 29 TypeScript
  `.mts` test scripts (~286 KB), 3 TS tooling scripts (~27 KB).
- `extension/` currently contains both runtime JS and static assets.
  Chrome MV3 loads classic content scripts, a classic service worker with
  ordered `importScripts`, popup/offscreen/journal HTML scripts and
  explicitly injected page probes. Do not silently swap classic-script
  semantics, global access, MAIN/ISOLATED worlds or load order.
- Current validation: `npm run check` executes extension syntax/manifest
  checks, TS check, synthetic DOM/Chrome API tests (no real browser).
- Existing open PR #3 targets a separate legacy handoff bug. Do not
  overwrite or implicitly absorb it.

## Architecture and bounded contexts

Browser host (service worker and isolated content root) owns Chrome APIs,
permissions, persistent receipts and physical lifetime. It delegates through
narrow typed ports to these feature boundaries:

1. **Completion detection**: read-only page probing, response pairing and
   stop/error classification; DOM selectors remain adapter-only.
2. **Delivery & retry authority**: durable intent before action, exactly
   one authorized click per intent, unknown-outcome terminal guard, draft
   safeguarding, bounded retry and handoff transitions.
3. **Handoff**: chronology, title lineage, exact chat URL/ID tracking,
   transfer attachments and post-handoff recovery.
4. **Status & notifications**: per-chat state machine, receipts, visible
   indicators, sound and Chrome notification adapters.
5. **Journal & recovery**: one writer, append-only log, coherent migrations
   and recovery state; the journal is not disposable cache.

Apply Clean Architecture and dependency inversion at the effect boundaries.
Do not move pure DTOs, UI selectors or every function into separately
assembled modules just to maximize module count.

### Get Modular role mapping

| Capability | Use |
| --- | --- |
| `@get-modular/core` | Validate explicit static host composition and produce deterministic plan/digest |
| `@get-modular/assembly` | Construct typed feature capabilities from that plan; no `resolve(string)` service bag |
| `@get-modular/resources` | Per-active-content-context cooperative disposal of owned observers, timers and listeners |
| `@get-modular/observation` | Single-writer status facts, read-only subscribers, resource-owned watches; Chrome storage remains durable authority |
| `@get-modular/conformance` | Development-only factory and root smoke/contract tests plus failing-injection tests |
| `@get-modular/lifecycle-kernel` | **Do not ship automatically**. It is an unreleased candidate in the upstream main branch. Only adopt after public version, browser support, product custody necessity and explicit qualification. |

Composition must not trigger Chrome IO or timers before the Host
authorizes execution. The compiler is not an activation manager, durable
event bus, or duplicate-send prevention mechanism. Test the actual pinned
browser bundle with synthetic host ports, not just isolated library examples.

## Migration sequence (one draft PR)

1. Freeze characterization tests for public behavior, manifest entries,
   global/script order and persistent schema. Record a migration snapshot.
2. Introduce Bun/TypeScript build without changing emitted classic-script
   entry points. Verify all resources are present, scripts parse and browser
   bundles contain no Bun/Node runtime imports or source maps with user data.
3. Port the smallest pure feature boundaries to strict TS. Replace
   implicit globals with explicit typed contracts without altering
   externally observable behavior. Preserve safe serialization of MAIN
   world functions and extensions' reload compatibility.
4. Introduce static Get Modular composition, scope cleanup and observation
   at actual ownership boundaries; conformance tests reject incorrect
   bindings, missing capabilities, incomplete close or failed construction.
5. Port the remaining host, content, popup, offscreen, journal and test
   tooling to TS. Retain all existing tests, rename `.mts` -> `.ts`
   and include both runtime and tests in the strict compiler gate.
6. Adopt Foundation by an exact dev-only package pin, consumer-owned
   configuration and explicitly executed CI checks. No fabricated
   qualification claim. Generate and commit a frozen Bun lockfile.
7. Make nonbrowser checks green on the final PR head; independent review
   in repeated rounds with changes and rechecks. Only then ask the owner
   to test the unpacked build in a **designated test chat**, never in live
   work chats. Merge after owner validation and final checks.

## Nonbrowser acceptance matrix

- Source and test/tools typecheck (`strict: true`) with TS >=7.0.2.
- Build emits all manifest and HTML-referenced resources, stable paths and
  expected classic / isolated / MAIN world format.
- Bundle installs with no Node/Bun globals and no extra Chrome permissions.
- Existing 29 test programs and memory test suites execute unchanged in
  meaning; no test removed, skipped or turned nonblocking.
- Synthetic extension reload, suspended worker, multi-tab same chat, racing
  storage writes, request sent but acknowledgement unknown, duplicate clicks,
  exact draft whitespace/attachment preservation, chat-limit handoff, status
  notification migration and ownership cleanup.
- Foundation check, `assert-dev-only`, `assert-registry` and
  adopted capabilities run as required gates; compile/assembly conformance
  and negative tests cover product wiring.
- Inspect emitted bytes for stale `importScripts` references, all required
  script entry points and absence of unbundled `@get-modular/*` imports.
- Document any gap rather than claiming synthetic checks prove real Chrome E2E.

## CI cost and merge discipline

- During a **Draft PR**, avoid full CI. Preserve the complete required CI
  when marked ready and on every subsequent update to that ready head.
  Run targeted nonbrowser tests locally or manually during drafting.
- Limit pushes to `main` rather than every feature branch; one PR
  workflow with concurrency cancellation of obsolete attempts.
- Final ready PR must run all required checks on its current head. Draft
  skip is never a passing qualification or a merge bypass.
- Require independent critical review (safety, architecture, TS, Chrome
  permissions/manifest and recovery) and fix all blocking findings;
  record head SHA and reviewer verdict before merge.
- No merge solely because CI is green: owner performs Chrome smoke checks.

## Estimate

Approximate engineering effort for a fully typed, feature-preserving rewrite:
35–70 hours, including setup and migration, existing-test adaptation,
architecture conformance, offline/nonbrowser verification and review.
Browser testing and Chrome/ChatGPT UI drift can expand this range.

## Draft implementation checkpoint, 2026-11-02

**Not qualified or mergeable yet.** The current draft includes:

- Strict TS implementations of `memory-maintenance`, `watcher-bootstrap`,
  `status-animation`, `handoff-title`, `completion-state`,
  `completion-checkpoint`, `request-receipts` and `offscreen`.
  Original `extension/*.js` files remain the 1.6.1 baseline; build emits
  migrated JS over a byte-for-byte copy of the original extension.
- Parity tests evaluate original and emitted policy code in isolated VMs
  (memory cleanup, request receipts, completion checkpoints, completion
  evidence, notification tick and title lineage).
- The full 29-program nonbrowser suite now also runs on an isolated copy of
  the emitted MV3 distribution, not just on the original JavaScript.
- Foundation consumer workflow configuration and exact declared package
  versions are staged. The Bun dependency lock, real package availability,
  published Get Modular composition wiring and Foundation qualification
  have **not** been confirmed. Never substitute package manifests or this
  text for actual qualification.
- Main content script, service worker, durable journal, migration/status
  adapters and most UI adapters remain unported. No runtime version or
  Chrome permissions were changed in the original extension.
- Draft CI is opt-in via `[ci:test]` on its branch. Before merge, remove
  the temporary draft-push trigger and switch all CI to frozen `bun.lock`.

Further implementation must follow the acceptance matrix above, repair CI
findings, qualify the actual browser bundle, and request designated test-chat
manual verification before the PR is made ready.

## Integration checkpoint: main 1.6.4 (2026-11-02)

The upstream baseline advanced from 1.6.1 to **1.6.4** while this
migration was in Draft. PR #4 has incorporated main commit
`e0da8e4c4d8975263c74b7e89666935f79d74a78` with a merge commit.
This includes the new legacy-handoff completion reconciliation, assistant-only
recovery and native stop guards, title readiness/streaming checks and their
new test programs. Do not rebase by replacing those files with old v1.6.1
snapshots.

The current branch contains **21 historical runtime JS files** and a
partial set of typed overlays in `src/extension/` (currently 16). New tests
from the upstream release were carried to ordinary `.ts` files. The full
nonbrowser test inventory is now 38 TypeScript programs, including migration
parity checks, not the old 29-program baseline.

**Blocking qualification still required:**
- A real Bun lockfile frozen against the *current* package.json (now 1.6.4);
  `package-lock.json` is historical and does not qualify Bun.
- Real TS 7 typechecking of every typed overlay and every tool/test;
  specifically distinguish TS7 native compiler from removed TS JS APIs.
- Repeat all nonbrowser E2E programs on both original and emitted runtime
  after every latest-head change, including the v1.6.4 tests.
- Finish all unported legacy JS in strict TS, introduce actual typed Get Modular
  module composition, and execute Foundation/conformance gates; declaring
  dependencies is not enough.
- Multiple independent reviews, complete current-head CI and final
  owner-approved Chrome smoke checks in a designated test chat.

The old draft checkpoints above are retained as historical snapshots only.
They are not completion evidence for the current branch.

## Draft 1.6.5 checkpoint (latest upstream reconciliation)

Current protected baseline is main `319520a06c5dbf6aeb9818eef3989d9e43b96091` (version 1.6.5).
This fixes first-turn allocation under native evidence and new-chat request
timestamp gates. Its script changes and current tests are merged into this Draft;
the typed completion checkpoint/probe overlays were updated from that release,
not left on 1.6.4 semantics. The
`tests/allocation-migration.test.ts` scenario compares original and emitted
code for first-turn, time-window, read-only, mismatch, and error fences.

**Current implementation:** 19 of 21 source runtime scripts have strict
TypeScript counterparts. The remaining legacy entries are
`extension/content-script.js` and `extension/service-worker.js`; they
remain unchanged in the emitted distribution until safely ported. Chrome's
synchronous event-registration requirements are still authoritative.

The journal UI now exercises actual Get Modular Core/Assembly capability
composition, Resources cleanup and Conformance, with an IIFE bundle that
runs in the Chrome page and has a no-Node/no-Bun runtime smoke test.
Observation is still not product-adopted. The unreleased Lifecycle Kernel is
out of scope unless separately justified and qualified.

The branch has a **release-only blocking `check:complete`** verifying every
historical Chrome JS entry is typed and `bun.lock` exists. Draft feedback
does not bypass this final gate; the full nonbrowser test matrix and Foundation
qualification must also pass on the exact final PR head. A paused/queued GitHub
Actions run is never completion evidence. Remove diagnostic workflow scaffolding
and the historical npm lock after the authoritative Bun lock is frozen.

Do not merge until all checks, independent review and owner Chrome smoke
approval are complete. The owner-only checklist is
`docs/browser-smoke-checklist.md`.

## Integration checkpoint: main v1.7.0, Goal mode

PR #4 now integrates upstream main commit
`fc9513c155bf75ec8706339a11282f03a706a5b6`.
This adds a durable Goal coordinator, pure exact-marker policy, Goal popup
controls, journal cross-feature conflict fences, and Goal/handoff E2E tests.
The new baseline is **23 original Chrome runtime JS files**, not the former
20/21-file snapshots above.

- `goal-policy.ts`, `goal-store.ts`, and the full updated `popup.ts`
  overlay the current v1.7.0 JavaScript with static typed contracts.
- `journal-store.ts` preserves 1.7.0's source-specific Goal/retry/handoff
  admission, restart-proof unknown-outcome locks, and worker-only release
  authority.
- All newly merged Goal tests are migrated from `.mts` to ordinary `.ts`
  and remain in both the source and compiled-distribution test inventories.
- `bun.lock` is frozen and the obsolete npm lock is removed. Node.js
  engineering-toolchain engine range is `>=26.10.0 <27` to match published
  Get Modular support.
- **Unported critical files:** `content-script.js` and
  `service-worker.js`, which implement the native DOM send and MV3 worker
  dispatch. Never substitute a renamed-but-untyped file or fake runtime
  wrapper to bypass the release gate.
- Last CodeRabbit manual request was not completed because the Draft HEAD
  changed. Request substantive independent review only on a stable candidate.

The full green CI and Chrome tests are **not yet established**. Candidate
TypeScript annotations are not a passing qualification. Every future main
advance must be integrated before any final admission check to avoid
reintroducing already-fixed concurrency or recovery defects.


## Current-head validation checkpoint (2026-11-02, post-Host ports)

The Draft now contains TypeScript source ports for both remaining Chrome host
entry points (`content-script.ts` and `service-worker.ts`). This closes the
source-inventory gap, **not** the release-qualification gap: strict TS 7
compilation, emitted classic-script E2E parity, Get Modular/Foundation checks,
independent review and real Chrome owner smoke remain mandatory. Previous
checkpoints identifying these files as missing are historical. No `skipped`
Draft check is evidence of a passing gate. Use the exact latest candidate SHA
for every qualification run; do not merge before the designated browser smoke
has a recorded PASS.
