# ChatGPT Chrome Extension for Pro

**Completion alerts, automatic error recovery, and chat-limit handoffs for long-running ChatGPT tasks.**

<img width="241" height="438" alt="image" src="https://github.com/user-attachments/assets/3c2c5c2a-9373-4ccf-973d-d5c9daa5b9b0" />
<img width="533" height="648" alt="image" src="https://github.com/user-attachments/assets/1d8702d6-700b-44e1-a588-8f74d2696abf" />
<img width="351" height="429" alt="image" src="https://github.com/user-attachments/assets/2cbb5d54-ed51-4dbd-8a07-73521bf05262" />

Version **1.8.44** · Chrome / Chromium **116+** · No build required

## Features

| Feature | What it does |
| --- | --- |
| **Desktop alerts** | Sound, answer or error preview, and elapsed response time when known. |
| **Animated waiting indicator** | A rotating blue loader in the tab favicon while a request is running, including background tabs. Animation pauses when Chrome is unfocused. No estimated percentages. |
| **Scheduled-task clock** | Shows a clock for a native scheduled-task card. Watches for actual continuation with a five-minute fallback check; does not parse localized dates or refresh the page. |
| **Red / green status icons** | Red for stopped errors, green for completed responses, in notifications and the tab favicon. |
| **Unread result dot** | A blue dot marks unseen results. Viewing the chat removes the dot and its OS notifications; the green/red result stays until your next send. |
| **Goal auto-continue** | Turn on Goal beside reasoning effort, type the objective in ChatGPT’s normal composer, and send it yourself; each fully completed non-marker answer triggers one guarded continuation. New completion instructions require a plain response containing only `GOAL_COMPLETE`; it stops the goal. Durable pause/resume/stop, continuation/time limits, unknown-send fencing, and confirmed-chat handoff. |
| **Automatic retries** | Sends `доделай е2е` (“finish end-to-end”) up to **4 times within 2 minutes**. `Unknown error` follows the native action: retry here or transfer context when ChatGPT offers a new chat. Stops interrupted generation before retrying. Stops on exhausted limits or an unconfirmed send. A durable per-chat claim prevents duplicate retries from multiple tabs. Only a request-confirmed manual send resets the retry state. |
| **Draft protection** | Saves and restores your draft around automatic sends. Your draft is never used as an automatic message. Native rich-link labels are matched to their submitted URLs without treating unrelated drafts as recovery text. Hidden native prompt context also blocks automatic sending. Concurrent edits and user attachments cancel handoff preparation; cancelled transfers do not resume later. |
| **New-chat handoff** | Opens a new chat in the same tab, transfers up to the last **2 user messages + 2 assistant answers** in chronological order, and requests end-to-end completion. Large context becomes a text attachment. Preserves the **source chat’s reasoning mode**, including Pro when available; refuses to send if that mode cannot be restored. A shared source-chat claim prevents duplicate handoffs from multiple tabs. |
| **Title continuity** | Keeps the original chat name with an incrementing suffix: `(1)`, `(2)`, etc. Waits for the first response to finish and rename controls to become ready. |
| **Reload recovery** | Saves request/response bindings and elapsed-time metadata locally. Reattaches to existing tabs after an extension reload; restores safe draft backups without repeating uncertain sends. Follows a new chat from its initial page to its permanent URL using native first-message evidence. Rebinds renumbered native turns using exact sent text and a unique recorded request. Restores terminal error alerts after worker restarts without releasing retry locks. |
| **Persistent activity log** | Records chat IDs, source/destination URLs, send intents, sent text, confirmations, retry counts, and stop reasons. Preserves recovery copies across extension updates. |
| **Safe recovery** | Recognizes a completed response after a failed network stream or extension worker restart. Service warnings do not replace response status. Reports visible errors even when retries are blocked. Pre-send handoff readiness/upload timeouts can recover when the new-chat editor is empty, with no later request or send intent. Retries preparation at most three times, checking every five minutes; preserves Goal budgets and Pause/Stop. A positively refused retry click can prepare again at most twice, preserving retry/Goal limits; unknown sends stay blocked. Unconfirmed sends are never blindly repeated. Disposes obsolete extension observers and timers. |

**Automatic retries and handoffs are enabled.** The extension can send continuation commands and create chats. Logs and recovery copies are stored locally and may contain messages and drafts.

**Turn on Goal beside the reasoning selector**, write the objective in ChatGPT’s normal message field, then send it yourself. This also works on a new, unsaved chat: the extension binds the submitted message only after verifying its native turn, request and permanent conversation URL. The first message is unchanged; the completion protocol is included in subsequent automatic continuations. **⋯** contains optional completion criteria and limits. Defaults are **10 continuations and 24 hours** (1440 minutes). The extension popup retains its separate explicit Start Goal action for saved chats. Pause/resume/stop are persisted across extension reloads. A user's draft and attachments take precedence. Sent manual follow-ups extend the active Goal without resetting its original objective, deadline or budget; explicit Pause/Stop remain in effect. If the outcome of a click is unknown, the goal is blocked rather than retried.

New Goal instructions request **only `GOAL_COMPLETE`**, without Markdown, quotes, explanations or a summary, after the whole objective is complete. While work is incomplete, the model is asked to keep working without discussing the completion signal. Quoted, negated, formatted, embedded or streaming markers do not count. For replies already in flight under the previous protocol, a plain first-paragraph marker followed by the previously prescribed `Итог:` bullet summary remains accepted. **The marker is the model's declaration; the extension does not independently check CI, merge or GitHub state.** Goal messages and stop rules are stored locally and retained when a native handoff to a new chat is confirmed.

**Message queue / Steer is not implemented.** It remains a separate proposal in the [development brief](docs/queue-and-goal.md). See the [Goal protocol and validation gates](docs/goal-protocol.md).

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the [`extension/`](extension/) folder.

No Chrome restart is needed. The extension attempts to attach to existing ChatGPT tabs without refreshing them. Chrome may block access to unloaded or restricted tabs.

Use the extension popup to test sound and notifications. ChatGPT page access is required; handoffs also require a model with the supported reasoning setting.

## Optional Chrome memory cleanup

Inspect JavaScript heaps or explicitly collect unreachable objects without closing or reloading tabs:

```sh
npm run memory -- --cdp http://127.0.0.1:9222
npm run memory -- --cdp http://127.0.0.1:9222 --collect --max-tabs 3
```

Requires Node.js 26+ and an existing local debugging connection. An existing authenticated connection can be reused with `--bridge-config`. Shared heaps are collected once; a private ledger enforces cooldowns and unknown-outcome blocks; reports record results. JavaScript heap savings do **not** guarantee lower physical RAM usage. [Options and safety behavior](docs/memory-cleanup.md).

Strict mode refuses collection when another page's shared heap identity is unknown. `--collect --include-active --allow-unmeasured-peers` is an explicit alternative for measurable heaps; shared activity with unreachable pages remains unverified. Private macOS shortcuts can provide separate **Inspect** and **Clean available memory** actions, using the same private ledger at `$HOME/.local/state/chatgpt-chrome-memory`. [Shortcut behavior and reports](docs/memory-cleanup.md#daily-use-on-macos).

## Development

Node.js **26+**:

```sh
npm ci
npm run check
```

Checks cover syntax, manifest resources, TypeScript, and synthetic DOM / Chrome API tests. Live ChatGPT sending, attachments, reasoning selection, and server-side renaming require a separate browser test.

Contributor instructions: [AGENTS.md](AGENTS.md).

## License

Based on [ChatGPT-Response-Complete-Notifier](https://github.com/ramhaidar/ChatGPT-Response-Complete-Notifier). Licensed under [AGPL-3.0](LICENSE); see [NOTICE.md](NOTICE.md).
