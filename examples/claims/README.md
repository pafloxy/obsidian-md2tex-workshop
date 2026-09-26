# Six claims, six runnable notes

These notes are the smallest public demonstrations behind the six claims in the project README. Run every command from the repository root and keep generated evidence under `tmp/`.

| Claim | Demo | What to inspect |
| --- | --- | --- |
| Readable academic Markdown | [01-readable-academic-markdown.md](01-readable-academic-markdown.md) | Native headings, callouts, and top-level `align` math become numbered LaTeX objects with working references. |
| Local TeX/PDF with retained evidence | [02-local-tex-pdf.md](02-local-tex-pdf.md) | A successful attempt contains generated TeX, PDF, compiler log, source map, and result metadata. |
| Note-owned document recipe | [03-note-owned-recipe.md](03-note-owned-recipe.md) | YAML selects the preamble, BibTeX resource, and bibliography placement for this note. |
| Guarded TeX-to-Markdown recovery | [04-guarded-round-trip.md](04-guarded-round-trip.md) | Edit the named prose sentence in linked TeX, preview the exact Markdown candidate, then apply and rebuild. |
| Fast hidden-label entry | [05-label-shortcut.md](05-label-shortcut.md) | In Obsidian source mode, invoke the bundled label command, type one identifier, and build this note. |
| Exact TeX-owned blocks | [06-tex-owned-slot.md](06-tex-owned-slot.md) | Replace the indicated placeholder in linked TeX with the table, preview one stable Markdown pointer, apply, then rebuild. |

Build all six notes from the repository root:

```sh
node scripts/workshop.cjs build examples/claims/01-readable-academic-markdown.md --out-dir tmp/claim-demos
node scripts/workshop.cjs build examples/claims/02-local-tex-pdf.md --out-dir tmp/claim-demos
node scripts/workshop.cjs build examples/claims/03-note-owned-recipe.md --vault-root . --out-dir tmp/claim-demos
node scripts/workshop.cjs build examples/claims/04-guarded-round-trip.md --out-dir tmp/claim-demos
node scripts/workshop.cjs build examples/claims/05-label-shortcut.md --out-dir tmp/claim-demos
node scripts/workshop.cjs build examples/claims/06-tex-owned-slot.md --out-dir tmp/claim-demos
```

For the fourth and sixth demos, copy the note into a fresh directory before linking it to a TeX target. The full safe sequence is documented in [the linked-TeX guide](../../docs/linked-tex.md); Preview never authorizes Apply, and Apply never bypasses a stale or conflicting source.
