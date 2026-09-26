---
tex-workshop-bibliography: none
---

# TeX-owned slot demo
<!-- [label{sec:tex-owned-slot-demo}] -->

This Markdown paragraph remains editable before and after the slot round trip.

Replace this complete sentence inside its linked TeX marker block with the table below, then run Preview TeX changes and inspect the proposed Markdown pointer.

```tex
\begin{table}[h]
\centering
\caption{An exact TeX-owned table}
\begin{tabular}{lr}
Name & Value \\
Alpha & 1 \\
\end{tabular}
\end{table}
```

After the accepted Apply, the Markdown candidate contains one TeX-owned pointer with an ID such as `slot-b0003` instead of the replacement sentence.

Add another Markdown sentence, rebuild, and confirm that the linked TeX document still contains the table byte-for-byte.

Removing or duplicating the pointer is intentionally refused before publication.
