# Build and submit

## Reproducible upload ZIP

Run packaging from a Git checkout of this repository, using Node 26+ and the pinned development dependencies. Source downloads without Git metadata can be loaded unpacked, but are not release packaging inputs. Git provenance is checked before writing the ZIP or receipt:

```sh
npm ci
npm run check
npm run package:store -- --out /absolute/output/chatgpt-completion-alert.zip
unzip -t /absolute/output/chatgpt-completion-alert.zip
```

The ZIP puts `manifest.json` at its root and includes a reviewed allowlist of extension runtime assets plus the AGPL license and upstream notice. It excludes repository history, tests, Node dependencies, memory-cleanup/operator tooling, diagnostics, browser profiles and local data. It rejects symlink runtime files, likely embedded private keys/tokens, unexpected permissions/hosts, missing referenced resources, mismatched versions and an overlength description. A secret-pattern check is a guard, not a complete security audit.

ZIP entries are sorted, use fixed January 1, 1980 metadata and uncompressed payloads, and carry no host paths or timestamp variation. Identical source bytes produce identical ZIP bytes across platforms. The `.zip.json` sidecar records SHA-256 and included names; do not upload the sidecar. Generated output belongs outside tracked source. Packaging is a static check and does not certify Chrome Web Store approval or real ChatGPT behavior.

A runtime source edit after packaging requires rebuilding before upload. The receipt includes Git HEAD and working-tree status, not a claim that HEAD alone matches packaged runtime bytes. A dirty package is preparatory; regenerate after final integration/commit.

A different extension version is needed for each update to an already published item; the current version alone does not prove it is newer than the dashboard's latest upload.

## Store assets

- The existing `extension/icons/icon128.png` is the actual 128 x 128 product icon. A copy can be used for the dashboard icon. Preserve the source artwork/attribution; do not invent an OpenAI endorsement.
- Use the three actual screenshots linked from README, as expressly requested by the owner. Prepared 1280 x 800 PNGs preserve each complete source image with a uniform proportional resize, centered on a neutral canvas. No UI was invented, cropped or rewritten. Originals remain in `work/readme-screenshot-originals/`; generated assets are outside tracked source in the current chat's `outputs/chrome-web-store/screenshots/`.
- `01-tab-status-1280x800.png` shows the real tab loading/completion/error indicators.
- `02-goal-controls-1280x800.png` shows real Goal controls with empty objective and criteria. The shown 5-continuation/30-minute values are screenshot settings, not a claim about current defaults.
- `03-completion-notifications-1280x800.png` shows real completion/error notifications and previews.
- Each image was inspected before preparation. No visible passwords, authentication tokens, email addresses, personal identities or full chat URLs were found. The first and third images do contain the owner's existing project/task titles, PR numbers and notification excerpts. The owner expressly authorized these README images for the listing; do not describe their content as synthetic or anonymous.
- `provenance.json` records source URLs, original and prepared dimensions, hashes and placement. Follow the current [Chrome Web Store image requirements](https://developer.chrome.com/docs/webstore/images). These actual screenshots show captured interface states; they are not evidence that the final release passed live browser checks.
- Use these README screenshots instead of `popup-local-renderer-1280x800.png`. Do not upload the local popup renderer capture for this submission.
- Additional promotional artwork is separate from screenshots. No fabricated badges, ratings, user counts, completion guarantees or feature claims.

## Before submission

1. Publish the privacy policy at a public URL and verify it opens signed out. The proposed GitHub main-branch URL becomes usable only after the source is merged/pushed; a stable owned web page is also suitable.
2. Copy the name/description from `listing.md` and permission/privacy answers from `privacy-practices.md`; inspect the actual dashboard labels and publisher certifications.
3. Confirm the uploaded manifest uses only the six audited permissions and chatgpt.com host access; the unnecessary broad `tabs` permission has been removed.
4. Upload the ZIP, actual icon and required screenshot(s). Complete publisher contact/account and distribution fields, and any fee or verification required by Google. Developer account status has not been inferred from local files.
5. Review the actual upload and save/submit through the dashboard only within the user's authorized scope. Do not claim store publication until Google confirms it.

Live checks still needed: notifications/sound delivery, draft/attachment preservation, reasoning-mode restoration, guarded retries and unknown outcomes, Goal pause/stop/limits and handoff/title acknowledgement against the current ChatGPT UI. Synthetic DOM/API checks do not replace these checks.
