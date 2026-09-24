---
tex-workshop-bibliography: none
---

# Readable academic Markdown
<!-- [label{sec:readable-demo}] -->

The source stays readable in Obsidian while the compiled document receives numbered mathematical objects and references.

> [!definition] Shifted coordinate
> <!-- [label{def:shifted-coordinate}] -->
> For real numbers $x$ and $a$, define the shifted coordinate $y=x+a$.

> [!lemma] Nonnegative square
> <!-- [label{lem:nonnegative-square}] -->
> The square $y^2$ is nonnegative for every real $y$.
>
> > [!proof]
> > This follows from the order properties of the real numbers.

> [!equation]
> <!-- [label{eq:shifted-square}] -->
> $$
> q_a(x)=(x+a)^2
> $$

By [ref{def:shifted-coordinate}] and [ref{lem:nonnegative-square}], the quantity in [ref{eq:shifted-square}] is nonnegative. The complete example appears in [ref{sec:readable-demo}].
