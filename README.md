# ChatGPT Chrome Extension for Pro

**Completion alerts, automatic error recovery, and chat-limit handoffs for long-running ChatGPT tasks.**

Version **1.4.0** · Chrome / Chromium **116+** · No build required

## Features

| Feature | What it does |
| --- | --- |
| **Desktop alerts** | Sound, answer or error preview, and elapsed response time when known. |
| **Animated waiting indicator** | A rotating blue loader in the tab favicon while a request is running, including background tabs. Animation pauses when Chrome is unfocused. No estimated percentages. |
| **Red / green status icons** | Red for stopped errors, green for completed responses, in notifications and the tab favicon. |
| **Read without losing status** | Visiting a chat dismisses its OS notifications. The result icon stays until your next manual send, then becomes a waiting loader. |
| **Automatic retries** | Sends `доделай е2е` (“finish end-to-end”) up to **4 times within 2 minutes**. `Unknown error` retries in the same chat. Stops on exhausted limits or an unconfirmed send. |
| **Draft protection** | Saves and restores your draft around automatic sends. Your draft is never used as an automatic message. |
| **Chat-limit handoff** | Opens a new chat in the same tab, transfers the last **2 user messages + 2 assistant answers** in chronological order, and requests end-to-end completion. Large context becomes a text attachment. Requires the **max reasoning setting**. |
| **Title continuity** | Keeps the original chat name with an incrementing suffix: `(1)`, `(2)`, etc. Waits for the new chat to be saved before renaming. |
| **Persistent activity log** | Records chat IDs, source/destination URLs, send intents, sent text, confirmations, retry counts, and stop reasons. Preserves recovery copies across extension updates. |
| **Safe recovery** | Reports visible errors even when retries are blocked. Unconfirmed sends are never blindly repeated. Disposes obsolete extension observers and timers. |

**Automatic retries and handoffs are enabled.** The extension can send continuation commands and create chats. Logs and recovery copies are stored locally and may contain messages and drafts.

**Message queue and goal mode are not implemented yet.** See the [development brief](docs/queue-and-goal.md).

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the [`extension/`](extension/) folder.

No Chrome restart is needed. The extension attempts to attach to existing ChatGPT tabs without refreshing them. Chrome may block access to unloaded or restricted tabs.

Use the extension popup to test sound and notifications. ChatGPT page access is required; handoffs also require a model with the supported reasoning setting.

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
