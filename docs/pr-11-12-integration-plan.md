# PR #11 + #12: safe integration and Chrome Web Store release

Status: **implementation plan (reviewed, not a claim of completed release)**. Scope: integrate the *existing* PRs [#11](https://github.com/777genius/chatgpt-chrome-extension-for-pro/pull/11) and [#12](https://github.com/777genius/chatgpt-chrome-extension-for-pro/pull/12) into a single tested release PR. Do not create a third PR, a second delivery branch, a new sender, a new persistence subsystem, or feature flags.

## Objective and immutable rules

- Deliver all of the Goal, recovery, handoff and Chrome Web Store changes **without dropping commits, files, data, or protections**.
- One click per authorized durable send intent. A missing response is **unknown** and must never silently become permission for another send.
- Explicit Stop/Pause and manual user edits win over automation; never overwrite drafts or replay uncertain messages.
- Preserve historical journals, request/turn receipts, saved Goal objectives, manual supplements, deadlines, continuation budgets, attachments, handoff copies and chat-title ownership.
- Keep the existing classic-JS extension with one service-worker coordinator and the current tests. Do not implement the unbuilt Queue/Steer proposal.
- Tests only use synthetic fixtures and designated isolated test chats. **Never send messages in the owner's live chats** or restart/reload their browser.

## Baseline and merge strategy

At initial inspection on 2026-11-05, PR #11: `fix/goal-manual-followups` at `87ee489`, version `1.8.75`; PR #12: `fix/store-release-safety` at `acdfbbd`, version `1.8.47`. They diverge at `b6659aa` (13 commits exclusive to #11, 7 to #12). **PR #12 does not yet contain the latest #11.** Both have separate green Checks, not an integrated green build.

**Destination is PR #12's existing branch.** Integrate PR #11's *current* head with a real merge commit (two parents). If a GitHub-native PR-to-branch merge is safe, use it; otherwise perform a proper three-way integration and compare both source trees with the result. No squash/cherry-pick that obscures ancestry, no forced branch rewrite. Re-read heads just before any write and use lease/expected SHA where supported.

| Area | What to retain |
| --- | --- |
| Goal/recovery/runtime | Latest #11 lifecycle, root-message proof, handoff lineage, detached-reply probe, manual blocked-handoff recovery, historical-ack handling and all newer tests. |
| Store preparation | #12's six audited permissions (no redundant `tabs`), host restriction to `chatgpt.com`, listing/privacy/reviewer docs, deterministic ZIP, Git provenance and symlink protections. |
| Version | One consistent version in README, manifest, package and lock (not lower than #11's version; check Chrome Web Store draft/published version before choosing the next upload version). |
| Packaging | Add #11 runtime modules `goal-lineage.js`, `goal-request-proof.js`, `reply-probe.js` to ZIP allowlist. Validate all imports and bundled assets, privacy answers and screenshots against actual merged behavior. |
| Preservation | Confirm merge ancestry includes both source heads; compare renamed/added files and tests, journal schema compatibility and legacy replay. |

## Minimal fixes before shipping

Priority means release risk, not code-size or preference.

1. **P1 — Pending manual supplements:** `goal-store.manual()` currently replaces a single `manualPending` on a second authorized follow-up before the first binds. Use the *smallest* ordered pending structure keyed by exact request identity; bind independently and exactly once; include all confirmed supplements in chronology in both continuation and handoff. Support old single-field saved records without resetting them. Do not silently discard pending instructions or authorize new sends while binding is incomplete.
2. **P1 — Stop/Pause vs retry authorization:** re-read current durable Goal state at the shared retry `send.authorized` gate, then again at the last pre-click gate. A paused/stopped, changed-request or unknown Goal must not result in an automatic retry click. Keep the existing journal lock; do not create a parallel send path. Test the interleaving immediately before send.
3. **P2 — Native probe rejection:** if `chrome.scripting.executeScript` rejects while enriching a `retry.planned` event, retain the *existing conservative* retry fallback rather than aborting journal append. Do not invent native evidence.
4. **P2 — Late / close follow-ups:** correlate native user IDs, exact request IDs and ordered timestamps; avoid ambiguous ±10-second matching when two valid manual sends occur close together. Reject genuinely ambiguous, missing or contradictory records, with no replay.
5. **P2 — Current page-level error:** do not declare Goal completion solely because the selected turn is free of errors when its active page visibly reports a current recovery error.
6. **P2 — Handoff escalation race:** after the awaited history inspection, recheck the original page/chat, prompt, attempt, request ID and error ownership before starting a handoff.
7. **P2 — Rich link integrity:** where native serialized Markdown and visible composer text differ, do not accept a same-label, different-URL link as the same user-approved payload. Fail closed if exact target cannot be proven.
8. **P2/P3 — Failure isolation / UI:** probe errors must not hide a persisted Goal record in inline GET; keep line breaks in objective/follow-ups; show the same confirmed supplements in popup and inline panel. Preserve existing user-edited chat titles.
9. Reassess existing unresolved CodeRabbit threads on both PRs against the *integrated* code; mark already-fixed findings as such, and fix actual current-head blockers only. Do not add speculative abstractions.

## Tests and release gates

- **Static/synthetic:** `npm ci && npm run check` on **the final merged SHA**, plus `npm run package:store`. Regression tests: two follow-ups before acknowledgement; late native acknowledgement; close (<10 s) follow-ups; Stop/Pause at authorization and pre-click; two tabs; duplicate/unknown send; worker restart and legacy journal schema; retry probe throw; handoff race; draft/attachment and reasoning-mode preservation; manually edited titles; link-target mismatch; popup/inline consistency.
- **Packaging:** match README/manifest/package/lock versions; inspect permission/host allowlist; check package imports; `unzip -t`; inspect ZIP runtime paths, size, sha256 receipt; rebuild from clean final checkout to ensure repeatability. A *prior draft ZIP is invalid after any code/version change*.
- **Browser E2E:** use an isolated Chrome profile with synthetic ChatGPT conversation only where authorized/available. Verify goal manual-send -> continuation -> exact marker, Pause/Stop, retry budget 4/2 min, native errors, no duplicate sends across reload, title, handoff, screenshots and notifications. A DOM mock, GitHub green badge or store upload does not substitute for this. If live access is unavailable, record precisely which E2E gates remain unverified and do **not** claim full browser verification or Chrome Web Store publication.
- **Store review:** confirm public privacy URL, permission rationale, truthful screenshots/listing, uploaded package version and exact dashboard draft/package; user consent for submission and successful Google approval are separate gates.
- **Merge:** require actual integrated-head green checks and no unresolved P1/P2. Merge #12 into `main` via merge commit (preserve both ancestries), verify `main` contains both heads and required assets; close #11 only after proof it is contained. Verify final `main` CI. Do not silently bypass a safety gate to accelerate release.

## Execution sequence

1. Capture source refs and changed-file inventory. Save this plan to #12 first.
2. Reviewer pass A (**safety/data**) challenges send authorization, unknown outcomes, all historical state migrations, and precedence of Stop/manual actions.
3. Reviewer pass B (**integration/release**) challenges branch ancestry, version/permissions, ZIP asset allowlist, privacy and review screenshots.
4. Reviewer pass C (**scope/tests**) challenges test realism, missing assertions, unnecessary design changes and deployment claims.
5. Incorporate criticisms into this plan before implementation; add only targeted fixes and tests.
6. Integrate #11 into #12 without losing either branch; fix all genuine blocker regressions; run checks, revisit reviews, verify release package.
7. Once final gates are demonstrated, merge #12, verify `main`, close included #11; report any unverified live/store gates explicitly.

## Critical review — corrections already applied to this plan

**Safety reviewer:** A first draft saying “merge #11 and run tests” was insufficient: it could allow unknown-send replay or erasure of a second manual supplement. Added exact identity requirements, legacy saved-state compatibility, Stop checks both at durable authorization and before click, and explicit unknown-outcome fences.

**Integration/release reviewer:** A first draft could accidentally package version 1.8.47 or omit #11's three added modules, and merging “the latest” without frozen refs could miss moving commits. Added exact baseline heads, branch-lease verification, package inventory and version checks, source ancestry proof and rebuilding ZIP from the final tree.

**Scope/test reviewer:** Broad “fix every bug” is not verifiable and can lead to unrelated refactors, extra senders or misleading E2E claims. Constrained changes to proven integration/regression faults, existing modules and focused tests; separated synthetic CI from authorized live Chrome testing and Google Web Store approval. No new framework, flags, database, or CI infrastructure.

## Completion evidence log

Update this section with *actual* committed SHA, passing check runs, test results, built ZIP SHA256 and merge verification. An unchecked step is **not** an achieved result.

- [ ] Source branches integrated into #12 with both parents preserved
- [ ] P1/P2 corrected with regression coverage and journal migration verification
- [ ] Full final-head `npm run check` succeeds
- [ ] Reproducible ZIP and version/permission/audit checks pass
- [ ] Browser E2E performed in an authorized synthetic environment (or limitation reported)
- [ ] Final combined PR review complete
- [ ] #12 merged; `main` contains both original heads; #11 closed as included
- [ ] Final `main` CI green
- [ ] Chrome Web Store package/draft/status separately verified
