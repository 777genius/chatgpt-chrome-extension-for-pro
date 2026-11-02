# Journal feature

## Feature card

- Purpose: read the existing durable worker journal without introducing a second writer.
- Parent: none.
- Publishes: `chatgpt/journal/reader` r1 — for the journal UI.
- Consumes: `chatgpt/journal/transport` r1 — supplied by the Chrome page Host.
- Modules: `chatgpt/journal/reader/chrome` — delegates one read to the injected transport.
- Sub-features: none.
- Expected growth: none without a demonstrated need.
- Likely split seams: no split is currently justified.
- Split signals now: 1/12 modules, 0/20 use cases, depth 1/3, aggregates: none.

This static feature uses the public Get Modular Core + Assembly APIs with
explicit typed capabilities, the Resources scope for deterministic
run ownership, and Conformance tests. No privileged Chrome APIs or automatic
send permissions are available to its module factory. It does not cache,
migrate, or delete journal events. It is assembled only in the journal page's
on-demand read path, **not** in the MV3 service worker's synchronous startup.
