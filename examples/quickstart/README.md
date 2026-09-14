# Try compilation and a round trip

Use the following commands from the **repository root**, after the root
[setup instructions](../../README.md#start-here). Keep the committed example
unchanged and experiment with a copy under `tmp/`.

1. Create the copy, claim a new target and build:

   ```sh
   mkdir -p tmp/quickstart
   cp examples/quickstart/note.md tmp/quickstart/note.md
   node scripts/workshop.cjs tex-target tmp/quickstart/note.md --target tmp/quickstart/paper.tex
   node scripts/workshop.cjs build tmp/quickstart/note.md --out-dir tmp/quickstart/builds
   ```

   Open `artifacts.pdf` from the JSON result. Check `status` and `target.status`:
   both should report success. Later builds retain the same `paper.tex` path.
2. Open `tmp/quickstart/paper.tex`. In the marked body, change only the final
   sentence to `This sentence was edited in TeX.` Save the file and leave the
   generated boundary comments, preamble and document markers intact.
3. Prepare a candidate:

   ```sh
   node scripts/workshop.cjs tex-target-sync tmp/quickstart/note.md
   ```

   Read the returned preview report and proposed Markdown. The final sentence
   should change; labels, callouts and equations should remain recognizable.
   Open the candidate PDF. A preview does not overwrite your Markdown.
4. Once you accept that change, pause editors/autosave for both files. Replace
   the placeholder with the actual report path returned by the previous command:

   ```sh
   node scripts/workshop.cjs tex-target-apply tmp/quickstart/note.md --preview PATH_TO_PREVIEW_JSON
   node scripts/workshop.cjs build tmp/quickstart/note.md --out-dir tmp/quickstart/builds
   node scripts/workshop.cjs tex-target-status tmp/quickstart/note.md
   ```

   Reload Markdown and verify the new sentence. The apply report identifies
   retained backups. The resumed build updates the same target.
5. Change Markdown normally and rebuild. If you also edit TeX, use the preview
   workflow to reconcile before publication. A stale-preview or `TARGET_EDITED`
   result protects the edits; preserve both files and inspect the report.

To repeat from scratch, choose a fresh directory such as `tmp/quickstart-2`.
Existing target ownership persists; copying seed files over an active exercise
is not a reset procedure. See [linked targets](../../docs/linked-tex.md).
