---
tex-workshop-bibliography: none
---

# Local TeX and PDF artifacts

This note exercises the ordinary local build: Markdown is captured without being rewritten, structural conversion emits TeX, and `latexmk` produces the PDF and compiler log in a fresh attempt.

The literal token `draft_file_01.md` remains code rather than becoming LaTeX syntax. Inline mathematics such as $E(\theta)$ and a display remain available in the generated document.

$$
E(\theta)=\langle\psi(\theta)|H|\psi(\theta)\rangle.
$$

After building, inspect `artifacts.tex`, `artifacts.pdf`, `artifacts.log`, `artifacts.sourceMap`, and `artifacts.result` in the returned JSON. A later failed attempt does not replace the recorded last successful PDF.
