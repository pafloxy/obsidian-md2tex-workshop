# Markdown authoring contract

The [round-trip editing workflow](roundtrip.md) adds an explicit `{=latex}` pass-through fence. Ordinary language-tagged code fences retain their literal-code meaning. Opaque-island reference resolution is checked in the final compiler log.

This is the tested subset of the standalone CLI, not a change to your live
Obsidian installation. Markdown remains the drafting source. Existing notes are
never rewritten. Explicit IDs, rather than title-derived automatic labels, mean
that editing a title cannot silently change its reference target.

## Working example

````markdown
# Results
<!-- [label{sec:results}] -->

Research & development retained 50% of the sample. The variable is $x_1$.
The filename is `file_name`. See [ref{lem:identity}] before its declaration.

> [!lemma] Identity
> <!-- [label{lem:identity}] -->
> For every $x_1$, we have $x_1=x_1$.
>
> > [!proof]
> > Equality is reflexive.

> [!equation]
> <!-- [label{eq:identity}] -->
> $$
> x_1=x_1
> $$

See [ref{sec:results,lem:identity}] and [ref{eq:identity}].
[todo{check $[x_1,y_1]$ at 50% & retain the context}].

```text
[ref{ghost}] $x_1$ [label{ghost}] is literal code here.
```
````

Build the [uniform drafting fixture](../testing/fixtures/cli/uniform-authoring.md)
from the project root:

```sh
node scripts/workshop.cjs build testing/fixtures/cli/uniform-authoring.md --out-dir tmp/uniform-authoring
```

## Commands and ordinary viewers

The canonical command grammar is `[command{argument}]`: `[label{sec:results}]` declares a target, `[ref{sec:results}]` exports `\cref`, `[cite{author2026}]` exports `\cite`, and `[todo{check units}]` exports a visible annotation. References and citations accept comma-separated keys. Braces group arguments; backslashes protect escaped characters. Commands are inactive inside code, ordinary comments and raw TeX fences. A label comment is the one deliberate exception described below.

Label lines normally use `<!-- [label{identifier}] -->`. Ordinary Markdown viewers hide HTML comments; the formula contains only math. The equivalent bare `[label{identifier}]` line is accepted when visible metadata is useful. Titles use the native form `> [!lemma] Conservation lemma`: the closing `]` separates the type from its title, and the newline ends the title. Math and simple emphasis are allowed in titles. Pipe fields and `[title{...}]` are rejected instead of guessed to be labels or titles.

The workshop only converts documents; it installs no preview renderer. Stock Obsidian renders callouts, using its default callout style for unknown types. VS Code and GitHub may show the callout marker in a blockquote. The title and formula remain ordinary Markdown content. `[ref{...}]`, `[cite{...}]` and `[todo{...}]` remain visible draft commands; numbers and bibliography entries resolve in LaTeX/PDF. Hidden label comments create no native Markdown anchors or clickable references. Reading views hide comments, while editing views can expose their source.

Put a blank line between adjacent callouts and keep every line inside a callout explicitly quoted with `>`. Put metadata on its own line, never after a closing `$$` delimiter. Write literal command examples in backticks: backslash-escaping `\[` would open TeX display math in this converter. Keep commands separate with spaces; adjacent bracket tokens can become Markdown links. Reference-style link definitions are rejected, including definitions that could capture a command token.

## Supported forms

| Input | Export behavior |
| --- | --- |
| Ordinary `%`, `&`, `_`, `#`, braces and other TeX-special prose characters | Escaped as literal text. Existing explicit TeX escapes remain accepted. |
| `$...$`, `\(...\)`, `$$...$$`, `\[...\]` | Mathematical contents remain raw. Plain display math is unnumbered and cannot contain labels. Use an equation callout for a numbered display, or a raw TeX fence for advanced numbered environments. |
| Raw TeX macros and standalone `\begin{...}` blocks | Arguments/environments are protected from Markdown conversion. The selected preamble must supply required definitions. TeX remains trusted, not sandboxed. |
| Backtick code spans and backtick/tilde fences | Literal characters stay literal; labels/references/callouts inside them are inactive. Code spans normalize newlines to spaces; fences retain line content. No syntax highlighting. |
| `#` through `######` headings | Section through subparagraph commands. Explicit targets are supported on the first three levels; deeper headings are unnumbered in the default recipe. |
| `*emphasis*`, `_emphasis_`, `**strong**`, `__strong__` | Nested simple formatting; intraword underscores stay literal. This is not the complete CommonMark delimiter algorithm. |
| Space-indented ordered/unordered lists and explicit `>` quotes | Nested TeX containers. Ordered lists start at the first supplied number, then number consecutively. Use explicit indentation; lazy continuation and tab-based layouts are not fully supported. |
| Theorem/lemma/definition/proposition/corollary/example/remark/property/proof callouts | Named environments with optional titles. Abbreviations `thm`, `lem`, `def`, `prop`, `cor`, `ex`, `rem` work; `note` maps to `remark`. Nested and adjacent explicitly quoted callouts are supported. |
| `[!equation]` callout | One nonempty display, optionally preceded by one label declaration. Numbered even without a label. No title or body prose; use `aligned` or `split` inside its math for several rows sharing one number. |
| Other callout types | Unnumbered titled quotations with a `GENERIC_CALLOUT` warning. No invented custom theorem environment. Algorithm callouts do not gain pseudocode semantics. |
| `[ref{id}]`, `\cref{id}`, `\Cref{id}`, `\ref{id}`, `\eqref{id}` | Checked against the complete set of syntactically declared document labels. Forward and backward references behave equally. |
| `[cite{key}]`, raw TeX citations | Preserved citations. Empty/invalid simple keys fail early; actual bibliography resolution is checked through TeX/BibTeX and the final log. Declare files as described in the CLI guide. |
| `[printbibliography]` | One command on its own top-level line places the bibliography. Requires enabled YAML/control resources. Without the command, resources print at the end. Code/comments retain literal examples. |
| `[caption](https://...)`, HTTP/mailto variants, `[caption](#explicit-id)` | Caption and destination retained as hyperlinks without fetching them. URLs must be appropriately percent-encoded. |
| `[todo{...}]` | Visible bold annotation with parsed math/formatting inside it. No extra package or `\todo` definition required. |
| `<!-- ... -->`, `%% ... %%` | Comments excluded from export and declaration checks, with source lines retained. A whole-line label comment in its defined ownership position declares a target. Code/raw TeX regions keep their own literal/comment rules. |

Labels use nonempty literal IDs containing letters, digits, `:`, `.`, `_`, `/`,
or `-`. The same declaration attaches by position:

1. A heading label is on its immediately following line, without an intervening blank line.
2. A callout label is its first nonblank body line, before any prose, math, nested callout or ordinary comment.
3. A label elsewhere is an error; no label is attached by searching for a nearby construct.

Matching redundant IDs on one heading/callout collapse to one emitted label.
Different IDs on the same block, or reusing an ID across blocks, are errors.
Labels on proofs, generic unnumbered callouts, or deep headings are rejected
instead of referencing the preceding statement's counter. Advanced raw TeX still follows TeX's counter/expansion semantics.

## Existing files and round trips

The local structural converter uses this syntax directly, without a frontmatter dialect switch. New structural reverse conversions emit native titles, hidden label comments, and bracket-curly commands. Unchanged checkout blocks retain their exact source bytes. Supported TeX edits are accepted only after exact regeneration; complex TeX remains an explicit raw fence. Ordinary hidden comments that cannot be safely repositioned stop the preview. See [round-trip editing](roundtrip.md).

The older `[add-ref:...]`, `[add-cite:...]`, `[todo:...]`, `label::` and raw heading/callout label forms remain accepted as small existing input aliases; the new grammar does not depend on them. Two ambiguous forms deliberately fail: callout pipe labels and labels inside Markdown math. Move their IDs to a leading label line, wrapping numbered math in an equation callout. No files are automatically migrated, and the separately selected external legacy converter does not support this grammar. Old editing checkpoints keep their converter-hash guard and need their original converter or a fresh checkout after explicit source adaptation.

## Deliberate limits and safe failure

- Images and Obsidian embeds await M3 asset resolution. They fail with their
  source line; missing figures cannot masquerade as successfully exported text.
- Wiki-links, relative note/file links, reference-style links, Markdown tables,
  HTML other than comments, Markdown footnotes, indented code, and setext/underlined headings have
  explicit unsupported diagnostics. Use a supported representation or retain
  the source for an extension; there is no automatic migration.
- Unclosed math, code, comments, links, TODOs, callout headers, raw arguments, and
  environments are diagnosed. A literal currency sign is `\$`. Unknown Markdown
  extensions are not comprehensively recognized.
- Put raw TeX environments in their own block or inside explicit math delimiters.
  Raw macro arguments are not prose-escaped: `\textbf{50%}` still has TeX's
  comment behavior. Use `\textbf{50\%}` or Markdown `**50%**`.
- Code is now truly literal. The old code-span workaround `file\_name` includes
  its backslash in the output; write `file_name` for the ordinary filename.
- Fences containing TeX's literal `\end{verbatim}` sentinel are rejected. Raw
  code packages such as `minted` need their own compatible setup; shell escape
  remains disabled. The converter does not install packages.
- Raw includes, external-document labels, dynamic macro-generated IDs, custom
  catcodes, and arbitrary TeX expansion are not statically resolved. Complex
  authoring may require a TeX workflow or the explicit legacy adapter until a
  tested extension exists. The declaration table is not a TeX interpreter.
- The basic article default supports the documented math, statement and reference
  syntax. The broader EPTCS recipe remains explicitly selectable. Custom preambles must provide
  the environments/macros (`amsthm`, `hyperref`, etc.) required by their content.
  Named profile capability checks belong to M3.
- Maps identify original lines or line ranges, not character positions. External
  files and preamble errors are not falsely attributed to Markdown.
- The body is limited to 4 MiB; parser recursion is bounded. TeX can impose lower
  list/environment nesting limits. Process timeouts do not cover synchronous parsing.

Source, diagnostics, and the previous successful PDF remain available on failure.
This bounded subset is not full CommonMark, Obsidian, or arbitrary-TeX compatibility.

## Parser design

A bounded local parser protects TeX, comments and literal code before rendering.
Changing its grammar requires paired forward and inverse tests. It deliberately
does not claim complete CommonMark or Obsidian compatibility. See
[architecture](architecture.md) and [contributing](../CONTRIBUTING.md).
