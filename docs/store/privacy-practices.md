# Dashboard privacy and permission answers

Reviewed against extension source on November 4, 2026. These answers describe this implementation, not a promise of store approval. Recheck after permission/data-flow changes. Do not select "no user data" simply because processing is local.

## Single purpose

Help users monitor and continue long-running ChatGPT tasks with prompt-bound completion alerts, guarded error recovery, Goal continuations and conversation-limit handoffs, while preserving drafts and a local recovery journal.

## Permission justification copy

| Permission | Justification |
| --- | --- |
| notifications | Show desktop completion/error notices, with the matching ChatGPT title and response/error preview, and open the associated chat when clicked. |
| storage | Persist Goal limits and controls, duplicate-send fences, drafts, handoff recovery context, per-chat status and the activity journal so an extension restart does not repeat uncertain sends. Session storage holds temporary request/bootstrap metadata. No storage sync is used. |
| offscreen | Create a bundled offscreen audio document to synthesize notification tones while the service worker is active. No microphone or remote audio is used. |
| scripting | Inject bundled observers into existing ChatGPT tabs and run bundled page inspection/action functions to verify editor content, native request/response identity, reasoning controls and safe handoff state. No downloaded code is executed. |
| tabs | Locate the relevant open ChatGPT tabs, correlate exact URLs and tab IDs, inspect activation/loading state, focus the corresponding chat, navigate a handoff in the same tab, and open the bundled activity journal. The current implementation only uses this for these user-facing workflows. |
| webRequest | Observe ChatGPT conversation request IDs, timing, completion/failures and HTTP status to bind outcomes and avoid duplicate automatic sends. During a pending native title rename, inspect its matching request body to verify the desired title. No auth headers, cookies or passwords are read. |
| unlimitedStorage | Keep the durable local activity journal and text handoff/draft recovery copies across updates without silently pruning recovery evidence to stay within the normal local-storage quota. Data can grow with usage. |
| https://chatgpt.com/* | Read and interact with ChatGPT conversations and editor state for completion detection, draft protection, retries, Goal continuations and context handoffs. Host access is restricted to chatgpt.com. Automatic continuations/context are sent through the native ChatGPT UI. |

Review note: `tabs` is a potential minimum-permissions concern because several tab operations require no `tabs` permission, and matching host access can already expose ChatGPT tab URLs/titles. The table explains current use; it does not prove the broad permission is indispensable. A separate removal-and-regression-test pass should resolve this before claiming minimum-permission compliance. Do not replace this concern with an invented justification about reading all browsing history.

## Remote code

Select **No, I am not using remote code**. Runtime JavaScript and HTML are bundled; the extension runs its own packaged functions in the page. It observes ChatGPT's existing interface and native state. No eval/downloaded JS, remote WASM, third-party SDK or remote executable configuration was found.

## Data usage

The current dashboard's exact labels should be checked at submission. Disclose the extension's local access/storage and native ChatGPT transfers consistently with the policy:

| Data category | Answer and reason |
| --- | --- |
| Website content | Yes: prompts, assistant replies, titles, draft text, handoff context, Goal text and error/preview content. |
| Web history | Yes, limited to ChatGPT: chat URLs/IDs, titles and navigation/source-destination records in the local journal. No general browsing-history database is accessed. |
| User activity | Yes: send/continuation intents and confirmations, request timing, attachment/editor state, Goal controls, tab visibility and retry/handoff events. No general keystroke or mouse-position logger. |
| Personally identifiable information | No dedicated identity fields or profile collection. Free-form conversation/draft content can contain identifiers; explain that under website content rather than promise that no personal information is handled. If the dashboard asks about any incidental sensitive content, include this caveat and follow that scope. |
| Personal communications | Yes: user-assistant ChatGPT conversation text is read, retained in recovery/journal records where needed, and transferred to ChatGPT during native handoffs. |
| Health / financial | No dedicated extraction or separate use. Such content can appear in user conversations and recovery copies. Do not claim these are filtered or excluded. |
| Authentication information | No cookies, tokens or credentials are requested/read. Existing ChatGPT authentication is used by ChatGPT's native UI, not extracted by the extension. |
| Location | No location API, IP collection service or geographic tracking. Content may mention locations. |

All three limited-use certifications are supported by the audited extension: no data sale/transfer unrelated to its core features; no use/transfer unrelated to the single purpose; no creditworthiness/lending use. Sharing context with OpenAI through native ChatGPT is necessary to the disclosed continuation/handoff feature and must remain disclosed. The maintainer still needs to confirm any handling outside the extension, such as voluntary support submissions, before certifying on behalf of the publisher.

## Audit anchors

- `extension/manifest.json`: seven permissions and only chatgpt.com host access.
- `extension/service-worker.js`: scoped request observation, notifications and 260-character maximum response preview; native page inspection via packaged scripting; no direct fetch/XHR/WebSocket/upload endpoint.
- `extension/handoff-renamer.js`: bounded matching native rename-request body inspection; request status acknowledgement.
- `extension/journal-store.js`, `goal-store.js`, `request-receipts.js`: persistent local journal/state and temporary session records; no storage sync; no automatic journal deletion.
- `extension/content-script.js`, `page-probe.js`: page/editor/conversation reading, protected native sends, context attachment and draft preservation.
- `extension/popup.js`: user-triggered local text recovery download, including a saved draft when available.
- `extension/offscreen.js`: locally synthesized sound.

## Sources

- [Privacy fields and minimum permissions](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Local user-data handling still needs a privacy policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Manifest description limit](https://developer.chrome.com/docs/extensions/reference/manifest/description)
