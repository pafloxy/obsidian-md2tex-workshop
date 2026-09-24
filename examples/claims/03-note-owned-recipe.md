---
tex-workshop-preamble: examples/bibliography/preamble.tex
tex-workshop-bibs:
  - examples/bibliography/references.bib
tex-workshop-bibliography: bibtex
---

# A note owns its document recipe

The citation [cite{drafting-example}] uses the bibliography selected in this note rather than an implicit project-wide file.

> [!equation]
> <!-- [label{eq:recipe-square}] -->
> $$
> r(x)=x^2
> $$

Equation [ref{eq:recipe-square}] is compiled with the YAML-selected preamble and BibTeX backend.

[printbibliography]

# After the bibliography

Explicit bibliography placement remains part of the Markdown structure, so later sections can follow it deliberately.
