# Development contract

Read README.md and docs/queue-and-goal.md before changing behavior. This is a Chrome Manifest V3 extension with no build step. Production scripts are classic JavaScript; handwritten Node test/tooling is TypeScript `.mts`, run by Node 26.

## Invariants

- Only the user sends their draft. Automation may send only a persisted, explicitly authorized payload. Preserve exact whitespace, concurrent edits and attachments. Never weaken the actual editor/model + DOM checks to make a test pass.
- Persist an operation intent before clicking. One intent authorizes one click. A missing acknowledgement is an unknown outcome, never permission to retry the same send blindly.
- Keep notification, retry and handoff events correlated to exact chat URLs/IDs and operation IDs. Preserve the full durable journal and recovery copies; do not auto-delete them to save RAM.
- Do not restart Chrome, refresh/discard user pages, scrape credentials or silently add debugging permissions. Tests in this repo require no browser access.
- A conversation-length limit is terminal for that chat. Use the existing handoff path, preserve message chronology, reasoning level, title lineage and drafts. Do not replace it with another generic retry.
- Dispose obsolete timers/observers. Do not manually remove React-managed conversation DOM or mutate internal ChatGPT caches as a memory shortcut.
- Keep policy, state transitions and volatile page selectors separate at the smallest useful boundary. Reuse the protected send path; do not create a second sender for queue/goal.

## Verification

Run `npm ci` then `npm run check`. Add focused tests for changed state transitions, duplicate sends, unknown outcomes, drafts and handoff recovery. Fixtures must be synthetic; no real conversation IDs, prompts, screenshots, profiles, logs or machine-specific paths.

DOM/API mocks are not a real ChatGPT E2E test. If there is no browser access, report that limitation explicitly. Do not send test messages in the owner's real work chats. A live test requires a designated test chat and authorization.

## Delivery

Do not claim queue/goal already exist. Implement only the requested scope, describe data migration and known browser validation gaps, and retain upstream attribution/license. Do not commit generated output, dependencies, local diagnostics or secrets.
