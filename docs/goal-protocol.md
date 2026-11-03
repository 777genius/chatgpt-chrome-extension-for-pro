# Goal protocol — durable auto-continue (separate feature PR)

## Scope
Implement **Goal** only. Message queue / Steer is out of scope and remains unimplemented. No new API calls, external services, feature flags, or extra permissions.

- User explicitly starts an objective and optional stop conditions from the inline Goal control beside reasoning effort or the popup in the selected ChatGPT conversation. Inline state changes require a trusted user click, including native keyboard activation; page-script clicks cannot authorize them. Persistent controls: pause, resume, stop; finite continuation budget and deadline.
- The initial instruction and all later continuation messages are **explicitly authorized by this goal**. They use the existing native composer inspection and guarded one-click sender, *never* a second click implementation or automatic capture of the user's draft.
- Completion requires a **new, request-bound, fully completed assistant answer** whose **entire text is exactly `GOAL_COMPLETE`**, rendered as a single plain paragraph. Headings, strikethrough and other rich markup do not qualify. No substring / partial or streaming match. The marker is a model assertion, **not verification** of a GitHub merge or CI result.
- A non-marker answer schedules one continuation with a stable operation ID. Claim and intent are persisted before dispatch. Any lost click acknowledgement or uncertain outcome blocks further sends until explicit user intervention.
- Goal state and stop rules are stored in local Chrome storage, bound to the original chat and transferred to a confirmed handoff destination without resetting budgets. New-chat handoff payload retains the goal instructions; retry and handoff must not run competing send coordinators.
- User drafts / attachments have priority; automatic goal sends fail closed rather than overwrite. Duplicate tabs, duplicate completion notifications, worker suspension, and race with manual actions are tested.
- Sender checks reject retained inactive/hidden composers and use the send button, reasoning control and attachments belonging to the inspected editor. A confirmed newer manual request supersedes only provably older retry grants; consumed operation/turn claims and uncertain Goal/handoff sends remain fenced. Late retry callbacks cannot alter the manually paused or newly started Goal.
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

## Browser validation for inline Goal

Verified on real ChatGPT in a dedicated test conversation, using native mouse/keyboard input:

- Initial instruction → completed non-marker answer → exactly one continuation → exact `GOAL_COMPLETE` → no further sends.
- A native composer draft blocks Goal without changing or sending the draft.
- One-continuation budget stops after that continuation, even when the answer remains incomplete.
- Pause before a send cancels preparation. Pause during a response lets that response finish without continuing; Resume sends one continuation.
- Turning the inline switch off stops Goal while the current native response can finish.
- Replacing the content listener and a full extension reload preserve the same paused Goal ID, objective and budget without sending. Native hidden composers and screen reader speaker headings are covered by regressions.

The native conversation-length limit was not forced in the short live test. Handoff enrollment, failure recovery, chronology, destination binding and budgets are covered by synthetic integration tests. A real native limit/handoff remains a separate pre-merge validation gap.

## Native message mode

The inline switch arms Goal for the next message the user sends from the normal ChatGPT composer. It does not send, replace or append anything to that draft. Advanced criteria and finite limits are in the three-dot menu; defaults are 10 continuations and 1440 minutes. Existing active Goal budgets are not changed by this default update.

A trusted enabled send action captures an intent, but is insufficient to start Goal. The worker requires a fresh observed request, the exact native submitted user text, a new native prompt/user ID and matching native user timestamp. New chats additionally require first-turn evidence before binding the permanent URL. The adopted Goal starts in waiting state with zero automatic sends. Its next continuation includes the original objective and completion protocol.

The per-tab arm, intent and final binding are durable. Initial binding and Goal state are committed together; a missing acknowledgement never causes the user's message to be resent. Disarming during confirmation cancels adoption or stops that exact adopted Goal, without stopping the user's native request. Later manual sends retain priority. Existing popup-started Goals remain supported.
The follow-up critical review adds synthetic regressions for untrusted inline actions, handoff Pause/Resume controls, retained composers, strict marker markup, and manual-request/retry races across worker restarts. These regressions do not replace a fresh live ChatGPT canary after the sender and marker changes.

## Rich native messages and seeded recovery

Native user messages may contain Markdown URLs while their composer and sent-message bubble show only link labels. Goal adoption accepts that representation only when the visible sent body is bound to the exact latest native user identity and matches the captured intent; the stored objective retains the full native text and URLs. Replayed bindings must retain both representations.

A new-chat recovery seed is recognized by its exact native composer prompt matching the durable source message and its current plain text matching the visible editor. The worker derives the expected native text and optional history file from its own saved operation. It repeats this proof before replacement; changed URL targets, user edits, hidden prompt context and unrelated attachments still stop recovery. Failed historical transfers are not automatically resent after an update.

Inline loading failures now permit an explicit trusted retry and expose errors visibly. An explicit new arm can supersede an unbound intent from a different saved source chat, preserving the cancelled intent in the journal; same-chat and new-root allocation protections remain unchanged.
