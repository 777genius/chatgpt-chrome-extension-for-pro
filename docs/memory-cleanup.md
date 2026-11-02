# Chrome memory utility

A manual operator tool for an already running Chrome or Chromium browser. It inspects page JavaScript heaps and can request garbage collection. It does not kill processes, restart Chrome, close/reload/discard tabs, remove DOM content, or clear browsing data.

## Connect

Use Node.js 26+ from the repository root. The tool never enables remote debugging or changes browser settings.

```sh
# Inspect only; no garbage collection.
npm run memory -- --cdp http://127.0.0.1:9222

# Reuse an existing authenticated local bridge instead of opening a new CDP connection.
npm run memory -- --bridge-config /path/to/private/bridge.json
```

The bridge file must be private and contain its local `port` and `token`. Credentials are not printed or copied into reports. This authenticated bridge is separate from direct CDP: a direct loopback CDP endpoint does not necessarily authenticate clients or display an authorization prompt. Use an endpoint you already control and keep it local; the utility does not add authentication to it.

## Daily use on macOS

Two local `.command` shortcuts can reuse the same existing bridge:

- **Inspect Chrome memory** reads measurements and saves a report. It never collects memory.
- **Clean available Chrome memory** explicitly collects up to three measurable heaps, including active or generating pages. It also explicitly accepts that unreachable neighboring pages might share a measured heap, so their shared activity cannot be verified.

The shortcuts do not close or reload tabs and do not change debugging settings. They need Node.js 26+ and a running bridge; restarting Chrome or the bridge may require reconnecting it. Keep machine-specific launchers and the bridge file private, outside this repository. A help launch only prints options and does not connect or collect.

For a reusable private ledger shared by both shortcuts, use:

```sh
--state-dir "$HOME/.local/state/chatgpt-chrome-memory"
```

The final state directory must be owned by the current user with mode `0700`; its ledger, lock and full reports use `0600`. The default for direct CLI use remains `.chrome-memory` in the current directory.

## Collect

```sh
npm run memory -- --cdp http://127.0.0.1:9222 --collect --max-tabs 3

# Explicitly allow collection in active or generating pages.
npm run memory -- --cdp http://127.0.0.1:9222 --collect --include-active

# Restrict an operation to one target ID from the inspection report.
npm run memory -- --cdp http://127.0.0.1:9222 --collect --target TARGET_ID
```

Collection may briefly pause a page's JavaScript thread. By default, visible/focused or generating pages are skipped; a missing ChatGPT composer is treated as unknown activity, not proof that a tab is idle. `--include-active` is an explicit opt-in, not permission to bypass identity or measurement failures. Pages playing audio or video remain skipped.

`--max-tabs` limits the number of **shared JavaScript heaps** collected. Multiple tabs in one V8 isolate count once. All page targets participate in the peer census, including internal pages and blank pages; non-HTTP pages are never eligible for direct collection, and a known shared non-HTTP peer blocks its heap. An empty CDP target URL is accepted only when the page guard reports `about:blank`. Target URLs and every initially measured page's isolate identity are rechecked immediately before collection, including unselected peers. Each selected isolate receives one collection request; missing, changed or unmeasurable targets are skipped.

If unrelated pages cannot report their isolate identity, strict mode refuses collection: it cannot verify shared activity. To explicitly collect the measurable heaps anyway:

```sh
npm run memory -- --cdp http://127.0.0.1:9222 --collect --include-active --allow-unmeasured-peers
```

This mode does not directly collect unmeasurable targets, but they might share a measured heap. Shared activity is therefore unverified and is marked as such in the report. Selected-target identity failures, known unselected siblings, new targets and URL changes still block collection. This option is never enabled by default.

`--allow-unmeasured-peers` requires **both** `--collect` and `--include-active`. For example, one tested browser profile had eight pages that did not report their isolate identity: strict mode correctly collected nothing. With the combined explicit opt-in, a separate measured test page was collected once, its live data remained intact, and an immediate repeat was skipped by cooldown. This does not prove the eight pages are inactive or independently isolated.

The default minimum heap is 256 MiB and the successful-run cooldown is 10 minutes. An intent is saved before each request. An uncertain result is recorded and skipped on subsequent runs instead of being blindly retried. A state-directory lock prevents overlapping cleanup runs.

Cooldown timestamps reflect the actual completed operation, not the time a launcher was installed. A stale `intent` or `unknown` outcome remains blocked even after ten minutes. Do not delete the ledger or lock to force a repeat without first resolving the earlier operation.

Normal completion, lock setup failure, `SIGINT` and `SIGTERM` release only the lock file whose device/inode identity the process acquired. Termination preserves the ledger; an in-flight GC can therefore remain an unresolved intent. A crash, `SIGKILL` or machine shutdown can leave `lock.json` behind. There is no automatic stale-lock removal based on a PID: PIDs can be reused. For manual recovery, stop both shortcuts, inspect the private lock's `runId`, timestamp and PID, and verify that the original run has ended and no cleanup process is using that state directory. Preserve the lock and ledger as private recovery copies, then move only that verified stale lock out of the state directory. Keep the ledger in place and resolve any `intent`/`unknown` operation before considering further collection.

Use `--state-dir` for a dedicated private ledger/report directory. Reports may contain browsing URLs and titles; keep them out of Git and shared folders. The full option list is available with `npm run memory -- --help`.

## Reading the results

- **Used JS heap:** memory currently occupied by JavaScript objects.
- **Allocated JS heap:** memory reserved by V8, including space it can reuse.
- **DOM counts:** document nodes and event listeners, when available.
- **OS RSS:** not measured by this utility. It differs from JavaScript heap and Activity Monitor's memory footprint.

Garbage collection releases unreachable objects. It cannot remove live application history or guarantee that Chrome immediately returns physical memory to the OS. RSS can temporarily rise while collection touches compressed or paged-out memory. A negative JS-heap delta is not a claim of equivalent RAM savings.

The console summary reports how many unique heaps were collected, how many have comparable after-measurements, and signed changes in used and allocated JS bytes. Negative means less measured JS memory; a zero delta with zero after-measurements means no comparable result, not a measured saving of zero. Full reports include skipped targets and errors. They contain browsing metadata and should stay private.

The tool runs only on demand; it does not install a background cleanup service.

Protocol reference: [V8 isolate and heap measurements](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/), [garbage collection](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/).
