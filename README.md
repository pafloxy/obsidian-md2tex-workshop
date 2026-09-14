# md2tex Workshop

Draft a technical note in Markdown, compile it to LaTeX and PDF, and review
TeX edits before bringing them back into Markdown. The CLI runs locally and
keeps build attempts, diagnostics and the last successful PDF.

This is an early **source release for the CLI**. The repository also contains
an experimental desktop Obsidian adapter using the same compiler. Community
Plugin installation is a later milestone; see [plugin status](docs/plugin-integration.md).
AI repair is not implemented and no model or API account is required.

## Start here

1. Download this repository using GitHub's **Code → Download ZIP**, or clone
   the repository URL shown on its GitHub page. Extract/open the source folder.
   If an agent is helping you, point it to [AGENT_SETUP.md](AGENT_SETUP.md).
2. Use **Node.js 24** and an existing LaTeX installation containing `latexmk`,
   `pdflatex`, BibTeX and the packages used by the default preamble. Linux with
   Node 24.12.0 is the tested baseline. Other platforms and newer major Node
   versions need their own validation. Node below 24 receives a setup diagnostic.
3. From the **repository root**, check your tools:

   ```sh
   node --version
   node scripts/workshop.cjs doctor
   ```

   `doctor` prints JSON and creates no build files. A successful result means
   the selected paths and executables are available; it does not inspect every
   TeX package. A real build below checks the example's package requirements.

There are no npm runtime packages to install. `npm install` is unnecessary.
The [basic article preamble](assets/preambles/basic-preamble.tex) uses AMS math
and theorem packages, `aliascnt`, `hyperref` and `cleveref`. The broader
[EPTCS preamble](assets/preambles/default-preamble.tex) remains an explicit choice.
Missing system tools/packages must be installed separately with your permission.

## Compile a note

From the **repository root**:

```sh
node scripts/workshop.cjs build examples/quickstart/note.md --out-dir tmp/quickstart-builds
node scripts/workshop.cjs status examples/quickstart/note.md --out-dir tmp/quickstart-builds
```

On success, open the path in `artifacts.pdf`. `artifacts.tex` is the generated
LaTeX document; `artifacts.log` is its compiler log. A later failed build keeps
the previous successful PDF available through `status.lastSuccess`. Check
`latestAttempt` when you want the newest diagnostics.

For your own file, replace the input path and choose an output directory.
Quote paths containing spaces. From a different directory, invoke the CLI by
its absolute path. Relative command arguments and the default metadata root
are resolved from that directory; `--vault-root DIRECTORY` overrides the base
for note metadata such as bibliography and preamble paths.

## Keep compilation settings in the note

YAML settings take priority over CLI or Obsidian control defaults. With no
preamble selection, Workshop uses its basic article preamble. For example:

```yaml
---
tex-workshop-preamble: preambles/article.tex
tex-workshop-bibs:
  - references/main.bib
tex-workshop-bibliography: bibtex
---
```

These are local file paths, not embedded TeX/BibTeX contents. Cite a key using
`[cite{example2026}]`, then put `[printbibliography]` on its own top-level line
where the bibliography should appear. Omitting that command keeps automatic
end placement. `tex-workshop-bibs: []` explicitly disables resources; `--no-bib`
only disables fallback resources and cannot override a YAML list.

Try the complete [preamble and bibliography example](examples/bibliography/README.md).
The [CLI guide](docs/cli.md#note-metadata) describes path resolution, backend
selection and diagnostics. Build JSON records setting origins in
`profile.origins`; the Workshop panel shows them for the last build.

## Write readable mathematics

Use native Markdown callouts with hidden label comments:

```markdown
# A useful identity
<!-- [label{sec:identity}] -->

> [!lemma] Nonnegative square
> <!-- [label{lem:square}] -->
> For real $x$, the value $x^2$ is nonnegative.

> [!equation]
> <!-- [label{eq:square}] -->
> $$
> q(x)=x^2
> $$

See [ref{lem:square}] and [ref{eq:square}].
```

Plain `$$` displays remain unnumbered. Labels belong to explicit equation
callouts, headings or theorem-like callouts. The converter does not customize
Markdown viewers: Obsidian uses native callouts, other viewers may show their
markers, and reference commands resolve to numbers in LaTeX/PDF. Read the
[authoring contract](docs/authoring.md) for supported syntax and its limits.

## Keep one editable TeX target

The [quickstart walkthrough](examples/quickstart/README.md) shows the complete
cycle on a disposable copy. A linked target keeps a single TeX path while
build attempts remain separate.

1. From the **repository root**, create the example copy:

   ```sh
   mkdir -p tmp/my-draft
   cp examples/quickstart/note.md tmp/my-draft/note.md
   node scripts/workshop.cjs tex-target tmp/my-draft/note.md --target tmp/my-draft/paper.tex
   node scripts/workshop.cjs build tmp/my-draft/note.md --out-dir tmp/my-draft/builds
   ```

   Choose a new target: existing manuscripts are not overwritten or silently
   adopted. TeX ownership and retained checkpoints live beside the target.
2. Edit prose inside the marked body of `tmp/my-draft/paper.tex`, then save it.
   From the **repository root**, prepare a review:

   ```sh
   node scripts/workshop.cjs tex-target-sync tmp/my-draft/note.md
   ```

3. Inspect the returned candidate, diagnostics and PDF. After accepting the
   proposed change, pause editing/autosave on both files. From the **repository
   root**, replace the placeholder below with the returned preview report path:

   ```sh
   node scripts/workshop.cjs tex-target-apply tmp/my-draft/note.md --preview PATH_TO_PREVIEW_JSON
   node scripts/workshop.cjs build tmp/my-draft/note.md --out-dir tmp/my-draft/builds
   ```

Apply verifies freshness and creates backups. A changed source, candidate,
recipe or target requires a new preview. A build can produce a good PDF while
linked publication reports `TARGET_EDITED`; reconcile the TeX instead of
repeating publication. See [linked targets](docs/linked-tex.md) and
[round-trip guarantees](docs/roundtrip.md).

## Limits, diagnostics and privacy

This is a bounded drafting language, not a complete Markdown or TeX importer.
Tables, images, note transclusion and some Markdown extensions are unsupported.
Use explicit raw-TeX fences for content requiring TeX, with a suitable preamble.
Unknown extensions may remain literal: inspect the result before distribution.

Run `node scripts/workshop.cjs --help` from the repository root for commands.
The [CLI guide](docs/cli.md) explains options, metadata, exit codes and recovery.
Start with the reported stage and source line; retain logs and backups when a
build or round trip fails. There is no destructive clean command.

Compilation uses local programs, disables TeX shell escape, and makes no
intentional network/provider requests. Executables, custom converters and raw
TeX must still be trusted: this tool is not an untrusted-document sandbox.
Build history includes source text and local paths. Keep output directories,
`.workshop` histories and user configuration out of public repositories.

## Tests and development

From the **repository root**, with Node 24 available:

```sh
npm run test:fast
npm test
```

The full suite requires local TeX/BibTeX, Python 3 for the external-adapter tests,
and Poppler's `pdftotext`/`pdfinfo`. Test artifacts stay under `tmp/`; failures
retain their evidence. No test accesses a running Obsidian instance. See
[contributing](CONTRIBUTING.md), [architecture](docs/architecture.md) and
[release maintenance](docs/releasing.md).

[skills/](skills/README.md) contains optional agent workflows for compilation,
guarded round trips and release preparation. They are ordinary local files;
reading them does not install anything or grant permission to edit your notes.

## License

Project-owned source, documentation and skills: Copyright 2026 Rajarsi,
[Apache-2.0](LICENSE). Bundled EPTCS assets retain their own licenses and
attribution; see [third-party notices](THIRD_PARTY_NOTICES.md).
