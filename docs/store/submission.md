# Build and submit

## Reproducible upload ZIP

Use Node 26+ and the pinned development dependencies:

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
- At least one real product screenshot is required. Capture an isolated synthetic ChatGPT test conversation or an isolated renderer of the actual bundled popup. Never use the owner's private chats, titles, logs or profile. Show the shipped interface and clearly distinguish a renderer capture from live ChatGPT behavior.
- Supply screenshots at 1280 x 800 or 640 x 400, following the current [Chrome Web Store image requirements](https://developer.chrome.com/docs/webstore/images). A real capture may be placed on a neutral canvas without implying unsupported features. Do not describe a promotional mockup as a live screenshot.
- Additional promotional artwork is separate from screenshots. No fabricated badges, ratings, user counts, completion guarantees or feature claims.

A prepared `popup-local-renderer-1280x800.png` captures the actual bundled popup HTML/CSS in an isolated local headless renderer on a neutral canvas. Its caption explicitly identifies local rendering and absence of real conversation data. The popup script cannot use Chrome extension APIs in that file-based renderer, so this is an initial-interface image, not functional or live ChatGPT validation. All visible controls fit the captured canvas. No owner profile or ChatGPT page was accessed. Confirm the store reviewer accepts this renderer capture; obtain a live synthetic test-chat screenshot if requested. An icon or ZIP is not a substitute for a required screenshot.

## Before submission

1. Publish the privacy policy at a public URL and verify it opens signed out. The proposed GitHub main-branch URL becomes usable only after the source is merged/pushed; a stable owned web page is also suitable.
2. Copy the name/description from `listing.md` and permission/privacy answers from `privacy-practices.md`; inspect the actual dashboard labels and publisher certifications.
3. Resolve the documented minimum-permission concern about `tabs` or accurately explain a verified requirement. The package deliberately does not change production permissions without validation.
4. Upload the ZIP, actual icon and required screenshot(s). Complete publisher contact/account and distribution fields, and any fee or verification required by Google. Developer account status has not been inferred from local files.
5. Review the actual upload and save/submit through the dashboard only within the user's authorized scope. Do not claim store publication until Google confirms it.

Live checks still needed: notifications/sound delivery, draft/attachment preservation, reasoning-mode restoration, guarded retries and unknown outcomes, Goal pause/stop/limits and handoff/title acknowledgement against the current ChatGPT UI. Synthetic DOM/API checks do not replace these checks.
