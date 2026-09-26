# md2tex Workshop

md2tex Workshop is a desktop Obsidian plugin for academic notes that keeps Markdown as the editable source, compiles it locally to LaTeX and PDF, shows the PDF and compiler evidence beside the note, and lets selected edits from a linked TeX file return through an explicit guarded review.

The distinctive workflow is a controlled round trip rather than a one-way export:

```text
Markdown note → generated TeX → PDF
      ▲              │
      └── reviewed TeX edits ── Preview → Apply
```

Version 0.1.2 is a Linux-first beta candidate. The three-file BRAT package and native Obsidian workflow are implemented and locally verified; publishing the matching GitHub release is a separate release action. The CLI remains available for reproducible builds and diagnostics outside Obsidian.

## Five claims, five demos

| Main claim | What the plugin does | Runnable Markdown demo |
| --- | --- | --- |
| **Write readable academic Markdown.** | Native headings and callouts become sections, theorem-like objects, equations, labels, and references in LaTeX/PDF. | [Readable academic Markdown](examples/claims/01-readable-academic-markdown.md) |
| **Keep TeX, PDF, and diagnostics local and inspectable.** | Every build creates a fresh retained attempt containing generated TeX, PDF, compiler log, source map, configuration, and result metadata; a failure does not replace the last successful PDF. | [Local TeX and PDF](examples/claims/02-local-tex-pdf.md) |
| **Let each note own its document recipe.** | YAML can select the preamble, engine, bibliography backend, bibliography files, and explicit bibliography position, with recorded setting origins. | [Note-owned recipe](examples/claims/03-note-owned-recipe.md) |
| **Bring selected TeX edits back without silently overwriting Markdown.** | A persistent linked TeX target uses anchored checkpoints, a read-only Preview, a separate Apply gesture, backups, exact freshness checks, conflict refusal, native editor save, and disk readback before acknowledgement. | [Guarded round trip](examples/claims/04-guarded-round-trip.md) |
| **Add supported labels without leaving the Markdown editor.** | A command and bundled `Mod+Shift+L` hotkey insert a hidden label comment and place the caret inside the identifier braces. | [Label shortcut](examples/claims/05-label-shortcut.md) |

The [claim-demo index](examples/claims/README.md) gives repository-root commands for building all five notes.

## Install with BRAT

The current [BRAT release workflow](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md) installs `main.js`, `manifest.json`, and `styles.css` from a matching GitHub release. After the `0.1.2` release is published with those three assets:

1. In Obsidian, install and enable **BRAT** from **Settings → Community plugins**. Use BRAT 1.1.0 or newer for the release-based workflow.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Enter `https://github.com/pafloxy/obsidian-md2tex-workshop`.
4. Track the latest release or freeze the installation to `0.1.2`.
5. Enable **md2tex Workshop** under **Settings → Community plugins**.
6. Open **md2tex Workshop settings** and set **Node executable** to a standalone Node.js 24 executable visible to Obsidian. Keep `latexmk` or set its absolute path when the GUI does not inherit your shell `PATH`.

BRAT installation requires the matching GitHub release; cloning the repository alone does not make a BRAT-installable beta. The release tag and the `version` inside the released `manifest.json` must both be `0.1.2`.

## Prerequisites and tested platform

- Desktop Obsidian; the manifest minimum is 1.7.2, while native acceptance for this beta was performed on Obsidian 1.13.7.
- Linux is the verified host platform for managed worker-group cancellation and the complete native workflow. Other desktop platforms require their own acceptance run.
- Node.js 24 or newer as an external executable. No npm runtime packages are installed.
- A local TeX installation with `latexmk`, a supported engine (`pdflatex`, `xelatex`, or `lualatex`), and the packages used by the selected preamble. BibTeX or Biber is required only when the note selects that backend.

The BRAT loader restores the bundled compiler/runtime beneath the plugin directory and verifies every restored file before loading it. It downloads no additional executable code and installs no npm packages. Node and the TeX toolchain remain user-owned system prerequisites.

## First build in Obsidian

1. Open one of the [claim demos](examples/claims/README.md) in an isolated test vault, or create a Markdown note using the supported authoring subset.
2. Open the command palette and run **md2tex Workshop: Open md2tex Workshop**.
3. Select the Markdown note and press **Build**. Automatic builds are off by default.
4. Keep the note and Workshop pane side by side. The **PDF** tab shows the newest successful PDF; **Compiler log** shows the current attempt. A later failure keeps the previous PDF with a stale-revision message.
5. Expand **Build and TeX controls** to open the PDF externally, open or copy generated TeX, pin the note, cancel work, or configure a linked TeX target.

Builds capture the open editor snapshot without saving or rewriting the note. If multiple editors disagree about the same note, the build refuses rather than choosing one.

## Guarded Markdown–TeX round trip

Use [04-guarded-round-trip.md](examples/claims/04-guarded-round-trip.md) for the smallest complete exercise.

1. In **Build and TeX controls**, enter a new `.tex` path relative to the note and choose **Use this target**. Existing or already claimed TeX files are not adopted or overwritten.
2. Build the Markdown note. Workshop publishes an anchored TeX checkpoint to the named target while keeping ordinary build attempts separate.
3. Edit prose inside the generated marker boundaries in the linked TeX file. Do not change anchors, the document wrapper, or frozen recipe files.
4. Return to Obsidian and choose **Preview TeX changes**. Workshop validates the checkpoint, compiles the proposed candidate, and opens a native review tab showing the current and proposed Markdown. Preview never writes the note.
5. Inspect the complete candidate and choose **Apply to Markdown** only if it is correct. With one open Markdown view, Workshop uses one undoable editor transaction, requests a native save, reads the persisted bytes back, and acknowledges the linked target only after the exact candidate hash matches. A closed note uses a guarded vault write; multiple views of the same note are refused.
6. Build once more from Markdown. This confirms the recovered edit and creates the checkpoint for the next TeX editing round.

The round trip intentionally handles a bounded TeX subset, not arbitrary collaborator-written LaTeX. Concurrent edits to the same anchored region produce `EDIT_CONFLICT`; changed markers, wrappers, recipes, dependencies, stale previews, and ambiguous inverses are refused with both sources preserved. See [linked targets](docs/linked-tex.md) and [round-trip guarantees](docs/roundtrip.md).

## Authoring subset

Workshop supports ordinary prose, headings, lists, literal code, inline/display mathematics, theorem-like Obsidian callouts, proof callouts, equation callouts, hidden labels, references, citations, bibliography placement, and explicit raw-TeX fences. For example:

```markdown
# A useful identity
<!-- [label{sec:identity}] -->

> [!lemma] Nonnegative square
> <!-- [label{lem:square}] -->
> For real $x$, the value $x^2$ is nonnegative.

> [!equation]
> <!-- [label{eq:square}] -->
> $$
> q(x)=x^2
> $$

See [ref{lem:square}] and [ref{eq:square}].
```

Plain `$$` displays remain unnumbered. Images, tables, note transclusion, arbitrary Markdown extensions, arbitrary TeX restructuring, and whole existing-manuscript adoption are not implemented. Unsupported images produce `UNSUPPORTED_IMAGE` rather than disappearing. Read the complete [authoring contract](docs/authoring.md).

### Insert a hidden label quickly

In a Markdown editor, run **md2tex Workshop: Insert Label Metadata** from the command palette or press `Mod+Shift+L`. It inserts `<!-- [label{}] -->` at the cursor and leaves the cursor inside `{}`; type a nonempty identifier such as `lem:nonnegative-square`. `Mod` means Ctrl on Linux/Windows and Command on macOS. The shortcut is bundled but can be changed or removed in **Settings → Hotkeys**. Put the completed comment immediately below a heading or as a callout's first nonblank body line, as required by the [authoring contract](docs/authoring.md#commands-and-ordinary-viewers). The command does not infer an identifier, validate it as you type, or attach it to arbitrary Markdown positions. Open the [label-shortcut demo](examples/claims/05-label-shortcut.md) for a one-minute exercise.

## Note-owned compilation settings

YAML settings override plugin or CLI fallback controls. With no preamble selection, Workshop uses its bundled basic article recipe.

```yaml
---
tex-workshop-preamble: preambles/article.tex
tex-workshop-bibs:
  - references/main.bib
tex-workshop-bibliography: bibtex
---
```

These fields contain local paths, not embedded TeX or BibTeX contents. `[printbibliography]` chooses one explicit top-level bibliography position; omitting it keeps automatic end placement. Recipe bytes are frozen into linked checkpoints, so recipe edits require reconciliation and a fresh checkpoint. See [the bibliography example](examples/bibliography/README.md) and [CLI metadata reference](docs/cli.md#note-metadata).

## CLI quick start

The CLI is useful for automation, detailed status inspection, and reproducing a plugin build. Run these commands from the repository root:

```sh
node --version
node scripts/workshop.cjs doctor
node scripts/workshop.cjs build examples/quickstart/note.md --out-dir tmp/quickstart-builds
node scripts/workshop.cjs status examples/quickstart/note.md --out-dir tmp/quickstart-builds
```

`doctor` is read-only and checks executable readiness, not every TeX package. A successful build returns paths under `artifacts`, including the PDF, TeX, log, source map, and retained result. There is no destructive clean command. The [CLI guide](docs/cli.md) documents every command and exit contract.

## Failures and safe recovery

| Symptom | Meaning and safe next action | Preserved evidence |
| --- | --- | --- |
| `TOOLCHAIN_START_FAILED` or no valid worker response | The configured Node executable could not run the bundled worker. Check the retained stderr path and configure a verified standalone Node 24 executable; retry is safe after correcting the executable. | Note, settings, job directory, and stderr remain. |
| Missing `latexmk`, engine, BibTeX, or package | Tool discovery or TeX compilation failed after source capture. Inspect **Details and diagnostics** and the compiler log; install or select tools only with your own system authorization. | Source snapshot, configuration, diagnostics, log, and previous successful PDF remain. |
| `TARGET_EDITED` | The linked TeX changed after its checkpoint or during publication. Preview/reconcile it; do not repeatedly rebuild over the target. | Markdown, linked TeX, checkpoints, and build attempt remain. |
| `EDIT_CONFLICT` | Markdown and TeX changed the same conservative region. Inspect the retained current Markdown and edited TeX, then choose authority explicitly or reconcile manually. | Neither source is overwritten. |
| `STALE_PREVIEW`, `EDITOR_CHANGED_AFTER_APPLY`, or save/readback refusal | An input changed or exact native persistence could not be proved. Inspect the editor, disk note, preview, permit, and backup; request a fresh preview. Never force an automatic rollback over later edits. | Candidate, original backup, application metadata, and both sources remain. |
| `RUNTIME_INTEGRITY` | The self-restored bundled runtime is incomplete or changed. Disable the plugin, preserve and move the named runtime directory aside, then re-enable to restore a fresh copy. | The suspect runtime is retained for inspection; notes and settings are untouched. |

The [CLI diagnostics matrix](docs/cli.md#failure-and-recovery) and [plugin integration guide](docs/plugin-integration.md#failures-and-verification) cover the complete stable error set.

## Privacy and trust boundary

Ordinary compilation and round-trip operations run local programs and make no intentional network or model-provider request. TeX shell escape is disabled. Source snapshots, build attempts, logs, backups, linked checkpoints, and local paths are retained on disk; keep them out of public repositories when they contain private material.

Node, TeX, custom converters, raw TeX, and any manually configured agent executable remain trusted local code. This plugin is not an untrusted-document sandbox. Agent explanation is not automatically configured or invoked by the plugin, and managed source repair remains unavailable.

## Release and verification status

The v0.1.2 candidate consists of exactly `main.js`, `manifest.json`, and `styles.css`. Packaging restores a hash-verified bundled runtime on first load. Automated checks cover deterministic packaging, relocated loading, runtime tamper refusal, editor snapshot builds, native-write guards, linked targets, round trips, PDF/log state, and CLI behavior. A disposable Linux vault running Obsidian 1.13.7 has exercised package loading, command registration, PDF/log output, the exact Preview → Apply → disk-readback → guarded-finalize path, and the required post-Apply rebuild. The label shortcut has packaged-host coverage; live shortcut delivery in a new native release candidate is verified separately below.

These results do not establish behavior on every Obsidian, operating-system, Node, or TeX version. Hosted BRAT download is established only after the matching GitHub release exists and is installed through BRAT; local packaging or direct installation alone does not prove that hosted path.

## Development

From the repository root:

```sh
npm run test:fast
npm test
node scripts/package-plugin.cjs --format brat --out-dir tmp/brat-candidate
node scripts/public-release.cjs export --out-dir tmp/public-candidate
node scripts/public-release.cjs verify --out-dir tmp/public-candidate
```

The full suite additionally needs Python 3, TeX/BibTeX, and Poppler. The optional Biber case is disabled unless explicitly enabled. Read [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), [BRAT packaging](docs/brat.md), and [release maintenance](docs/releasing.md) before changing release boundaries.

## License

Project-owned source, documentation, and skills are Copyright 2026 Rajarsi and licensed under [Apache-2.0](LICENSE). Bundled EPTCS assets retain their own licenses and attribution; see [third-party notices](THIRD_PARTY_NOTICES.md).
