# ChatGPT Chrome Extension for Pro

**Completion alerts, automatic error recovery, and chat-limit handoffs for long-running ChatGPT tasks.**

Version **1.6.5** · Chrome / Chromium **116+** · No build required

## Features

| Feature | What it does |
| --- | --- |
| **Desktop alerts** | Sound, answer or error preview, and elapsed response time when known. |
| **Animated waiting indicator** | A rotating blue loader in the tab favicon while a request is running, including background tabs. Animation pauses when Chrome is unfocused. No estimated percentages. |
| **Scheduled-task clock** | Shows a clock for a native scheduled-task card. Watches for actual continuation with a five-minute fallback check; does not parse localized dates or refresh the page. |
| **Red / green status icons** | Red for stopped errors, green for completed responses, in notifications and the tab favicon. |
| **Unread result dot** | A blue dot marks unseen results. Viewing the chat removes the dot and its OS notifications; the green/red result stays until your next send. |
| **Automatic retries** | Sends `доделай е2е` (“finish end-to-end”) up to **4 times within 2 minutes**. `Unknown error` follows the native action: retry here or transfer context when ChatGPT offers a new chat. Stops interrupted generation before retrying. Stops on exhausted limits or an unconfirmed send. |
| **Draft protection** | Saves and restores your draft around automatic sends. Your draft is never used as an automatic message. |
| **New-chat handoff** | Opens a new chat in the same tab, transfers the last **2 user messages + 2 assistant answers** in chronological order, and requests end-to-end completion. Large context becomes a text attachment. Requires the **max reasoning setting**. |
| **Title continuity** | Keeps the original chat name with an incrementing suffix: `(1)`, `(2)`, etc. Waits for the first response to finish and rename controls to become ready. |
| **Reload recovery** | Saves request/response bindings and elapsed-time metadata locally. Reattaches to existing tabs after an extension reload; restores safe draft backups without repeating uncertain sends. Follows a new chat from its initial page to its permanent URL using native first-message evidence. |
| **Persistent activity log** | Records chat IDs, source/destination URLs, send intents, sent text, confirmations, retry counts, and stop reasons. Preserves recovery copies across extension updates. |
| **Safe recovery** | Recognizes a completed response after a failed network stream or extension worker restart. Service warnings do not replace response status. Reports visible errors even when retries are blocked. Unconfirmed sends are never blindly repeated. Disposes obsolete extension observers and timers. |

**Automatic retries and handoffs are enabled.** The extension can send continuation commands and create chats. Logs and recovery copies are stored locally and may contain messages and drafts.

**Message queue and goal mode are not implemented yet.** See the [development brief](docs/queue-and-goal.md).

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the [`extension/`](extension/) folder.

No Chrome restart is needed. The extension attempts to attach to existing ChatGPT tabs without refreshing them. Chrome may block access to unloaded or restricted tabs.

Use the extension popup to test sound and notifications. ChatGPT page access is required; handoffs also require a model with the supported reasoning setting.

## Optional Chrome memory cleanup

Inspect JavaScript heaps or explicitly collect unreachable objects without closing or reloading tabs:

```sh
bun run memory -- --cdp http://127.0.0.1:9222
bun run memory -- --cdp http://127.0.0.1:9222 --collect --max-tabs 3
```

Requires Node.js 26+ and an existing local debugging connection. An existing authenticated connection can be reused with `--bridge-config`. Shared heaps are collected once; a private ledger enforces cooldowns and unknown-outcome blocks; reports record results. JavaScript heap savings do **not** guarantee lower physical RAM usage. [Options and safety behavior](docs/memory-cleanup.md).

Strict mode refuses collection when another page's shared heap identity is unknown. `--collect --include-active --allow-unmeasured-peers` is an explicit alternative for measurable heaps; shared activity with unreachable pages remains unverified. Private macOS shortcuts can provide separate **Inspect** and **Clean available memory** actions, using the same private ledger at `$HOME/.local/state/chatgpt-chrome-memory`. [Shortcut behavior and reports](docs/memory-cleanup.md#daily-use-on-macos).

## Draft TypeScript migration (PR #4)

This branch is **not release-ready**. It incrementally replaces the classic
extension JavaScript with strict TypeScript and generates browser-compatible
classic scripts into `dist/extension/` using Bun. The original `extension/`
remains an intentional behavior reference until full parity is qualified.
Install and test **`dist/extension/`**, not `extension/`, when validating
the migration build. Do not load the draft into a real work profile or real
ChatGPT conversations.

After `bun.lock` is frozen, the required build and nonbrowser checks are:

```sh
bun install --frozen-lockfile
bun run check
```

This includes tests executed against both the original and generated runtime.
It **does not** prove live Chrome/ChatGPT behavior; the owner will run a
dedicated test-chat smoke test before merge. Read the
[migration contract](docs/typescript-bun-modular-migration.md) for the checklist
and current blockers.

## Development

Node.js **26+**, Bun **1.4.3**:

```sh
bun install --frozen-lockfile
bun run check
```

Checks cover syntax, manifest resources, TypeScript, and synthetic DOM / Chrome API tests. Live ChatGPT sending, attachments, reasoning selection, and server-side renaming require a separate browser test.

Contributor instructions: [AGENTS.md](AGENTS.md).

## License

Based on [ChatGPT-Response-Complete-Notifier](https://github.com/ramhaidar/ChatGPT-Response-Complete-Notifier). Licensed under [AGPL-3.0](LICENSE); see [NOTICE.md](NOTICE.md).
