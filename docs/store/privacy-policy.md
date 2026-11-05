# Privacy policy

Effective date: November 4, 2026

This policy covers ChatGPT Prompt-Bound Completion Alert, the open-source Chrome extension maintained in [777genius/chatgpt-chrome-extension-for-pro](https://github.com/777genius/chatgpt-chrome-extension-for-pro). It helps users monitor and continue long-running ChatGPT tasks with completion alerts, guarded retries, Goal continuations and conversation handoffs.

## Data the extension accesses and stores

On chatgpt.com, the extension reads conversation text, user prompts, assistant responses, chat titles and URLs/IDs, composer drafts, visible attachment state, reasoning settings, completion/error state and task cards. It uses these to associate an answer with its prompt, protect drafts, recover interrupted work and transfer recent context. It inspects the page's native conversation state where needed to verify the exact submitted message and response.

It observes ChatGPT conversation-request metadata (request IDs, timing, status and failures). During its own pending title-renaming operation it also reads the matching native rename request body to verify the title. It does not request cookies or read authentication tokens or passwords.

Local extension storage contains operation intents and confirmations, request/response bindings, chat URLs/IDs and titles, timestamps, errors, response previews, exact automatic messages, saved drafts, recent conversation context used in handoffs, Goal objectives/rules/budgets, and an activity journal. Conversation content may itself contain personal or sensitive information. The extension does not classify or redact that content. Browser tab IDs, window IDs, visibility and loading state support delivery and duplicate-send prevention.

## Where information goes

The extension has no developer-operated server, analytics, advertising or tracking endpoint. It does not upload your journal or drafts to the developer. Extension state uses Chrome local storage and, for some temporary request/bootstrap records, Chrome session storage. It does not use Chrome storage sync.

Automatic retries and conversation handoffs are enabled. The extension can send continuation instructions, create a new chat in the same tab, submit recent context as text or a generated text attachment, and rename the new conversation through ChatGPT's own interface. Goal mode sends further continuations after you explicitly enable/start it, subject to saved limits and pause/stop controls. These actions send information to OpenAI through your logged-in ChatGPT session, where OpenAI's policies and your account settings apply. They may use your ChatGPT plan allowance. The extension does not independently verify that the model's claimed task completion is correct.

Desktop notifications can show a chat title and answer/error preview. Your operating system may display or retain these in notification history or on the lock screen, depending on your settings. Sounds are synthesized locally, with no downloaded audio or microphone recording.

If you choose to download a handoff recovery file, it may contain transferred messages and an unsent draft. Such files remain wherever you save them. If you voluntarily share a journal, recovery file or screenshot in a support issue, its contents will be visible to that issue's audience. Review and redact sensitive information before sharing.

## Use, retention and control

Data is used to provide the features above and their local reliability/recovery records. It is not sold, used for advertising, transferred to data brokers, used to evaluate creditworthiness or used to train a developer-operated model. The use of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

Durable journals and recovery copies are retained locally across extension/browser restarts and extension updates. There is no automatic expiration or in-extension delete-all control. Pause/Stop controls stop Goal continuation; they do not delete the journal or historical drafts. Disable or remove the extension to stop its activity. Removing the extension removes its Chrome-managed extension storage; this does not delete ChatGPT conversations, operating-system notifications, downloaded recovery files or any separately made backups. Manage those in ChatGPT, your operating system or your saved files. Local records are not additionally encrypted by this extension; device/profile access controls remain important.

## Contact and changes

For privacy questions, contact the maintainer through the [project issue tracker](https://github.com/777genius/chatgpt-chrome-extension-for-pro/issues). Do not include private conversation content in a public issue. Changes to data handling will be reflected in this policy and the store disclosures.

This is an independent project, not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of OpenAI.
