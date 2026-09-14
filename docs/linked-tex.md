# Keep one TeX file for a Markdown note

A linked target keeps a chosen `.tex` path stable across successful builds.
The CLI and Obsidian read the same link. Build attempts and PDFs remain isolated;
the named TeX is an editable copy with a retained round-trip checkpoint.

This first version manages a **whole TeX document** produced by the structural
converter. It does not adopt an existing manuscript or replace one section of a
larger document. Existing TeX must first go through explicit import/reconciliation.
An existing target or different dependency is never overwritten by linking.

## CLI workflow

Prepare the disposable copy using [the quickstart](../examples/quickstart/README.md) before these commands.

Run from the project root. Use your actual Markdown path and a **new** TeX path
whose parent directory already exists. CLI paths are relative to the command's
working directory; the Obsidian target field is relative to the selected note.

1. Set the persistent link once:

   ```sh
   node scripts/workshop.cjs tex-target tmp/quickstart/note.md --target tmp/quickstart/paper.tex
   node scripts/workshop.cjs tex-target-status tmp/quickstart/note.md
   ```

   Registration does not change Markdown text or generate TeX. Repeating the same
   registration is idempotent. A note cannot acquire a second target without an
   explicit unlink; two notes cannot claim the same new target.

2. Build normally, from either interface:

   ```sh
   node scripts/workshop.cjs build tmp/quickstart/note.md --out-dir tmp/linked-builds
   ```

   A successful build publishes to the same `paper.tex`, retaining previous bytes
   and a new checkpoint. An identical source/recipe leaves the target unchanged.
   A failed compilation never publishes. If TeX changed externally, the PDF build
   can still succeed while `result.target` reports a conflict and the target stays
   untouched. CLI `build` exits 1 for a target publication error; inspect both
   `status` and `target.status`. Worker results preserve the successful compiler
   status and display the publication warning separately.

3. Edit the named TeX within its marked body blocks. Keep marker lines, their
   separating blank lines and the document wrapper intact. Then preview:

   ```sh
   node scripts/workshop.cjs tex-target-sync tmp/quickstart/note.md
   ```

   The result identifies a new Markdown candidate, comparison inputs, compiled
   PDF and `artifacts.report`. Supported edits recover natively; exact raw-TeX
   preservation and conflicts use the existing [round-trip policy](roundtrip.md).
   Nothing is applied during preview. `--prefer md|tex` is an explicit conflict
   choice; it is never chosen automatically.

4. After reviewing the candidate, pause editors/autosave on **both** files and
   apply using the actual report path, from the project root:

   ```sh
   node scripts/workshop.cjs tex-target-apply tmp/quickstart/note.md --preview PATH_TO_PREVIEW_JSON
   ```

   This reuses the existing source/checkpoint/candidate/freshness guards and
   backup/readback behavior, then acknowledges the accepted TeX revision in the
   shared link state. Reload the Markdown, continue editing and build again to
   evolve the same TeX path. Direct `tex-apply` does not acknowledge a linked target;
   use `tex-target-apply` for this workflow.

5. To stop publishing to the target, run from the project root:

   ```sh
   node scripts/workshop.cjs tex-target-unlink tmp/quickstart/note.md
   ```

   Unlink archives the binding and retains the TeX, dependencies and history. The
   old target remains claimed; this version does not provide automatic re-adoption
   or history deletion. Use a new target for a new binding.

## Shared files and publication rules

```text
demo.md                         authoritative Markdown source
demo.md.workshop.json            relative target path and binding identity
paper.tex                       stable editable TeX
paper.tex.workshop/state.json    owner, generation, published hash, checkpoint
paper.tex.workshop/editing/...   frozen recipes, sessions, previews and backups
```

The link is independent of CLI/Obsidian output folders and private plugin settings.
Obsidian refreshes it when selecting a note, opening the Workshop, completing a
build, or observing sidecar/TeX events. It exposes **Set TeX target**, **Open linked
TeX**, and **Preview TeX changes**. The preview requires a saved note and displays
the current and proposed Markdown in a read-only Workshop tab. It leaves the
sealed candidate unopened as a Markdown file, so metadata-on-open plugins cannot
silently invalidate it. A source change during preview requires a fresh preview.
Generated candidates
cannot take over the selected build source. Applying into an open editor with undo
support remains M3; the current apply command requires paused editors.

Declared support/bibliography files are copied beside the fixed TeX only when
absent or byte-identical. Different existing files produce a conflict. This makes
the tested declared-resource document compilable at its chosen path; it is not a
general portable-export or figure-resolution feature. Macro-generated external
reads remain outside dependency inference. No external resource is fetched.

Publication checks the link state, source ownership, current TeX hash and file
identity again after preparing dependencies. It retains the previous TeX/state
and a checkpoint before replacement. New-file creation refuses a file that
appeared concurrently. Symlinked parents/targets and hard-linked files are refused.
Existing-file replacement uses the same hash-check/atomic-rename discipline as
the prior CLI apply. Arbitrary external editors do not share the operation lock:
pause TeX editing/autosave during publication and both editors during apply.

| Condition | What remains and how to proceed |
| --- | --- |
| `TARGET_EDITED` | Your TeX and successful build artifacts remain. Preview and reconcile before another publication. |
| `TARGET_EXISTS` / `TARGET_ALREADY_CLAIMED` | Existing TeX/history remains. Choose a new path or explicitly import/reconcile the old manuscript. |
| `TARGET_DEPENDENCY_CONFLICT` | Existing support file and target remain. Compare the declared dependency and reconcile the recipe separately. |
| `TARGET_STATE_CHANGED` / `TARGET_CHANGED_DURING_READ` | Another operation changed the inputs. Inspect status and retry once editing has stopped. |
| `TARGET_BUSY` | Inspect `operation.lock` and its PID. It may be an active operation or a hard-interrupted lock; no blind lock removal is implemented. |
| `CHECKPOINT_SOURCE_MOVED` | A moved pair retains its link but has an old source-path checkpoint. If TeX is unchanged, rebuild to create a current checkpoint; otherwise reconcile from the retained original state. |
| `STALE_PREVIEW` | Source, TeX, checkpoint or candidate changed. Make a fresh preview; do not edit checksums. |
| Publication/state-write interruption | Inspect the target, retained previous state/TeX and pending/checkpoint files. The next build stops on a hash mismatch; no blind rollback or automatic recovery is attempted. |

All link/history files are local and retained. No dependencies, provider calls,
automatic note migration or renderer extension are introduced.
