---
tex-workshop-bibliography: none
---

# Guarded linked-TeX round trip
<!-- [label{sec:round-trip-demo}] -->

Edit this sentence inside its marked block in the linked TeX file, then ask Workshop to preview the proposed Markdown.

> [!lemma] Preserved control object
> <!-- [label{lem:round-trip-control}] -->
> This lemma and its label should remain unchanged while the prose sentence is recovered.

> [!equation]
> <!-- [label{eq:round-trip-control}] -->
> $$
> s(t)=t^2
> $$

The control sentence still refers to [ref{lem:round-trip-control}] and [ref{eq:round-trip-control}]. After an accepted Apply, rebuild once to create the checkpoint for the next editing round.
