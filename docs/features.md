# Features and current limits

This page states the implemented md2tex Workshop feature set at version 0.1.3. It separates tested capabilities from release and platform gates that remain open.

## Main features

| Feature | What works now | Evidence or entry point |
| --- | --- | --- |
| Readable academic Markdown | Headings, supported callouts, equations, complete top-level `equation`/`equation*` and `align`/`align*` displays, hidden labels, references, citations, lists, math, raw TeX fences, and ordinary prose convert through the documented structural subset. | [Authoring contract](authoring.md); [readable Markdown demo](../examples/claims/01-readable-academic-markdown.md) |
| Local TeX/PDF build | Manual builds retain source snapshots, TeX, PDF, logs, maps, configuration, and result metadata. A failed build retains the last successful PDF. | [Local build demo](../examples/claims/02-local-tex-pdf.md); [panel guide](panel.md) |
| Note-owned recipe | YAML selects the document engine, preamble, bibliography backend, bibliography files, and bibliography location. | [Recipe demo](../examples/claims/03-note-owned-recipe.md) |
| Guarded TeX round trip | A linked target supports checkpointed Markdown to TeX, read-only TeX-to-Markdown preview, explicit apply, backups, exact freshness checks, one-editor native save, disk readback, and post-apply rebuilding. Rewrites beyond 400 changed lines or 128 KiB are summarized without rendering either full document and expose a red overwrite action that retains the same guards. | [Round-trip demo](../examples/claims/04-guarded-round-trip.md); [round-trip guide](roundtrip.md) |
| TeX-owned slots | A linked preview can replace one unsupported top-level Markdown block with a stable pointer and persist its exact TeX payload in owned target state. Rebuilds splice that payload back byte-for-byte; missing, duplicate, foreign, or reordered pointers refuse before publication. | [TeX-owned slot demo](../examples/claims/06-tex-owned-slot.md); [linked-TeX guide](linked-tex.md#tex-owned-slots) |
| Native simple tables and hybrid floats | Canonical workshop tables with `l`, `c`, or `r` columns recover as editable Markdown grids. Figures and complex tables recover as visible callouts with editable one-line captions and labels while their `includegraphics`, `minipage`, `tabular`, and formatting body remains exact TeX in one nested pass-through fence. | [Structured round-trip demo](../examples/claims/07-native-structured-roundtrip.md); [linked-TeX guide](linked-tex.md#native-math-tables-and-hybrid-structured-recovery) |
| Native hyperlinks and citations | Canonical generated `\href`, `\hyperref`, `\cite`, and `\printbibliography` forms recover into editable Markdown when exact regeneration succeeds. Unsafe links, TeX-specific citation spacing, legacy bibliography commands, and ambiguous forms remain exact raw TeX. | [Authoring contract](authoring.md); [panel guide](panel.md) |
| Panel bibliography fallback | The Workshop panel accepts up to 16 existing vault-relative `.bib` files with BibTeX or biblatex selection. Each build rechecks regular-file and vault containment rules and passes canonical paths to the worker; note YAML remains authoritative. | [Panel guide](panel.md); [recipe guide](cli.md#note-metadata) |
| Fast hidden-label entry | **md2tex Workshop: Insert Label Metadata** inserts `<!-- [label{}] -->` at the active Markdown cursor and leaves the cursor between the braces. The bundled `Mod+Shift+L` hotkey is editable in Obsidian Settings → Hotkeys. | [One-minute label demo](../examples/claims/05-label-shortcut.md) |

## What the label shortcut does and does not do

1. Place the editor cursor immediately below a heading or on the first nonblank body line of a supported callout.
2. Run **md2tex Workshop: Insert Label Metadata** or press `Mod+Shift+L`.
3. Type a nonempty identifier inside the braces, for example `sec:methods`, `lem:control`, or `eq:energy`.
4. Build normally; the converter validates placement and identifier syntax.

The shortcut neither generates identifiers nor decides what an arbitrary nearby block should label. It does not make plain display math numbered, attach a label to proofs, generic callouts, or deep headings, or bypass the normal converter checks. Use an `[!equation]` callout for one numbered equation or an explicit complete top-level `align` display for independently numbered rows. The precise accepted ownership positions and identifier alphabet are in the [authoring contract](authoring.md#commands-and-ordinary-viewers).

## Current limits and release gates

| Scope | Current state |
| --- | --- |
| Markdown coverage | The converter is a bounded structural subset, not a complete CommonMark/Obsidian/LaTeX parser. Table grids work only inside structured table callouts and only for the lossless `l`/`c`/`r` subset; complex tables use the hybrid TeX-body fallback. Ordinary Markdown images, transclusions, arbitrary Markdown extensions, and broad existing-manuscript adoption remain unsupported. |
| TeX recovery | The guarded inverse only accepts bounded, exact-regenerating TeX edits. Changed anchors, wrappers, recipes, dependencies, stale previews, conflicts, and ambiguous inverse cases are refused without silently overwriting either source. |
| Large rewrite review | Oversized changes intentionally omit the detailed patch and full document bodies. The red overwrite action applies only the already sealed proposed Markdown through the ordinary backup, freshness, persistence, and finalization path; it is not a force-write control. |
| Bibliography recovery | Canonical `\cite` and `\printbibliography` recovery is supported. `~\cite`, `\bibliographystyle`, `\bibliography`, `\addbibresource`, and other existing-manuscript conventions are not normalized; they remain exact TeX when recovery cannot reproduce them byte-for-byte. |
| TeX-owned slots | Slots are available only through a managed linked target. Version 1 promotes a whole marked top-level block, keeps the original TeX payload opaque, and does not import an arbitrary existing manuscript. Unsupported or noncanonical figures/tables still use this fallback. |
| Editor shortcut | The default shortcut is a normal Obsidian command hotkey, so users may rebind or remove it. Packaged-host tests verify bytes and cursor placement; each target platform still benefits from a local native check. |
| BRAT availability | A local three-file candidate can be packaged and inspected. Hosted BRAT installation exists only after a matching `0.1.3` GitHub release is published and installed through BRAT. The 0.1.3 review and bibliography UI also need a fresh native smoke test before being described as natively accepted. |

No network or model-provider call is required for ordinary builds, label insertion, or round trips. See [release maintenance](releasing.md) for the public-release and hosted-BRAT boundaries.
