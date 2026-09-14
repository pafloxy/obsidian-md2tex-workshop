---
title: A note with its own compilation recipe
tex-workshop-preamble: examples/bibliography/preamble.tex
tex-workshop-bibs:
  - examples/bibliography/references.bib
tex-workshop-bibliography: bibtex
---

# A short calculation

This sentence can be improved in TeX. The citation [cite{drafting-example}]
uses the bibliography declared in this note.

> [!equation]
> <!-- [label{eq:square}] -->
> $$
> q(x) = x^2
> $$

See [ref{eq:square}].

[printbibliography]

# Appendix

This paragraph follows the bibliography in the PDF.
