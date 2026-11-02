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
