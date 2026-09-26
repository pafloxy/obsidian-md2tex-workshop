---
name: workshop-roundtrip
description: Review TeX edits for recovery into Markdown using Workshop checkpoints or persistent TeX targets, including stale previews and concurrent edits. Use when preserving both sources matters; ordinary compilation uses workshop-compile.
---

# Recover a reviewed TeX change

1. Identify whether the note has a persistent target. Read
   [linked targets](../../docs/linked-tex.md) or
   [standalone checkpoints](../../docs/roundtrip.md) for the matching route.
   Inspect the actual saved Markdown/TeX and state before advancing a demo.
2. For a linked note, run `tex-target-status INPUT` through the checkout's
   `scripts/workshop.cjs`, from the intended working directory. Retain external
   edits, ownership state and backups. Existing manuscripts are not silently
   adopted, and unlinking does not release a claimed target for reuse.
3. Prepare `tex-target-sync INPUT` or `tex-sync SESSION`. Review the returned
   candidate and report; compare the proposed Markdown with the current source.
   Inspect the candidate PDF. Do not modify sealed candidate files or hashes.
   YAML paths in a preview use the checkpoint's frozen recipe; every field in
   `profile.origins` reports `checkpoint`. A changed live resource must not replace
   that snapshot. Resolve `RECIPE_CHANGED` with a new checkpoint after reconciling
   the recipe. Move explicit printing within marked body blocks; switch between
   automatic and explicit placement in Markdown before a new checkpoint.
4. When the concrete change is accepted, keep TeX editing/autosave paused. In Obsidian, press **Apply to Markdown** in the exact review tab; zero open Markdown views use a guarded vault write, exactly one uses one editor transaction plus a public save request and bounded disk readback, and multiple views are refused. For CLI-only work, pause both editors and use the matching `tex-target-apply INPUT --preview REPORT` or `tex-apply INPUT --preview REPORT` command. Freshness failures require a new preview. Never bypass them or use direct file copying as apply.
5. Read back the applied Markdown and backup evidence, then rebuild and verify
   the linked target if applicable. A successful apply is not the end of the
   cycle: confirm the next build includes the recovered edit and preserves
   labels, code and raw islands. If save, readback or linked-state finalization fails after the editor changes, inspect the editor, disk file and backup; never force an automatic rollback over later edits.

For a linked preview, an unsupported whole top-level TeX block can become a TeX-owned `<!-- [tex-slot{slot-...}] -->` pointer. Treat that pointer as an integrity handle: its payload remains in owned target state, and missing, duplicate, foreign, or reordered IDs must be left as a refused build rather than repaired by copying TeX into Markdown. An explicit `{=latex}` fence remains the Markdown-owned option.

For a disposable exercise, follow [the quickstart](../../examples/quickstart/README.md). For simultaneous changes, expose the conflict before choosing `--prefer`; that option is an explicit reconciliation choice, not an automatic repair.
