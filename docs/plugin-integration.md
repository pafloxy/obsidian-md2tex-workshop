# Plugin integration and packaging

The repository contains an experimental desktop adapter over the shared CLI
worker: captured editor snapshots, manual queue, optional automatic builds,
PDF/log tabs, fixed TeX targets and read-only reverse preview. Editor-aware
apply and managed AI repair are not implemented. See [linked TeX](linked-tex.md).

This source release supports CLI use. The complete-directory package below is
for controlled local development; standard Community Plugin distribution is
pending. See [release gates](releasing.md#obsidian-delivery-gate) and
[architecture](architecture.md). These instructions do not authorize changes to
an active vault or establish acceptance on your Obsidian version.

## Stage a complete package

Run from the project root, using an output directory that does not already exist:

```sh
node scripts/package-plugin.cjs --out-dir tmp/plugin-candidate
```

With no arguments, `npm run build` and `npm run dev` create a fresh
`tmp/plugin-packages/DDMMYYHHMM-UUID/` directory and print its path as JSON. `dev`
is a one-shot package command, not a watcher.

The package contains:

```text
main.js                       current Obsidian host
manifest.json / styles.css    existing plugin metadata and presentation
assets/                       legacy host assets
toolchain/scripts/workshop.cjs
toolchain/src/core/            shared compiler, recovery, job and contract modules
toolchain/src/obsidian/        modular host loaded by the thin main.js entry
toolchain/assets/             companion preamble and EPTCS support
toolchain/package.json        CommonJS companion metadata
workshop-package.json         file sizes, SHA-256 hashes and package identity
```

Packaging reads only the selected source/code/assets, uses no network and never
includes settings, source notes, credentials, runtime outputs or dependencies.
It rejects symlinks, non-regular members and existing output destinations.
Incomplete output from an I/O failure is retained; retry in a fresh directory.
The thin host entry uses Node `createRequire` at its installed path to load the
companion host modules, injecting Obsidian types at that seam. Compiler execution
stays in the external worker. No bundler or new dependency is needed for this
complete-directory delivery contract.

The complete directory is the installation unit for this personal workshop.
Uploading only `main.js` does not deliver its companion. Community distribution
and its provisioning mechanism are deferred. Runtime verification used the
installed Node v24.12.0 on Linux; other runtime/platform combinations need checks.

The GUI can resolve a different `node` from the terminal. On this machine,
Obsidian's default resolved to Node 12.22.9, which failed before the CLI started.
Set **Node executable** to the absolute path of the verified standalone Node
installation and save it through plugin settings; temporary runtime changes do
not survive reload. Startup failures now retain their stderr path and report
`TOOLCHAIN_START_FAILED` instead of hiding the cause behind a JSON parse error.

## Review and install into a scratch vault

Run from the project root:

```sh
node scripts/deploy-plugin.cjs --package tmp/plugin-candidate --target tmp/scratch-vault/.obsidian/plugins/md2tex-workshop
```

This prints a plan and creates nothing. It lists each managed file as `create`,
`replace` or `unchanged` and includes a `sha256` review token. There is no default
installation target. It does not read `data.json` or enumerate output history.

After reviewing the plan, run from the project root with its actual hash:

```sh
node scripts/deploy-plugin.cjs --package tmp/plugin-candidate --target tmp/scratch-vault/.obsidian/plugins/md2tex-workshop --apply --expect-plan PLAN_SHA256 --backup-dir tmp/plugin-install-backup
```

`PLAN_SHA256` is a required placeholder, not a valid token. Apply refuses changed
package/managed target bytes, overlapping directories, symlinks and existing
backup directories. It backs up every replaced file, copies only declared
members, verifies readback and records `installation.json` in the backup.
Unknown files, settings and old outputs are preserved. No files are deleted and
no plugin is enabled or reloaded. `npm run deploy -- ...` exposes the same command.

Installations are sequential file updates, not an atomic swap of the entire
plugin tree. Keep a real plugin unloaded/quiescent during a later agreed cutover;
the installer cannot lock external editors or Obsidian's loader. On interruption
or I/O failure, retain the report and backups, inspect `completed`, and compare
the current files before retrying or restoring. Automatic rollback is excluded
because it could overwrite later changes. A hard process termination can leave
a `prepared` report or owned `.pending` file; inspect actual hashes rather than
assuming the report proves completion. Obsolete unowned code files are retained;
removal/migration needs a separate reviewed change.

## Discover the companion

From the project root:

```sh
node scripts/workshop.cjs capabilities
node tmp/scratch-vault/.obsidian/plugins/md2tex-workshop/toolchain/scripts/workshop.cjs capabilities
```

Both return one `workshop-capabilities.v1` JSON object. `toolchainFingerprint`
hashes relative code/assets paths and bytes, so moving the complete package does
not change it. It is distinct from existing checkpoint converter hashes; their
guards remain unchanged. The command does not launch TeX, discover providers,
read settings or create artifacts.

The feature fields `editorSnapshotBuild`, `progressEvents` and `cancellation`
are **true**. `managedWorkerGroup` is true on Linux, the only currently supported
manual-host platform. `editorApply` and `managedRepair` remain **false**. The client
checks these worker capabilities and protocol version before dispatching a build,
and rejects a result whose toolchain fingerprint changed after negotiation.

The companion's default assets resolve relative to its installation. Always pass
the actual `--vault-root` when compiling from a packaged companion: the historical
CLI default is based on its checkout location, not Obsidian vault discovery.
An example from the project root, after creating a draft in the scratch vault:

```sh
node tmp/scratch-vault/.obsidian/plugins/md2tex-workshop/toolchain/scripts/workshop.cjs build tmp/scratch-vault/draft.md --vault-root tmp/scratch-vault --out-dir tmp/scratch-vault/output
```

## Manual host workflow

After a later agreed installation, use **Compile Selected Note to PDF** or the
Workshop's **Build** button. Pinning keeps the source note selected while another
note or PDF has focus. Build captures the selected note before opening the panel:
all open editors must agree; otherwise compilation stops with a conflict. With
no editor, the source store reads saved UTF-8 bytes. BOM and line endings are
preserved. Frontmatter and body come from this same snapshot; compilation never
saves or rewrites the note.

Only one job runs at a time. M2 preserves additional manual requests in a FIFO
queue (maximum 32 pending). Queued requests capture the latest source when they
start. Manual work runs before a due automatic follow-up.
Automatic builds are off by default; explicitly enable the new setting to debounce
editor/saved changes to the selected or pinned note for 600 ms. Repeated events
coalesce, and an identical captured source/configuration skips duplicate automatic
work. Disabling the setting clears pending automatic work; an active job can be
stopped with Cancel. **Cancel** clears the queue/timer and requests worker shutdown, remaining busy
until the owned job ends. Renames/deletions cancel work for the old identity.
Target switches discard obsolete automatic work while preserving manual requests. An earlier result stays attached to its original note.
The panel shows the first diagnostic, its mapped source location when available,
and an on-demand compiler log. Source navigation rechecks freshness and refuses
old line numbers. Generated TeX locations are identified as TeX locations.

The Workshop's **PDF** and **Compiler log** tabs share an embedded output area.
PDF is selected initially. Switching tabs preserves the native PDF renderer,
including its zoom and scroll position. A new successful build replaces the PDF;
an in-progress or failed build keeps the last successful PDF with the existing
freshness message. The log tab shows the selected note's latest attempt and
refreshes when that attempt changes. Preflight failures show diagnostics when no
compiler log exists. Delayed loads cannot replace another note's output.

**Open PDF** still opens the most recent successful PDF in a separate native tab,
including after a later failed build. An unchecked or edited source is marked
stale. **Open generated TeX** opens the latest generated TeX through the desktop
file association, falling back to the last successful attempt when the latest
attempt produced none. These are explicit actions; builds do not replace a PDF
viewer. Closing the Workshop panel removes its subscription while an ongoing
build continues. Plugin unload cancels active/background workers and suppresses
late view updates.

The stable plugin ID, view ID and old open/compile/rebuild/PDF command IDs are
retained. Rebuild creates a fresh attempt; it deletes no prior output. The old
agent command explains that assistance is off. Legacy Save As dialogs, preview
layout modes and automatic agent handoff are outside M1; generated artifact paths
remain available. Existing settings keys are preserved on load with **no settings
write or automatic migration**. Legacy auto-build/AI flags have no dispatch path
in the new host, even when their stored values are true.

| Host setting | Default and interpretation |
| --- | --- |
| `autoBuildEnabled` | `false`; explicit opt-in to automatic builds of the selected/pinned note. Legacy `autoCompile` is ignored. |
| `buildDebounceMs` | 600; integer 100–5000, validated at load. |
| `nodeCommand` | `node`; use a standalone Node executable available to the GUI, or an absolute path. Never assume Obsidian's `process.execPath` is Node. |
| `latexmkCommand` | `latexmk`; command or absolute executable path, passed without a shell. |
| `outputFolder` | `md2tex-workshop-output`; a normal vault-relative folder, outside `.obsidian`. Earlier output folders are retained. |
| `buildTimeoutMs` | 30000; integer 100–300000. Worker total deadline adds 5000 ms for preparation/publication, then allows a 1500 ms termination grace period plus at most 1000 ms to confirm process-group exit. |
| `engineOverride` | Control fallback when the note omits its engine; optional `pdflatex`, `xelatex`, `lualatex`. Empty uses the bundled default. |
| `preambleOverride` | Control fallback when the note omits its preamble; optional absolute or vault-relative path. Empty uses the basic article default. |

The source store, controller, worker client, view and host wiring have separate
interfaces under `src/obsidian/`. The host exposes reverse preview without source apply or provider dispatch.
`src/obsidian/scheduler.cjs` owns queue/debounce policy, and `src/core/targets.cjs`
owns shared TeX links and guarded publication.
`src/obsidian/output-tabs.cjs` owns output selection, artifact identity and async
cleanup. `src/obsidian/pdf-embed.cjs` isolates the native interactive PDF factory.
The public Markdown-rendering helper uses a static display mode; it is unsuitable
for this scrolling viewer. The native factory is capability-checked and tested on
desktop Obsidian 1.13.7. If unavailable in another version, the pane shows a clear
message and retains **Open PDF**. No PDF library or global renderer is installed.
Reverse preview displays current/proposed source in a read-only native Workshop
tab, preserving the sealed candidate from metadata-on-open Markdown plugins.
Source changes during preview still require a fresh preview. Applying through an
open editor remains M3. Plugin load refreshes only its own companion module cache,
so a native reload can load newly installed code without restarting Obsidian.
The bundled companion resolves its assets relative to installation and receives
an explicit vault root. The shared core uses a basic article default; YAML
preamble, bibliography and engine fields take priority over control fallbacks.
The summary shows the last build's resolved settings and their origins. The
broader EPTCS preamble remains explicitly selectable. Bibliography syntax is
compiled by the core; the adapter adds no Markdown renderer.

## Worker execution and retained evidence

Run from the project root with an existing validated request JSON:

```sh
node scripts/workshop.cjs worker tmp/request.json
```

This command emits NDJSON progress followed by one final result; exit status is
0 for success, 1 for a failed build. Ordinary CLI commands retain their single
JSON result. The programmatic desktop client creates request JSON itself under
`OUTPUT/.jobs/`, validates every response's note/job/source identity, and enforces
monotonic progress and final-frame ownership. Requests retain the exact note
text locally. Capability/status requests also retain transport directories.
There is no automatic retention cleanup in M1.

The worker uses the canonical source path for the existing document namespace,
source maps, history and relative dependencies. A temporary request filename
never becomes the source identity. Snapshots, TeX, logs and PDF stay in fresh
per-document attempts. A failed attempt never replaces `last-success.json`.

The Linux desktop client launches one detached worker group. TeX descendants
inherit that group. `--managed-group` is internal to this client; the worker
verifies that it leads the process group before enabling group signals. Do not
add that flag to the ordinary terminal command above. Cancellation, output
limits, timeouts, hard worker death and unload terminate the owned group;
malformed responses are never published. Transport limits are 4 MiB stdout and
128 KiB stderr. The panel reads at most 1 MiB of a retained compiler log.

For an abnormal worker exit, `termination.json` records the failure and any lock
recovery. Recovery releases only a matching source/job/PID lock after proving
the worker and non-zombie group members are gone; it checks the lock inode again
before removal. A foreign lock is retained. This containment covers ordinary
inherited subprocesses, not an arbitrary executable deliberately creating a new
session or process group. Configured tools remain trusted local executables.

## Versioned data contracts

[protocol.cjs](../src/core/protocol.cjs) exports pure validators for
`workshop-worker.v1`. They return immutable copies of accepted JSON data and
perform no file writes, builds, model calls or source acceptance.

| Contract | Required ownership and scope |
| --- | --- |
| Build request | Job ID; canonical absolute source path and its SHA-256 document ID; exact text/hash; editor or disk origin; editor revision; explicit vault/output roots; bounded execution and recipe overrides. Cached frontmatter is not accepted separately. |
| Progress | Matching job/document/source identity, stage and nonnegative sequence. The client enforces increasing sequence numbers and rejects frames after completion. |
| Result | Matching owner, recipe/toolchain fingerprints and the existing core result. Recipe hash may be null on configuration failure. Successful results require source provenance; an optional previous successful result must belong to the same canonical note. |
| Repair context | Captured failure/job/source/recipe/toolchain identities, diagnostic, one rule, prompt version and bounded named source regions. |
| Repair proposal | Matching context identities; `candidate`, `no-fix` or `needs-human`; exact `before`/`after` edits confined to allowed region IDs. No file paths or executable commands. |

Request fixtures use normalized absolute paths for the first verified Linux
runtime. Canonical document identity is independent of temporary input filenames.
Source hashing preserves UTF-8 content, BOM and CRLF rather than normalizing the
note. Malformed Unicode is rejected before source/proposal acceptance, since
unpaired surrogates cannot round-trip through UTF-8 without replacement. The
source limit is 1 MiB; repair context is at most 48 KiB, up to eight
regions of at most 8 KiB each. Proposals are at most 16 KiB, with up to four edits
and a combined before/after budget of 4096 bytes. These limits are implemented
contract limits, not measured recommendations for a model's token budget.

The conservative first proposal format permits at most one edit per region and
requires exactly one occurrence of nonempty `before` text. A future context
builder must bind regions to actual source spans and reject overlapping ranges.
It must also enforce diagnostic/rule eligibility and mathematical preservation.
Passing these validators establishes data shape and ownership only; it does not
prove a correction is valid or authorize application. Isolated candidate builds,
provider routing and reviewed editor acceptance remain future work.

Fixtures: [build request](../testing/fixtures/protocol/build-request.json),
[repair context](../testing/fixtures/protocol/repair-context.json),
[repair proposal](../testing/fixtures/protocol/repair-proposal.json).

## Failures and verification

| Diagnostic | Next action |
| --- | --- |
| `DESTINATION_EXISTS` | Keep the earlier package/backup and choose a fresh directory. |
| `PACKAGE_CHANGED` / `INCOMPLETE_PACKAGE` | Repackage from the reviewed source; do not bypass inventory validation. |
| `REVIEW_REQUIRED` / `STALE_INSTALL_PLAN` | Inspect a fresh read-only plan and use its exact hash. No installation starts on these preflight failures. |
| `SYMLINK_REFUSED` / `OVERLAPPING_DIRECTORIES` | Use explicit real paths with separate package, target and backup directories. |
| `INSTALL_READBACK_FAILED` or installation I/O failure | Inspect the retained installation report/backups and current files; do not assume an automatic rollback. |
| `PROTOCOL_VERSION_MISMATCH` / `PROTOCOL_OWNER_MISMATCH` | Negotiate supported versions or recapture the intended job; never relabel a stale response as current. |
| `SOURCE_HASH_MISMATCH` / `PROTOCOL_LIMIT` | Recapture exact source bytes or reduce the request; do not truncate a note silently. |
| `INVALID_UNICODE` / `INVALID_UTF8` | Correct malformed input; it is refused rather than silently rewritten. |
| `CONFLICTING_EDITORS` / `SOURCE_MOVED` | Resolve differing views or recapture the renamed note, then build again. No source was saved. |
| `NODE_UNAVAILABLE` / `TOOLCHAIN_INCOMPATIBLE` | Check the configured standalone Node and complete companion package. No TeX job was dispatched. |
| `BUILD_BUSY` / `BUILD_CANCELLED` | Wait for completion or cancellation, then explicitly build the intended revision. |
| `WORKER_TIMEOUT` / `WORKER_OUTPUT_LIMIT` / `WORKER_PROTOCOL` / `WORKER_CLEANUP_INCOMPLETE` | Inspect the retained `.jobs/` stdout/stderr and termination record. Check tool/runtime configuration before retrying. |
| PDF exists but is not indexed | Retry Open PDF after native indexing; the host does not rewrite the PDF to force discovery. |

Run from the project root:

```sh
node --test --test-isolation=none testing/worker.test.cjs testing/obsidian-state.test.cjs testing/obsidian-host.test.cjs
node --test --test-isolation=none testing/*.test.cjs
```

Tests cover source/metadata parity, conflicting editors, late history/results,
note switches, unload, real worker cancellation and hard death, protocol/limit
failures, packaging guards and full CLI round trips. A relocated packaged entry
runs against injected host interfaces and produces a real PDF with resolved
references. This verifies requested native-open calls, not actual Obsidian rendering,
indexing latency or GUI runtime compatibility. No real AI provider is called.
