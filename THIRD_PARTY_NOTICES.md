# Third-party notices

Project-owned code, documentation, examples and skills are licensed under
Apache-2.0 (Copyright 2026 Rajarsi). The files below retain their upstream
licenses. The project's license does not replace them.

| Files | Upstream and attribution | License and local changes |
| --- | --- | --- |
| `assets/support/eptcs/eptcs.cls` | [EPTCS LaTeX style](https://github.com/EPTCS/style), maintained by the EPTCS style contributors | CC BY 4.0. Exact byte match to revision `f71f020d774ae82e0bbb802ff0633f537eb577df`; class v1.7. No Workshop modifications. |
| `assets/support/eptcs/eptcs.bst`, `eptcsini.bst` | Patrick W. Daly, copyright 1994–2004; upstream edits by Rob van Glabbeek and Kartik Singhal, as stated in the retained headers | LPPL version 1 or later under the file-specific notice. Exact byte matches to EPTCS revision `eb1acf70fd7a588ce90246e941d14478d99f8869`; no Workshop modifications. |
| `assets/support/eptcs/eptcsalpha.bst`, `eptcsalphaini.bst` | Patrick W. Daly, copyright 1994–2007; upstream edits by Rob van Glabbeek and Kartik Singhal, as stated in the retained headers | LPPL version 1 or later under the file-specific notice. Exact byte matches to the same EPTCS revision; no Workshop modifications. |

Included license texts: [CC BY 4.0](licenses/CC-BY-4.0.txt) and
[LPPL 1.3c](licenses/LPPL-1.3c.txt), an allowed later LPPL version. The EPTCS
repository's [license](https://github.com/EPTCS/style/blob/eb1acf70fd7a588ce90246e941d14478d99f8869/LICENSE)
provides its CC BY 4.0 distribution terms; the bibliography headers supply
more specific LPPL notices. Preserve both when redistributing the assets.

Source provenance and exact hashes are recorded in
[release/third-party.json](release/third-party.json). These statements concern
the style files, not the license of any document compiled with them.

Node.js, Python, TeX/latexmk and Poppler are external tools, not bundled binaries.
GitHub Actions checkout/setup-node are referenced by the optional CI workflow;
their implementations are downloaded by GitHub rather than shipped here.
