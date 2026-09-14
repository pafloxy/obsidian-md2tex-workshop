---
title: Uniform Markdown drafting
---
# Conservation
<!-- [label{sec:conservation}] -->

The identity in [ref{eq:square}] proves [ref{lem:nonnegative}].

> [!lemma] Nonnegative square on $[a,b]$
> <!-- [label{lem:nonnegative}] -->
>
> For every real $x$, the square is nonnegative.
>
> > [!proof]
> > A product of two equal real numbers is nonnegative.

> [!equation]
> <!-- [label{eq:square}] -->
> $$
> q_a(x) = (x+a)^2 \geq 0
> $$

Equality holds exactly when $x=-a$.

The following display has no equation number:

$$
q_a(-a)=0
$$

Return to [ref{sec:conservation}]. [todo{Check the **notation** and units}].

`[label{example}]` and `[ref{example}]` are literal examples inside code.
