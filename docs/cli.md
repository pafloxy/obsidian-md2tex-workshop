# Standalone workshop CLI

The CLI compiles one Markdown note through the shared local core and local
LaTeX tools. It is independent of a running Obsidian instance. See
[authoring](authoring.md), [linked targets](linked-tex.md) and
[round-trip editing](roundtrip.md) for the supported workflows.

## Run it

Run these commands from the **obsidian-md2tex-workshop project root**:

```sh
node scripts/workshop.cjs --help
node scripts/workshop.cjs capabilities
node scripts/workshop.cjs doctor
node scripts/workshop.cjs build testing/fixtures/cli/technical.md --out-dir tmp/cli-builds
node scripts/workshop.cjs status testing/fixtures/cli/technical.md --out-dir tmp/cli-builds
```

`build` prints one JSON result. On success, `artifacts.pdf` names the generated
PDF and `artifacts.tex` names its TeX source. `status` returns `lastSuccess`,
`latestAttempt`, and `busy`; it does not require the input file still to exist.
`doctor` checks explicitly selected paths and executable availability without
creating build files. It does not read note frontmatter or live Obsidian settings
and is not a proof that every package required by a custom preamble is installed.

No global launcher, installation, or deployment is needed. `npm run build` and
`npm run dev` now stage a complete package under project `tmp/`, without changing
the live plugin. See [packaging and integration contracts](plugin-integration.md).

## Prerequisites and defaults

Use Node 24 and a working local TeX installation. Python 3 is needed only for
an explicitly selected external converter and its integration tests. Poppler
is used by the full test suite. See [setup](../README.md#start-here).

The default converter is `src/core/markdown.cjs`; the default metadata root is
the invoking working directory. Override it with `--vault-root`. Default tool
executables come from `PATH`. A trusted external Python converter can be
selected with `--converter FILE`; it must accept `INPUT --stdout --body-only`.
There is no automatic converter or provider fallback.

The default recipe uses the shipped basic article preamble. There is no implicit
bibliography file. Select the broader EPTCS recipe explicitly with
`--preamble assets/preambles/default-preamble.tex` from the repository root;
its bundled support files are then included. Other custom preambles supply their
own packages and support files. The CLI does not read saved Obsidian settings.

## Commands and options

| Command or option | Contract |
| --- | --- |
| `build INPUT --out-dir DIR` | Read one input snapshot and create an isolated build attempt. Both arguments are required. |
| `status INPUT --out-dir DIR` | Read persisted state for that input-path/output-directory pair. It creates nothing. |
| `doctor` | Read configuration paths and probe latexmk and the selected engine; also probe Python when `--converter` is supplied. |
| `capabilities` | Return implemented commands, versioned worker contracts, feature availability and a relocation-stable code/assets fingerprint. Takes no options, writes no files and probes no tools/providers. |
| `tex-target INPUT --target NEW_TEX` | Register one shared fixed TeX target without changing Markdown; refuses an existing unmanaged target. |
| `tex-target-status INPUT` / `tex-target-unlink INPUT` | Inspect the shared binding/external edits, or archive the binding while retaining TeX/history. |
| `tex-target-sync INPUT` / `tex-target-apply INPUT --preview REPORT` | Reverse-preview the named TeX, then explicitly apply a reviewed fresh candidate with backups. See [linked-TeX workflow](linked-tex.md). |
| `worker REQUEST_JSON` | Build an exact captured snapshot through the same core; emits progress/result NDJSON. The desktop client supplies and validates requests; see [worker contract](plugin-integration.md#worker-execution-and-retained-evidence). |
| `--preamble FILE` | Fallback when YAML omits the preamble: a file containing a document class without document begin/end markers. |
| `--engine pdflatex\|xelatex\|lualatex` | Fallback engine; default `pdflatex`. YAML wins. XeLaTeX/LuaLaTeX routing is tested separately from real engine acceptance. |
| `--bib FILE` | Fallback bibliography files; repeat for multiple files. Used only when YAML omits its resource list. |
| `--no-bib` | Disable fallback bibliography files. A YAML list still wins. Mutually exclusive with `--bib`. |
| `--bibliography none\|bibtex\|biblatex` | Fallback backend. Default `bibtex` with bundled recipes; other custom preambles default to `none`. YAML wins. |
| `--support FILE` | Repeatable additional support file; staged by basename. Needed for custom class/style dependencies. |
| `--vault-root DIR` | Base for vault-relative metadata paths; does not change the default structural converter. |
| `--converter FILE` | Opt into a trusted external Python converter, called with `--stdout --body-only`; retains the legacy preflight guards and has no structural source map. |
| `--python EXE`, `--latexmk EXE` | Executable names or paths. No shell-command string interpretation. |
| `--timeout-ms INTEGER` | Per-process timeout, default 30000; accepted range 100–300000. |

All explicit relative CLI file/directory paths resolve against the invoking
working directory. Metadata paths resolve against `--vault-root`, defaulting to the invocation directory. Paths with
spaces must be quoted in the shell. Absolute paths are accepted.

For a custom preamble and bibliography, run from this project root, replacing
the example paths with existing files:

```sh
node scripts/workshop.cjs doctor --preamble ./path/to/preamble.tex --bibliography bibtex --bib ./path/to/references.bib
node scripts/workshop.cjs build ./path/to/note.md --out-dir ./tmp/custom-builds --preamble ./path/to/preamble.tex --bibliography bibtex --bib ./path/to/references.bib
```

A custom preamble must provide its own packages/macros. It must not embed
`\bibliography`, `\addbibresource`, or `\printbibliography` resource commands:
the CLI owns their insertion and stages the explicitly declared files. Existing
`\bibliographystyle` is respected; explicit BibTeX mode otherwise uses `plain`.
Biblatex mode requires a directly declared `biblatex` package and its configured
backend tool. Real bibliography builds and frozen previews are tested with
BibTeX and with `biblatex[backend=biber]` when the optional Biber toolchain is
enabled. The standard test suite exercises BibTeX without requiring Biber.

Support files are flattened to their basenames. Reserved artifact names,
duplicate basenames, and selected TeX-sensitive filename characters are rejected
before compilation. Nested asset trees and automatic image resolution are not
implemented.

## Note metadata

The body and these fields are read from the same saved Markdown snapshot:

```yaml
---
tex-workshop-preamble: project/templates/preamble.tex
tex-workshop-engine: pdflatex
tex-workshop-bibliography: bibtex
tex-workshop-bibs:
  - project/references.bib
---
```

Resolution is by field: **YAML > CLI/Obsidian controls > bundled default**.
An absent key inherits a value. A present empty or invalid scalar fails instead
of falling back. `tex-workshop-bibs: []` means no resources; a nonempty YAML list
still applies when `--no-bib` is supplied. To fix an incorrect YAML path, edit or
remove that key; supplying another CLI path will not override it. Other custom
preambles need their dependencies declared with `--support`; selecting the
bundled EPTCS preamble explicitly retains its bundled support.

Build results and `resolved-config.json` expose `profile.origins` for `preamble`,
`engine`, `bibs` and `bibliography`: `yaml`, `controls` or `default`. Frozen
round-trip previews report `checkpoint` because their dependency copies are
replayed internally. `doctor` resolves controls/defaults only; it does not read
a note. The Obsidian panel displays the last build's settings and their origins.

This is a deliberately limited metadata reader, not a general YAML library.
It accepts flat plain/quoted strings and bibliography lists (indented `-` items,
JSON string arrays, or simple comma-separated values). JSON-style double quotes
and YAML single quotes are supported. Duplicate/unknown `tex-workshop-*` keys,
unfinished frontmatter, and unsupported aliases/tags/multiline values are
diagnosed. Unrelated metadata is omitted from conversion and otherwise ignored.

## Bibliography placement

Use `[cite{key}]` for citations and one `[printbibliography]` on its own top-level
line to place the bibliography. It can precede an appendix or follow the final
paragraph. Without this directive, declared resources print at the end as before.
Code and comments preserve literal examples; lists, callouts, inline uses and
duplicates receive source diagnostics. The directive requires enabled resources.

Both backends emit `\printbibliography` in the converted body. For BibTeX,
Workshop defines that command in the wrapper to invoke `\bibliography` with the
staged filenames; biblatex supplies its own command. Resource ownership stays in
the wrapper, keeping the body representation independent of the backend.
Direct raw `\printbibliography`, `\bibliography` and `\addbibresource` body
commands are diagnosed to prevent competing insertion. Use the YAML list and
the Markdown placement directive instead. Literal verbatim examples are retained.
The external-converter adapter does not support the new placement directive.

The [complete example](../examples/bibliography/README.md) includes a custom
preamble, a synthetic `.bib` file and a recovery walkthrough. Markdown viewers
display the citation/print commands as draft text; reference entries render in
the compiled PDF.

## Build artifacts and publication

```text
OUT_DIR/
└── note-name-PATH_HASH/
    ├── .build.lock               # exists only while the CLI owns a build
    ├── latest-attempt.json       # last persisted attempt, including failure
    ├── last-success.json         # updated only after all current checks pass
    └── attempts/
        └── DDMMYYHHMM-UNIQUE_ID/
            ├── source.md         # original Markdown snapshot
            ├── conversion-input.md
            ├── resolved-config.json
            ├── body.tex
            ├── document.json     # structural block/span model and declarations
            ├── source-map.json   # body/main TeX lines -> original Markdown lines
            ├── main.tex
            ├── main.pdf          # may be absent after a failed attempt
            ├── main.log
            ├── conversion.json   # structural diagnostics or external process output
            ├── compilation.json  # complete captured compiler process output
            ├── result.json
            └── ...               # declared dependencies and TeX auxiliaries
```

Source, converter, preamble, and declared dependency hashes are recorded. Preamble
and dependency content is read during recipe resolution; the external converter
itself is executed from its original path and should not be edited during a build.
Each attempt is fresh. The last-success pointer and other pointers are published
by atomic rename while holding the per-document lock. Old attempts/PDFs are
retained. Different output directories have independent state.

Early argument/configuration failures create no attempt. Once an attempt exists,
the returned artifact fields name intended paths; some files will not exist if
their stage was never reached. A successful compiler exit alone is insufficient:
the CLI checks the PDF header and final log for unresolved references/citations,
duplicate labels/destinations, and missing glyphs. Box warnings are recorded but
do not block publication. This is not full visual or semantic validation.

## Conversion and source diagnostics

The default converter separates prose, literal code, math/raw TeX, and nested
blocks before rendering. It escapes ordinary prose, supports metadata-only
callout labels and existing explicit IDs, and checks the complete declared
document for missing/duplicate targets before TeX. `[todo{...}]` is rendered as a
visible annotation without depending on an undefined `\todo` macro.

The [authoring guide](authoring.md) lists the supported subset and rejected
constructs. M2 is not a complete CommonMark/Obsidian parser or a full TeX parser.
Code is now literal: an old code-span workaround such as `file\_name` retains
its backslash. Write `file_name` when that is the desired literal. No notes are
migrated automatically.

Structural attempts retain `document.json` and a body-line map even when
conversion reports errors. Successful assembly adds `texLine` mappings into
`main.tex`. Compiler errors in mapped body lines gain the original `path` and
`line`; `endLine` describes a range when multiple source lines contribute to
one emitted line. Preamble, dependency-file, and macro-expansion errors are not
claimed to have exact Markdown locations. These maps are not character-level
SyncTeX or live editor navigation.

With an explicit `--converter`, the old conservative preflight rejects known
lossy Markdown; those guards are not the structural parser. Its unsupported
code/link/metadata-label cases remain unchanged.

## Failure and recovery

| Diagnostic | Stage and safe next step | What is preserved |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Check `--help`; correct command/options. | No attempt created. |
| `MISSING_PREAMBLE`, `MISSING_CONVERTER`, `MISSING_DEPENDENCY` | Inspect the returned path. Correct a YAML selection in the note; control fallbacks cannot override it. | Source and last success untouched. |
| `BIBLIOGRAPHY_PLACEMENT`, `DUPLICATE_BIBLIOGRAPHY` | Keep one top-level `[printbibliography]` line; put literal examples in code/comments. | Source untouched; failed conversion retained. |
| `BIBLIOGRAPHY_RESOURCES_REQUIRED`, `BIBLIOGRAPHY_OWNERSHIP` | Inspect YAML resources/backend; replace competing raw print/resource commands with the supported directive. | Source untouched; no compiler invocation for this attempt. |
| `INVALID_FRONTMATTER` | Correct the indicated field/line; use the documented subset. | Source and last success untouched. |
| `PREAMBLE_CLASS_REQUIRED`, bibliography configuration errors | Supply a standalone preamble and explicit compatible backend/dependencies. | No attempt created. |
| Preflight `UNSUPPORTED_*`, `MISSING_EXPLICIT_LABEL`, `UNESCAPED_TEX_CHARACTER` | Inspect the source line. Use an established explicit representation or retain it for parser work. | Source/config snapshot and previous PDF retained; TeX did not run. |
| Conversion `UNCLOSED_*`, `INVALID_*`, `CONFLICTING_LABEL`, `UNSCOPED_LABEL`, `UNSUPPORTED_*` | Inspect the original Markdown line and authoring subset; finish delimiters, choose one ID, or use an explicit supported form. | Source, document model, diagnostics, and previous PDF retained; TeX did not run. |
| `BUILD_BUSY` | Use `status` for this input/output pair. Wait for the current attempt. | Active attempt and last success untouched. |
| `PROCESS_TIMEOUT`, `PROCESS_OUTPUT_LIMIT` | Inspect the stage's process JSON. Diagnose the hang/output flood before increasing limits. | Attempt logs retained; the CLI signals its subprocess group; last success unchanged. |
| `PROCESS_UNAVAILABLE` | Use `doctor` or correct the executable path. | Any created attempt plus previous PDF retained. |
| `LATEX_ERROR` | Inspect the first TeX message, original `path`/`line` when mapped, and `texFile`/`texLine`; then the full log. Correct Markdown or template and rebuild into a fresh attempt. | Old successful PDF and failing artifacts retained. |
| `UNRESOLVED_REFERENCE`, `UNRESOLVED_CITATION`, duplicate-anchor/glyph errors | Correct targets or dependencies; do not accept TeX's zero exit status as success. | Rejected candidate PDF may exist; last-success pointer is unchanged. |
| `ARTIFACT_WRITE_FAILED` | Check output-directory access and available storage before retrying. | Existing artifacts and previously published pointer are retained where writes failed. |

Retries make new attempts; there is no destructive clean command. The managed
worker has bounded process-group cancellation and matching dead-worker lock
recovery. A hard-interrupted ordinary CLI build or target operation can still
leave retained lock/state evidence. Inspect the owner PID and reports; never
remove a lock just because an operation seems slow. Target-state interruption
requires explicit reconciliation, not blind rollback.

Exit status is `0` for a successful command, `1` for a diagnosed build/environment
failure, and `2` for argument errors. A successful `status` command exits `0`
even when its returned `latestAttempt` describes a failed build.

## Local effects and trust

The CLI does not access Obsidian's UI, change settings, deploy plugins, invoke
agent-workbench, send messages, or offer network/cloud features. It creates files
only under the chosen output root during builds; `doctor` and `status` create
nothing. Tests keep all generated data under project `tmp/`.

The recipe uses `latexmk -norc` and disables TeX shell escape. It places TeX cache
locations under the attempt. Configured executables, converter scripts, and raw
TeX still need to be trusted: this is a local build tool, not a security sandbox.
Captured process output is bounded to 20 MiB; the configured timeout applies to
each external process. Timeout termination is process-group based on Linux;
Windows child-tree behavior is not verified. In-process structural conversion
has a 4 MiB body limit and bounded recursive nesting; `--timeout-ms` is not a
wall-clock timeout for that synchronous conversion stage.

## Verification

From the **repository root**:

```sh
npm run test:fast
npm test
```

The full suite exercises real CLI processes, structural conversion and a local
external-adapter fixture, TeX/BibTeX, Poppler checks and guarded round trips.
Headless host tests do not interact with a running Obsidian instance. Generated
fixtures and subprocess evidence stay under project `tmp/`. See
[contributing](../CONTRIBUTING.md) for targeted checks and dependencies.
