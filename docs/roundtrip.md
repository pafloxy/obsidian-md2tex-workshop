# Edit Markdown, visit TeX, return safely

This is a **standalone CLI prototype**, not a live Obsidian synchronizer. It adds an editing checkpoint, a reviewable reconciliation, and an explicit backed-up apply. It does not change the deployed plugin. In particular, the new raw-TeX fence is supported by this CLI, not the unchanged legacy converter.

The practical discipline is: keep Markdown as your usual editing surface, take a checkpoint before editing TeX, and return through a preview. Keep both files saved; pause editing/autosave during apply and reload the note afterward.

The [uniform authoring syntax](authoring.md) participates in the same workflow: heading/callout label comments belong to their enclosing block, new equations recover as `[!equation]` callouts, and references, citations and annotations recover as `[ref{...}]`, `[cite{...}]` and `[todo{...}]`. Unchanged blocks retain their exact Markdown bytes; a simple source edit can preserve formatting and comments. A structural inverse emits the canonical spelling only when it regenerates the edited TeX exactly. Ordinary Markdown-only comments that cannot be safely repositioned still stop recovery. Advanced TeX, including independently numbered `align` rows, remains a raw TeX fence when an exact structural representation is unavailable.

Checkpoint hashes deliberately reject a converter changed since checkout. This syntax update does not silently upgrade old sessions: finish them with their original converter or adapt a copy of the source and create a fresh checkpoint. There is no automatic note migration or live renderer change.

For a stable TeX filename shared with Obsidian, use the [linked-target workflow](linked-tex.md).
It retains these guards and adds target ownership/external-edit checks. Obsidian
can open its reverse candidate; editor-aware apply remains a separate milestone.

## Normal workflow

Run all commands from the `obsidian-md2tex-workshop` project root. Replace placeholder paths with actual files. Use `tmp/` for trials; for a real manuscript retain the editing bundle in a durable location you control. Nothing automatically cleans these directories.

1. Create a checkpoint using the same recipe you use for a normal build:

   ```sh
   node scripts/workshop.cjs tex-checkout ./path/to/draft.md --out-dir ./tmp/roundtrip-trial
   ```

   This must successfully build first. JSON `artifacts.tex` is the editable copy; `artifacts.session` identifies its checkpoint. Edit that copy, not an immutable build-attempt `main.tex`. Custom `--preamble`, `--engine`, `--bib`, `--bibliography`, and `--support` options work as in `build`; external converters cannot create checkpoints.

2. Edit the body of that TeX file. Keep the `% md2tex:...:begin/end` lines intact, in order, and on their own lines. Keep the empty line before each closing marker. Insert new content inside an existing marked block. To delete a block, remove its entire interior, leaving both markers. The markers are ordinary TeX comments under the supported standard tokenization.

3. Generate a preview; the original note is not changed:

   ```sh
   node scripts/workshop.cjs tex-sync ./path/from/artifacts.session
   ```

   Inspect `artifacts.candidate` and `artifacts.pdf`, plus the JSON `changes` and `diagnostics`. `artifacts.current` and `artifacts.edited` retain the two inputs. `status: success` and `outcome: ready` mean the candidate passed exact regenerated-TeX checks, a fresh build/final-log audit, and a final input freshness check. A failed preview may still contain a useful candidate and build diagnostics; it cannot authorize apply.

4. If both files changed the same region, default behavior is `EDIT_CONFLICT`. Inspect the preserved inputs and explicitly choose a side if appropriate:

   ```sh
   node scripts/workshop.cjs tex-sync ./path/to/session.json --prefer tex
   node scripts/workshop.cjs tex-sync ./path/to/session.json --prefer md
   ```

   Run **one** of these after choosing. The choice covers the whole conservative enclosing Markdown-edit region, which can include several blocks when you made several separated Markdown edits. It does not silently resolve conflicts word by word. Independent regions survive; identical changes can coalesce. If neither side is wholly right, reconcile manually in the editable copies and generate another preview. Markdown-only comments that cannot be safely repositioned still require manual attention; `--prefer` is not permission to drop them.

5. With editors paused, apply the particular successful preview to the explicitly named note:

   ```sh
   node scripts/workshop.cjs tex-apply ./path/to/draft.md --preview ./path/from/artifacts.report
   ```

   The command checks checkpoint identity, candidate/TeX/Markdown hashes, preview integrity, regenerated body, target file identity, and lock ownership. It creates a flushed `artifacts.backup`, then performs an atomic file replacement and readback. A changed note, TeX file, candidate, or checkpoint requires a new preview. Symlink paths, hard links and wrong targets are refused. The lock coordinates this CLI, **not an uncooperative external editor**; the last check and rename cannot form a transaction with that editor.

6. Reload the updated Markdown and continue writing. For the next TeX editing session, take a **new checkpoint**. Reuse your original recipe options for subsequent normal builds; CLI overrides are not injected into the original note's frontmatter. Retain the checkpoint and backups until you no longer need their provenance or frozen dependencies.

Completion: your updated note is the applied candidate, its backup exists, and it can begin another verified checkpoint cycle. No source is deleted as part of the workflow.

## What comes back as Markdown?

| Situation | Recovery policy |
| --- | --- |
| Generated block unchanged | Reuse original Markdown byte-for-byte, including comments, metadata spelling, callout aliases, whitespace and code-fence language. |
| A simple unambiguous text/math change | Try a source-preserving patch; accept it only if valid local Markdown regenerates exactly the edited block. |
| Newly added supported structure | Try headings, prose/emphasis, references/citations, theorem/proof callouts, nested lists and supported display environments. Each candidate must pass the same exact-output gate. |
| Custom commands/environments or an inverse that does not pass | Preserve the block in an explicit raw-TeX island; report `RAW_TEX_PRESERVED`. This is preservation, not a claim that the TeX became ordinary Markdown. |
| Uncertain Markdown-only information or damaged correspondence | Stop with a diagnostic and retain inputs. Do not infer which content is dispensable. |

Raw TeX islands use a pass-through fence, distinct from a literal code fence:

````markdown
```{=latex}
\begin{center}
\fbox{A hand-tuned TeX block}
\end{center}
```
````

Everything inside is sent to TeX unchanged; `%` is a TeX comment there. Fences are lengthened when their contents contain backticks. A normal ` ```tex ` fence remains **literal code**, not executable TeX. Plain Markdown references may point into raw islands; where declarations are opaque, their resolution is deferred to the final TeX log rather than guessed by scanning code-like text.

## Already edited an untracked TeX file?

Run from this project root:

```sh
node scripts/workshop.cjs tex-import ./path/to/existing.tex --out-dir ./tmp/tex-rescue
```

The importer preserves the complete `original.tex`, creates a **new** `candidate.md`, and, for a full document, saves its preamble and links it in the candidate's workshop metadata. It accepts a literal whole-line document begin/end pair, protecting supported verbatim regions and comments. It refuses ambiguous envelopes and active trailing content. For an actual body fragment, explicitly add `--body-only`; that candidate uses your chosen normal build recipe when you later build it.

Import does **not** compile or overwrite anything and its report cannot authorize `tex-apply`. Its result is `review-required`: original Markdown comments, frontmatter, aliases and edit history cannot be reconstructed without a checkpoint. Up to two terminal newlines may be added to frame the body; the report discloses this, and the complete original remains available. Generated candidates preserve all pre-existing body bytes through the exact-output gate, but may use canonical Markdown instead of prior authoring syntax.

Review the preamble and declare dependencies before building the candidate. Full-document import does not translate a manuscript's bibliography ownership into the CLI's bibliography policy, recursively stage included files, or infer engines/packages. Existing `\addbibresource`/`\bibliography` preamble commands can require manual recipe adaptation under the [CLI contract](cli.md).

## Safety boundaries and recovery

| Diagnostic / condition | Safe next action; preserved data |
| --- | --- |
| `EDIT_CONFLICT` | Inspect the preview's `current.md` and `edited.tex`; choose authority for the reported region or reconcile manually. Neither original changed. |
| `MD_ONLY_CONTENT` | Keep/reposition the original Markdown-only comments explicitly. Inputs and checkpoint retain them; no automatic lossy choice exists. |
| `MARKER_CHANGED`, `MARKER_IN_LITERAL`, `BLOCK_BOUNDARY_CHANGED`, `WRAPPER_CHANGED` | Restore marker order/spacing from the checkpoint or rescue the body separately. Keep an entire literal/verbatim environment inside one marked block. Preamble, bibliography tail and LF-to-CRLF changes are not body synchronization. |
| `RECIPE_CHANGED`, `DEPENDENCY_CHANGED`, `CONVERTER_CHANGED`, `BASELINE_CHANGED` | Inspect the changed frozen component; restore the intended checkpoint version or create a fresh checkpoint from reconciled source. Do not rewrite checksums to suppress the failure. |
| `UNTRACKED_RESOURCE` | Common literal file reads must name declared, staged basenames. Declare support/bibliography at checkout; do not use absolute paths to bypass the snapshot. |
| `UNSUPPORTED_TEX_TOKENIZATION` | Category-code/endline changes undermine the lexical/marker model. Keep that workflow TeX-native or isolate it manually. |
| `CANDIDATE_BUILD_FAILED` | Inspect `build.diagnostics`, `build.artifacts.log` and the preserved candidate. Fix the edited TeX/recipe and rerun preview. A previous successful build remains available. |
| `INCOMPLETE_TEX_STATE` in build diagnostics | TeX can exit zero and create a PDF while ending inside an unclosed group/conditional. Inspect the reported final log and matching opener; close the intended scope and make a fresh preview. |
| `STALE_PREVIEW`, `INVALID_PREVIEW` | Rerun `tex-sync`; modified candidates/reports are not certified merely because the earlier PDF exists. |
| `APPLY_BUSY`, unsafe target or interrupted apply | Inspect the lock's PID/target, the note, backup, pending candidate and application report. No automatic stale-lock removal or rollback exists. Do not delete a live lock. |

The prototype freezes declared dependency bytes and checks common literal resource reads. It is **not a general TeX sandbox or dependency interpreter**: macro-generated reads, changes in the installed TeX distribution, arbitrary macro expansion and external programs require separate trust/review. `-no-shell-escape` is used for builds, but trusted TeX and explicitly chosen executables are still code. No network fetcher, cloud conversion, installation, live settings mutation or dependency addition is part of this feature.

Reverse candidates are bounded: the forward converter accepts at most 4 MiB; source-patch search is limited to 64 candidates in blocks up to 64 KiB; structural inverse candidates are limited to 256 KiB and nesting depth 48. Larger/complex blocks use exact raw preservation when feasible, or an explicit diagnostic. Multi-edit reconciliation deliberately over-conflicts instead of using fuzzy source matching. New/reordered markers, automatic recipe migration, AST-granular simultaneous editing, portable asset export and live Obsidian controls are future work.

## Verification

Run from this project root:

```sh
node --test --test-isolation=none testing/cli.test.cjs testing/structural.test.cjs testing/roundtrip.test.cjs testing/syntax.test.cjs
```

Tests use real CLI processes and local TeX/BibTeX; all generated inputs, backups, malformed cases and PDFs stay under `tmp/`. See [architecture](architecture.md) for module boundaries. CLI verification does not establish native editor acceptance.
