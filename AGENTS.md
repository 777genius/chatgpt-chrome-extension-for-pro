# Development contract

Read README.md and docs/queue-and-goal.md before changing behavior. This is a Chrome Manifest V3 extension being migrated to strict TypeScript (7.0.2+) and Bun 1.4.3. Maintained source/tests/tooling use ordinary `.ts`; the deterministic build must emit **classic** Chrome scripts into `dist/extension/` without changing injection worlds, manifest permissions, globals, or order. Until migration passes parity gates, the original `extension/` remains a historical behavior oracle; do not ship it as the new typed distribution.

## Invariants

- Only the user sends their draft. Automation may send only a persisted, explicitly authorized payload. Preserve exact whitespace, concurrent edits and attachments. Never weaken the actual editor/model + DOM checks to make a test pass.
- Persist an operation intent before clicking. One intent authorizes one click. A missing acknowledgement is an unknown outcome, never permission to retry the same send blindly.
- Keep notification, retry and handoff events correlated to exact chat URLs/IDs and operation IDs. Preserve the full durable journal and recovery copies; do not auto-delete them to save RAM.
- Do not restart Chrome, refresh/discard user pages, scrape credentials or silently add debugging permissions. Tests in this repo require no browser access.
- A conversation-length limit is terminal for that chat. Use the existing handoff path, preserve message chronology, reasoning level, title lineage and drafts. Do not replace it with another generic retry.
- Dispose obsolete timers/observers. Do not manually remove React-managed conversation DOM or mutate internal ChatGPT caches as a memory shortcut.
- Keep policy, state transitions and volatile page selectors separate at the smallest useful boundary. Reuse the protected send path; do not create a second sender for queue/goal.

## Verification

After `bun.lock` is committed, run `bun install --frozen-lockfile` and `bun run check`. That gate must include typecheck, Foundation consumer checks, the original nonbrowser E2E suite, and the same suite against `dist/extension/`. Add focused tests for changed state transitions, duplicate sends, unknown outcomes, drafts and handoff recovery. Fixtures must be synthetic; no real conversation IDs, prompts, screenshots, profiles, logs or machine-specific paths.

DOM/API mocks are not a real ChatGPT E2E test. If there is no browser access, report that limitation explicitly. The owner is responsible for testing the generated unpacked `dist/extension/` with a designated test chat before final merge. Do not send test messages in the owner's real work chats. A live test requires a designated test chat and authorization.

## Delivery

Do not claim queue/goal already exist. Implement only the requested scope, describe data migration and known browser validation gaps, and retain upstream attribution/license. Do not commit generated output, dependencies, local diagnostics or secrets.


## Agent feedback and required quality gates

- Run `bun run check:changed` for changed-file feedback while editing.
- Run `bun run check:fast` before handoff.
- Run `bun run check` for the full candidate before any review-ready/merge
  decision; it includes the required complete synthetic E2E inventory,
  compiled-distribution verification and Foundation policies.
- Draft optimizations are feedback-only. A green skipped job is never
  qualification; run complete checks on the exact final head and base.
- Keep `@agent-teams/engineering-foundation` development-only, and use only
  public version-pinned `@get-modular/*` APIs. Chrome MV3 owns effects,
  subscriptions, startup registration, durable journal and recovery.
