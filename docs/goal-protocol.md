# Goal protocol — durable auto-continue (separate feature PR)

## Scope
Implement **Goal** only. Message queue / Steer is out of scope and remains unimplemented. No new API calls, external services, feature flags, or extra permissions.

- User explicitly starts an objective and optional stop conditions from the popup in the selected ChatGPT conversation. Persistent controls: pause, resume, stop; finite continuation budget and deadline.
- The initial instruction and all later continuation messages are **explicitly authorized by this goal**. They use the existing native composer inspection and guarded one-click sender, *never* a second click implementation or automatic capture of the user's draft.
- Completion requires a **new, request-bound, fully completed assistant answer** whose **entire text is exactly `GOAL_COMPLETE`**. No substring / Markdown / partial or streaming match. The marker is a model assertion, **not verification** of a GitHub merge or CI result.
- A non-marker answer schedules one continuation with a stable operation ID. Claim and intent are persisted before dispatch. Any lost click acknowledgement or uncertain outcome blocks further sends until explicit user intervention.
- Goal state and stop rules are stored in local Chrome storage, bound to the original chat and transferred to a confirmed handoff destination without resetting budgets. New-chat handoff payload retains the goal instructions; retry and handoff must not run competing send coordinators.
- User drafts / attachments have priority; automatic goal sends fail closed rather than overwrite. Duplicate tabs, duplicate completion notifications, worker suspension, and race with manual actions are tested.
- No real ChatGPT browser testing until immediately before merge, on a designated test conversation. No testing in the owner's working chats.

## State machine

`idle → preparing → sending → waiting → (complete | preparing | paused | stopped | blocked)`; `handoff` waits for independently confirmed destination. On restart, a persisted but unclaimed `preparing` operation may be redelivered with its **same operation ID**. Once `intent` exists, `sending` cannot automatically retry: a click may have occurred without acknowledgement, so the outcome is `unknown` and automatic resending stops. Persist one operation and one bound completion key.

## Verification requirements

1. Exact `GOAL_COMPLETE` only on fully completed assistant message, bounded to the expected prompt; ordinary text containing marker must continue.
2. Only one append/send authorization per operation; duplicate events/tabs/recovery do not resend; timeout after click yields unknown.
3. Start, pause, resume, stop, budget, storage failure, wrong chat, manual draft / attachments, new-user message, retry conflict, handoff recovery.
4. Synthetic DOM and mocked Chrome tests via `npm run check` (no browser access). Live browser E2E with a dedicated chat, native completion/stream, extension reload and handoff is a **pre-merge** gate.

## Merge gate
Do not merge solely because CI is green. Browser E2E needs a designated test chat and authorized live sending; otherwise leave the PR draft and report it as unverified.
