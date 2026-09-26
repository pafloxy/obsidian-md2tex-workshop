---
tex-workshop-engine: pdflatex
---

# Label shortcut demo
<!-- [label{sec:label-shortcut-demo}] -->

In Obsidian source mode, put the cursor on the next line after this heading and press `Mod+Shift+L`. The command inserts `<!-- [label{}] -->` and leaves the cursor between the braces; type a unique identifier, then remove the temporary line before building this checked-in demo.

> [!lemma] Fast metadata entry
> <!-- [label{lem:fast-metadata-entry}] -->
> A hidden label comment can remain readable Markdown while exporting an explicit LaTeX target.

The reference [ref{lem:fast-metadata-entry}] checks that the existing demo label resolves. For real work, place a shortcut-generated label immediately below a heading or as a supported callout's first nonblank body line.
