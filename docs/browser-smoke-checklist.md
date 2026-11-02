# Owner-only final Chrome smoke test

**Status:** Not authorized to run yet. The generated `dist/extension/`
must first pass the complete nonbrowser gate and independent review on the
final current commit. This checklist is for a **separate test browser
profile and designated disposable ChatGPT test chat**, not working chats.

1. From the successful, current-head **Ready PR** GitHub Actions run,
   download its `chrome-mv3-<run SHA>` artifact. Extract it into
   a fresh folder and select the folder containing `manifest.json`
   (GitHub Artifact may omit the `dist/extension/` parent directories).
   This is the preferred way to test precisely the build that passed CI. If rebuilding locally instead, use the exact
   reviewed PR head/base and `bun install --frozen-lockfile`. Load the
   generated directory through Chrome's **Load unpacked**. Verify version
   matches `package.json` and Chrome requests no permissions beyond
   `extension/manifest.json`. Record both the PR head SHA and the Actions
   run SHA — PR checks may test a synthetic merge commit.
2. Manually send a test prompt and confirm the completion notification,
   sound, response association, unread indicator, and tab-focus retirement.
   Test successful, failed, cancelled and restarted generation separately.
3. Type an unsent draft containing exact whitespace and punctuation.
   Trigger the supported synthetic retry/recovery situation in a test
   chat. The extension must never send/overwrite that draft. A request
   with an unknown ACK must not be resent blindly.
4. In a disposable conversation, exercise the supported chat-limit handoff
   flow. Check exact message chronology, attachment ownership, max
   reasoning selection, title lineage and persisted send intent. Reload
   the extension between preparation and observation; ensure no duplicate
   send or duplicate rename save.
5. Open the activity journal. Search/filter, refresh, export and inspect
   records for the exact test chat; no events may be dropped or falsely
   attributed to another tab. Ensure the read-only Get Modular UI remains
   functional on repeated refreshes.
6. Verify scheduled-task indicator and its transition into an actual
   continuation, if the disposable test environment exposes a native
   scheduled-task card.
7. After the smoke test, inspect Chrome's extension console for errors,
   reload the unpacked distribution once, and repeat a simple manual
   send. Confirm no extra watcher, timer, notification or duplicate
   automation is left behind.

**Merge approval requires** a concrete tested Chrome/OS version, the exact
source SHA/distribution, PASS/FAIL per exercised scenario and any
unexercised limitation. No synthetic VM/DOM test is a substitute for
this final validation. Never auto-merge the Draft PR before explicit owner
confirmation.
