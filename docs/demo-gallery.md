# Illustrated feature demos

[Back to the README](../README.md#watch-individual-features).

The README now leads with two real recorded demos. This separate gallery retains the earlier combined illustration and six complementary clips recovered from the September 2026 publication bundle. These are explanatory animations, not screen recordings.

These clips explain the intended workflow. They are source-grounded **illustrations**, not recordings of a running Obsidian session, test results, or proof of installation. Exact layouts may differ.

| Demo | What to watch for | Runnable source |
| --- | --- | --- |
| [Preserve exact TeX through Markdown edits (66 s)](assets/demos/tex-owned-island.gif) | Promote a noncanonical table to a managed TeX-owned slot, review the generated pointer, then edit surrounding Markdown and rebuild without changing the TeX body. The pointer is not self-contained: retain the linked target state. | [Example](../examples/claims/06-tex-owned-slot.md) |
| [Build academic Markdown into a local PDF (20 s)](assets/demos/basic-build.gif) | Start with readable prose, labels and equations, build with the local TeX toolchain, and inspect the PDF beside the source. | [Example](../examples/claims/02-local-tex-pdf.md) |
| [Edit a supported table from either side (46 s)](assets/demos/native-table.gif) | Change a canonical simple-table cell in TeX, preview and apply the Markdown patch, then edit a Markdown cell and build back to TeX. Complex tables are not automatically converted to grids. | [Example](../examples/claims/07-native-structured-roundtrip.md) |
| [Keep aligned equations editable (33 s)](assets/demos/native-align.gif) | Recover a complete supported align environment as visible Markdown math while preserving its label, after Preview and Apply. | [Example](../examples/claims/07-native-structured-roundtrip.md) |
| [Insert label metadata without leaving the editor (25 s)](assets/demos/label-shortcut.gif) | Invoke Insert Label Metadata (default Mod+Shift+L), type the identifier, and keep the hidden label separate from the heading. | [Example](../examples/claims/05-label-shortcut.md) |
| [Refuse an overwrite when the linked TeX changed (28 s)](assets/demos/guarded-refusal.gif) | A build refuses to replace an edited linked target. Return to Preview and reconcile the change explicitly instead of forcing agreement. | [Example](../examples/claims/04-guarded-round-trip.md) |

## Scope and provenance

- The six feature clips were generated against source `a76ec83`. They retain their original illustration labels. Some review shots say “incoming diff UI”; the red/green review is implemented in the current public source (`b844612` at selection), but these historical drawings are not newly captured native UI.
- The combined illustration below covers guarded round trips and TeX-owned preservation. The older full round-trip clip, second combined hero and promotional ad were omitted to avoid repeating that story.
- Raw `{=latex}` fences, hybrid figure/table bodies and managed TeX-owned slots are different mechanisms. The slot demo illustrates the last one, not arbitrary LaTeX import or automatic synchronization. See [authoring](authoring.md), [linked targets](linked-tex.md), and [round-trip guarantees](roundtrip.md).
- These clips do not demonstrate every feature. Note-owned recipes, bibliography configuration and other details remain covered by the [feature catalogue](features.md) and [runnable claim demos](../examples/claims/README.md).
- The GIFs are kept as repository documentation assets, following the existing hero. They are not plugin runtime files or part of the text-only source export.

## Reading without animation

The table above describes each action and its safety boundary in text, and links a runnable example. Preview does not write the note; Apply is explicit. Linked-state freshness, ownership and refusal checks remain authoritative regardless of the illustration.

## Combined illustration

![Illustrated round trip and TeX-owned preservation](assets/readme/md2tex-workflow.gif)

### Preserve exact TeX through Markdown edits (66 s)

![Illustrated workflow: Preserve exact TeX through Markdown edits (66 s)](assets/demos/tex-owned-island.gif)

### Build academic Markdown into a local PDF (20 s)

![Illustrated workflow: Build academic Markdown into a local PDF (20 s)](assets/demos/basic-build.gif)

### Edit a supported table from either side (46 s)

![Illustrated workflow: Edit a supported table from either side (46 s)](assets/demos/native-table.gif)

### Keep aligned equations editable (33 s)

![Illustrated workflow: Keep aligned equations editable (33 s)](assets/demos/native-align.gif)

### Insert label metadata without leaving the editor (25 s)

![Illustrated workflow: Insert label metadata without leaving the editor (25 s)](assets/demos/label-shortcut.gif)

### Refuse an overwrite when the linked TeX changed (28 s)

![Illustrated workflow: Refuse an overwrite when the linked TeX changed (28 s)](assets/demos/guarded-refusal.gif)

## Recorded demos on the README

The two primary README GIFs come from original user screencasts edited into `md2tex-demo-gifs-v2` on 26 September 2026, not from the illustration renderer. They retain the edited-waits and two-recording disclosures. The package excludes private source footage, and crops/masks exclude local paths and metadata. The recordings demonstrate the historical installed plugin; they are not a new acceptance test. The guarded Preview → Apply workflow remains current, while today's review panel displays a red/green patch.
