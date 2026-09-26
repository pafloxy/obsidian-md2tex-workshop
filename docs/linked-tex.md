# Keep one TeX file for a Markdown note

A linked target keeps a chosen `.tex` path stable across successful builds. The CLI and Obsidian read the same link. Build attempts and PDFs remain isolated; the named TeX is an editable copy with a retained round-trip checkpoint.

This first version manages a **whole TeX document** produced by the structural converter. It does not adopt an existing manuscript or replace one section of a larger document. Existing TeX must first go through explicit import/reconciliation. An existing target or different dependency is never overwritten by linking.

## CLI workflow

Prepare the disposable copy using [the quickstart](../examples/quickstart/README.md) before these commands.

Run from the project root. Use your actual Markdown path and a **new** TeX path whose parent directory already exists. CLI paths are relative to the command's working directory; the Obsidian target field is relative to the selected note.

1. Set the persistent link once:

   ```sh
   node scripts/workshop.cjs tex-target tmp/quickstart/note.md --target tmp/quickstart/paper.tex
   node scripts/workshop.cjs tex-target-status tmp/quickstart/note.md
   ```

   Registration does not change Markdown text or generate TeX. Repeating the same registration is idempotent. A note cannot acquire a second target without an explicit unlink; two notes cannot claim the same new target.

2. Build normally, from either interface:

   ```sh
   node scripts/workshop.cjs build tmp/quickstart/note.md --out-dir tmp/linked-builds
   ```

   A successful build publishes to the same `paper.tex`, retaining previous bytes and a new checkpoint. An identical source/recipe leaves the target unchanged. A failed compilation never publishes. If TeX changed externally, the PDF build can still succeed while `result.target` reports a conflict and the target stays untouched. CLI `build` exits 1 for a target publication error; inspect both `status` and `target.status`. Worker results preserve the successful compiler status and display the publication warning separately.

3. Edit the named TeX within its marked body blocks. Keep marker lines, their separating blank lines and the document wrapper intact. Then preview:

   ```sh
   node scripts/workshop.cjs tex-target-sync tmp/quickstart/note.md
   ```

   The result identifies a new Markdown candidate, comparison inputs, compiled PDF and `artifacts.report`. Supported edits recover natively; exact raw-TeX preservation and conflicts use the existing [round-trip policy](roundtrip.md). Nothing is applied during preview. `--prefer md|tex` is an explicit conflict choice; it is never chosen automatically.

4. After reviewing the candidate, pause editors/autosave on **both** files and apply using the actual report path, from the project root:

   ```sh
   node scripts/workshop.cjs tex-target-apply tmp/quickstart/note.md --preview PATH_TO_PREVIEW_JSON
   ```

   This reuses the existing source/checkpoint/candidate/freshness guards and backup/readback behavior, then acknowledges the accepted TeX revision in the shared link state. Reload the Markdown, continue editing and build again to evolve the same TeX path. Direct `tex-apply` does not acknowledge a linked target; use `tex-target-apply` for this workflow.

   In Obsidian, choose **Preview TeX changes**, inspect the current and proposed Markdown, and press **Apply to Markdown** in that exact review tab. With no open Markdown view, the plugin uses a guarded vault compare-and-write. With exactly one open view, it checks the unchanged buffer, performs one whole-note editor transaction, requests a native save, and waits for bounded disk readback; the transaction remains available to native undo. Two or more views are refused. Any changed source, TeX, checkpoint, candidate, preview, link state, post-transaction editor change, unconfirmed persistence or mismatched readback prevents linked-state acknowledgement and requires inspection plus a fresh preview; the plugin never rolls back over later edits.

5. To stop publishing to the target, run from the project root:

   ```sh
   node scripts/workshop.cjs tex-target-unlink tmp/quickstart/note.md
   ```

   Unlink archives the binding and retains the TeX, dependencies and history. The old target remains claimed; this version does not provide automatic re-adoption or history deletion. Use a new target for a new binding.

## Native math and hybrid structured recovery

A complete top-level `equation`, `equation*`, `align`, or `align*` environment inserted inside one marked TeX block can recover as visible Markdown display math with the environment retained inside `$$` delimiters. Numbered `equation` and `align` blocks may retain `\label{...}` declarations; starred forms remain unnumbered and reject labels. A canonical generated `equation` can still recover as the simpler `[!equation]` callout. Preview accepts every candidate only when rebuilding its Markdown regenerates the edited environment exactly, so this native route preserves alignment tokens, label position, and numbering semantics without creating a TeX-owned slot.

A top-level `figure` or `table` can recover as a hybrid callout when it has a valid placement, a nonempty one-line trailing `\caption{...}`, a trailing `\label{...}` at the same indentation, and a nonempty body before those commands. The caption and label become ordinary editable Markdown; everything between the opening environment and caption remains exact TeX in one quoted `{=latex}` fence. This preserves `\includegraphics`, `minipage`, `tabular`, column specifications, spacing, and other body-level TeX without claiming to translate them.

````markdown
> [!figure|H] Gradient evidence.
> <!-- [label{fig:gradient-evidence}] -->
>
> ```{=latex}
>     \centering
>     \includegraphics[width=\linewidth]{figs/evidence.png}
> ```
````

Changing the callout title edits the TeX caption, changing the hidden label edits the TeX target ID, and changing the placement after the pipe edits the float placement. The nested fence is intentionally TeX-owned authoring text: keep the caption and label outside it. Multiline captions, missing labels, noncanonical command order, unsupported math environments, and other ambiguous structures fall back to a TeX-owned slot rather than being partially guessed.

## TeX-owned slots

When an edited whole marked top-level block cannot recover as ordinary Markdown, linked preview promotes it to a stable pointer such as `<!-- [tex-slot{slot-b0003}] -->`. The matching TeX bytes stay in the target's owned state and are emitted unchanged whenever the Markdown note is rebuilt. This is useful for a hand-tuned `table`, `figure`, or unsupported custom environment while the surrounding Markdown remains ordinary editable text.

The pointer is an integrity handle, not an editable copy of TeX. Do not delete it, duplicate it, invent a new ID, or move it relative to another slot. A linked build validates the complete ordered pointer set before target publication and refuses `TEX_SLOT_MISSING`, `DUPLICATE_TEX_SLOT`, `UNKNOWN_TEX_SLOT`, or `TEX_SLOT_REORDERED` with the existing target left intact. After a TeX-side slot edit, use Preview and Apply as usual; Apply updates the owned payload only after the normal candidate, freshness, backup, and readback checks pass.

Version 1 creates a slot only by replacing one existing marked top-level Markdown block during a linked TeX preview. It does not adopt an arbitrary existing TeX file, infer a new Markdown table or figure editor, permit a slot outside the managed target, or make the payload visible in ordinary Markdown. Use an explicit `{=latex}` fence instead when Markdown should continue to own the raw TeX text.

## Shared files and publication rules

```text
demo.md                         authoritative Markdown source
demo.md.workshop.json            relative target path and binding identity
paper.tex                       stable editable TeX
paper.tex.workshop/state.json    owner, generation, published hash, checkpoint
paper.tex.workshop/editing/...   frozen recipes, sessions, previews and backups
```

The link is independent of CLI/Obsidian output folders and private plugin settings. Obsidian refreshes it when selecting a note, opening the Workshop, completing a build, or observing sidecar/TeX events. It exposes **Set TeX target**, **Open linked TeX**, and **Preview TeX changes**. The preview requires a saved note and displays the current and proposed Markdown in a Workshop review tab with a separate **Apply to Markdown** action. It leaves the sealed candidate unopened as a Markdown file, so metadata-on-open plugins cannot silently invalidate it. A source change during preview requires a fresh preview. Generated candidates cannot take over the selected build source.

Declared support/bibliography files are copied beside the fixed TeX only when absent or byte-identical. Different existing files produce a conflict. This makes the tested declared-resource document compilable at its chosen path; it is not a general portable-export or figure-resolution feature. Macro-generated external reads remain outside dependency inference. No external resource is fetched.

Publication checks the link state, source ownership, current TeX hash and file identity again after preparing dependencies. It retains the previous TeX/state and a checkpoint before replacement. New-file creation refuses a file that appeared concurrently. Symlinked parents/targets and hard-linked files are refused. Existing-file replacement uses the same hash-check/atomic-rename discipline as the prior CLI apply. Arbitrary external TeX editors do not share the operation lock: pause TeX editing/autosave during publication and review/apply.

| Condition | What remains and how to proceed |
| --- | --- |
| `TARGET_EDITED` | Your TeX and successful build artifacts remain. Preview and reconcile before another publication. |
| `TARGET_EXISTS` / `TARGET_ALREADY_CLAIMED` | Existing TeX/history remains. Choose a new path or explicitly import/reconcile the old manuscript. |
| `TARGET_DEPENDENCY_CONFLICT` | Existing support file and target remain. Compare the declared dependency and reconcile the recipe separately. |
| `TARGET_STATE_CHANGED` / `TARGET_CHANGED_DURING_READ` | Another operation changed the inputs. Inspect status and retry once editing has stopped. |
| `TARGET_BUSY` | Inspect `operation.lock` and its PID. It may be an active operation or a hard-interrupted lock; no blind lock removal is implemented. |
| `CHECKPOINT_SOURCE_MOVED` | A moved pair retains its link but has an old source-path checkpoint. If TeX is unchanged, rebuild to create a current checkpoint; otherwise reconcile from the retained original state. |
| `STALE_PREVIEW` | Source, TeX, checkpoint or candidate changed. Make a fresh preview; do not edit checksums. |
| `MULTIPLE_EDITORS` | More than one Markdown view is open. Close the additional views, inspect the remaining buffer, and make a fresh preview. |
| `EDITOR_SAVE_REQUEST_FAILED` / `EDITOR_SAVE_TIMEOUT` / `EDITOR_CHANGED_AFTER_APPLY` / `APPLY_READBACK_FAILED` / `APPLY_READBACK_CHANGED` | The editor may contain the reviewed candidate, but persistence was not verified and linked TeX was not acknowledged. Inspect the editor, disk file and retained backup before making a fresh preview. |
| Publication/state-write interruption | Inspect the target, retained previous state/TeX and pending/checkpoint files. The next build stops on a hash mismatch; no blind rollback or automatic recovery is attempted. |

All link/history files are local and retained. No dependencies, provider calls, automatic note migration or renderer extension are introduced.
