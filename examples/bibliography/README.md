# Preamble and bibliography declared in Markdown

[note.md](note.md) declares [preamble.tex](preamble.tex) and
[references.bib](references.bib) in YAML. The bibliography entry is fictional
test data. `[printbibliography]` places its output before the appendix.

1. From the **repository root**, compile the unchanged example:

   ```sh
   node scripts/workshop.cjs build examples/bibliography/note.md --out-dir tmp/bibliography-build
   ```

   Open `artifacts.pdf` from the JSON result. Expect a resolved citation, the
   numbered equation and a bibliography before the appendix. `profile.origins`
   identifies the YAML settings; the engine inherits its default.
2. Inspect the note's YAML and the three small source files. The preamble
   contains the class and packages, without document begin/end markers.
   Paths in this example are relative to the repository root. From another
   working directory, pass the repository's absolute path as `--vault-root`.
   In an Obsidian vault, use paths relative to that vault's root.
3. For a round-trip exercise, run from the **repository root**:

   ```sh
   mkdir -p tmp/bibliography-demo
   cp examples/bibliography/note.md tmp/bibliography-demo/note.md
   node scripts/workshop.cjs tex-checkout tmp/bibliography-demo/note.md --out-dir tmp/bibliography-demo/editing
   ```

   The copied note still refers to the example resource files. Checkout freezes
   their bytes. Edit only the returned `artifacts.tex`: change “This sentence can
   be improved in TeX.” to “This sentence was improved in TeX.” inside its marked
   body block. Keep the wrapper and marker lines intact.
4. From the **repository root**, replace the placeholder with the returned
   `artifacts.session` path:

   ```sh
   node scripts/workshop.cjs tex-sync PATH_TO_SESSION_JSON
   ```

   Inspect `artifacts.candidate`, its PDF and the report. The prose edit should
   appear while the YAML and `[printbibliography]` remain intact. The preview's
   setting origins are `checkpoint`; it does not reload the live YAML resources.
5. After accepting that candidate, pause editors/autosave on both source files.
   From the **repository root**, use the returned preview report path:

   ```sh
   node scripts/workshop.cjs tex-apply tmp/bibliography-demo/note.md --preview PATH_TO_PREVIEW_JSON
   node scripts/workshop.cjs build tmp/bibliography-demo/note.md --out-dir tmp/bibliography-demo/builds
   ```

   Verify the applied text, retained backup and rebuilt PDF. For more TeX
   editing, create a fresh checkpoint. [Linked targets](../../docs/linked-tex.md)
   support the same recipe when you want one persistent TeX filename.

Omit the preamble key to use the basic article default. To try biblatex, use a
custom preamble that loads `\usepackage[backend=biber]{biblatex}`, set
`tex-workshop-bibliography: biblatex`, and have Biber/biblatex available locally.
The body syntax and resource list stay the same. Changing a checkpoint's recipe
requires a fresh checkpoint; it is not a body-only edit.
