# Chrome Web Store listing copy

## Name

ChatGPT Prompt-Bound Completion Alert

## Short description

ChatGPT completion alerts, guarded error retries, Goal continuations, and context handoffs when a chat reaches its limit.

## Detailed description

Keep track of long-running ChatGPT work with completion alerts and guarded continuation tools.

- Hear a sound and get a desktop notification when an answer completes or stops with an error. Notifications can include a chat title and answer/error preview.
- See waiting, completed, error and unread-result indicators in the tab favicon.
- Recover from supported ChatGPT errors with bounded automatic continuation attempts.
- Continue after a conversation-length limit by opening a new chat in the same tab and transferring up to the last three user messages and three assistant answers in order. Large context is attached as a text file. The extension attempts to preserve the reasoning mode and chat-title lineage.
- Enable Goal next to the reasoning selector, enter your objective in ChatGPT's normal composer and send it yourself. Pause, resume or stop saved goals. Defaults limit a Goal to 10 continuations and 24 hours.
- Inspect a persistent local activity journal and download a handoff recovery copy when available.

PLEASE READ BEFORE INSTALLING

Automatic retries and new-chat handoffs are enabled. They can send continuation commands and recent conversation context to ChatGPT through your logged-in session. Goal continuations require enabling/starting Goal. Automatic messages can use your ChatGPT plan allowance. Your draft is not used as the automatic message; uncertain sends are blocked rather than blindly repeated.

The extension reads ChatGPT messages, drafts, titles, URLs, request metadata and page interaction state to provide these features. Its local journal and recovery copies can contain exact message text, response excerpts and drafts, and remain across extension updates without automatic expiration. Desktop notifications can expose previews on your screen. There is no developer analytics server or upload of local records to the developer. See the privacy policy for retention, controls and the ChatGPT data flow.

Works on chatgpt.com in Chrome/Chromium 116 or newer. Requires an existing ChatGPT account and supported native controls. Some interface text and the default retry instruction are in Russian. Website changes can interrupt automation; review important work. A Goal completion marker is the model's statement, not independent verification of a repository, CI or an external system. Message queue/Steer is not included.

Independent open-source project, not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of OpenAI. Based on ramhaidar/ChatGPT-Response-Complete-Notifier; distributed under AGPL-3.0-only.

## Suggested dashboard fields

- Category: Productivity (choose the closest currently available category).
- Language: English; some controls and retry prompts are Russian. Do not claim a fully localized English UI.
- Homepage: https://github.com/777genius/chatgpt-chrome-extension-for-pro
- Support: https://github.com/777genius/chatgpt-chrome-extension-for-pro/issues
- Privacy policy candidate after merge/push: https://github.com/777genius/chatgpt-chrome-extension-for-pro/blob/main/docs/store/privacy-policy.md

Verify the public privacy URL without authentication before submission. This file's existence in a working tree does not make that URL live.
