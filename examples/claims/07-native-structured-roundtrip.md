---
tex-workshop-bibliography: none
---

# Native structured round trip
<!-- [label{sec:native-structured-demo}] -->

This note is the Markdown form produced after a guarded TeX preview recognizes native equation math plus canonical figure and table wrappers. The mathematical environments stay visible, while each float exposes an editable caption and label around an exact TeX-owned body.

$$
\begin{equation}
g_*(A)=i\langle[A,H]\rangle.
\label{eq:native-gradient}
\end{equation}
$$

> [!figure|h] A locally generated figure placeholder.
> <!-- [label{fig:native-placeholder}] -->
>
> ```{=latex}
> \centering
> \fbox{\rule{0pt}{2cm}\rule{4cm}{0pt}}
> ```

> [!table|h] A compact structured comparison.
> <!-- [label{tab:native-comparison}] -->
>
> ```{=latex}
> \centering
> \begin{tabular}{|c c|}
> Source & Editable in Markdown \\
> \hline
> Caption and label & Yes \\
> TeX body & Exact island \\
> \end{tabular}
> ```

The equation [ref{eq:native-gradient}], figure [ref{fig:native-placeholder}], and table [ref{tab:native-comparison}] retain working labels after rebuilding. In a real figure, the body fence can contain `\includegraphics`, `minipage`, and layout commands; the selected preamble and declared local resources still determine whether that TeX compiles.
