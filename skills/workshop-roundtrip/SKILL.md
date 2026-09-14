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
4. When the concrete change is accepted, pause editors/autosave for both
   sources. Apply using the matching `tex-target-apply INPUT --preview REPORT`
   or `tex-apply INPUT --preview REPORT` command. Freshness failures require a
   new preview. Never bypass them or use direct file copying as apply.
5. Read back the applied Markdown and backup evidence, then rebuild and verify
   the linked target if applicable. A successful apply is not the end of the
   cycle: confirm the next build includes the recovered edit and preserves
   labels, code and raw islands. Keep native editor apply disabled until its
   separate host-aware transaction is implemented and accepted.

For a disposable exercise, follow [the quickstart](../../examples/quickstart/README.md).
For simultaneous changes, expose the conflict before choosing `--prefer`;
that option is an explicit reconciliation choice, not an automatic repair.
