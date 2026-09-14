/**
 * Public converter/inverse contracts for native-viewer authoring.
 * Usage from the project root: node --test testing/syntax.test.cjs
 * No filesystem writes, external viewers or TeX subprocesses in this focused suite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { convertMarkdown } = require('../src/core/markdown.cjs');
const { render, recover } = require('../src/core/reverse.cjs');

/** Convert a source body at its actual frontmatter-adjusted physical line. */
function convert(body, bodyStartLine = 1) {
  return convertMarkdown({ body, bodyStartLine }, 'draft.md');
}

/** Require a usable document; missing references in isolated block tests may be deferred. */
function valid(body) {
  const result = convert(body);
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), []);
  return result;
}

const document = '# Results\n<!-- [label{sec:results}] -->\n\n' +
  'See [ref{lem:bound, eq:bound}] and [cite{author2026}].\n\n' +
  '> [!lemma] Bound on $[a,b]$ with **units**\n> <!-- [label{lem:bound}] -->\n> The bound holds.\n>\n> > [!proof]\n> > By equality.\n\n' +
  '> [!equation]\n> <!-- [label{eq:bound}] -->\n> $$\n> x^2 \\geq 0\n> $$\n\n' +
  '$$\ny^2 \\geq 0\n$$\n\n' +
  'See [ref{sec:results}]. [todo{Check **units** at 50% and $[a,b]$}].\n';

test('uniform declarations resolve across sections, statements and explicit equations', () => {
  const result = valid(document);
  assert.deepEqual(result.document.labels.map(label => label.id), ['sec:results', 'lem:bound', 'eq:bound']);
  assert.match(result.tex, /\\cref\{lem:bound,eq:bound\}/);
  assert.match(result.tex, /\\cite\{author2026\}/);
  assert.match(result.tex, /\\begin\{equation\}\n\\label\{eq:bound\}\nx\^2/);
  assert.match(result.tex, /\\\[\ny\^2/);
  assert.doesNotMatch(result.tex, /<!--|\[label\{|\[ref\{|\[cite\{/);
  const equation = result.document.children.find(node => node.environment === 'equation');
  const mapped = result.lines.find(item => result.tex.split('\n')[item.bodyLine - 1] === 'x^2 \\geq 0');
  assert.equal(mapped.line, equation.math.line + 1);
  assert.equal(result.segments[0].endLine, 2);
});

test('labels have identical semantics with or without the HTML comment wrapper', () => {
  const visible = document.replace(/<!-- (\[label\{[^}]+\}\]) -->/g, '$1');
  assert.equal(valid(visible).tex, valid(document).tex);
});

test('command arguments protect code delimiters and keep nested mathematical braces', () => {
  const result = valid('[todo{Check `}` and ``{`}`` with $\\frac{x}{y}$ and $\\{x,y\\}$}].');
  assert.match(result.tex, /\\texttt\{\\\}\}/);
  assert.match(result.tex, /\$\\frac\{x\}\{y\}\$/);
  assert.match(result.tex, /\$\\\{x,y\\\}\$/);
});

test('malformed commands, ownership and renderer collisions fail at the source line', () => {
  const cases = [
    ['[label{orphan}]', 'UNSCOPED_LABEL', 1],
    ['<!-- [label{orphan}] -->', 'UNSCOPED_LABEL', 1],
    ['# A\n\n<!-- [label{orphan}] -->', 'UNSCOPED_LABEL', 3],
    ['# A\n<!-- [label{bad id}] -->', 'INVALID_LABEL', 2],
    ['# A\n[label{a,b}]', 'INVALID_LABEL', 2],
    ['# A\n[label{a}]\n[label{b}]', 'CONFLICTING_LABEL', 3],
    ['# A\n[label{a}]\n\n# B\n[label{a}]', 'DUPLICATE_LABEL', 5],
    ['> [!proof]\n> <!-- [label{p}] -->\n> Holds.', 'UNNUMBERED_LABEL', 2],
    ['> [!lemma|lem:a]\n> Holds.', 'CALLOUT_METADATA', 1],
    ['> [!lemma] [title{Bound}]\n> Holds.', 'UNKNOWN_DIRECTIVE', 1],
    ['> [!lemma]\n> Holds.\n> [label{late}]', 'UNSCOPED_LABEL', 3],
    ['See [ref{}].', 'UNRESOLVED_REFERENCE', 1],
    ['[cite{}]', 'INVALID_CITATION', 1],
    ['[todo{}]', 'EMPTY_TODO', 1],
    ['[ref{a]', 'INVALID_DIRECTIVE', 1],
    ['[ref{a}', 'INVALID_DIRECTIVE', 1],
    ['[ref a]', 'INVALID_DIRECTIVE', 1],
    ['[lable{a}]', 'UNKNOWN_DIRECTIVE', 1],
    ['[ref{a}]: https://example.org', 'DIRECTIVE_LINK_COLLISION', 1],
    ['[ref{a}](https://example.org)', 'DIRECTIVE_LINK_COLLISION', 1],
    ['[ref{a}][ref{b}]', 'DIRECTIVE_LINK_COLLISION', 1],
    ['[ordinary]: https://example.org', 'UNSUPPORTED_REFERENCE_LINK', 1],
    ['<!-- unfinished', 'UNCLOSED_COMMENT', 1],
    ['# A\n<!-- [label{a}] extra -->', 'INVALID_LABEL_DIRECTIVE', 2],
    ['# A <!-- [label{a}] -->', 'UNSCOPED_LABEL', 1],
  ];
  for (const [body, code, line] of cases) {
    const result = convert(body, 4);
    assert.ok(result.diagnostics.some(item => item.code === code && item.line === line + 3), `${body}: ${JSON.stringify(result.diagnostics)}`);
  }
});

test('plain math cannot acquire a counter and equation bodies have one explicit meaning', () => {
  const cases = [
    ['$$\n\\label{eq:a}\nx=1\n$$', 'LABEL_IN_MATH'],
    ['$$\\begin{equation}x=1\\end{equation}$$', 'NUMBERED_ENVIRONMENT_IN_MATH'],
    ['$[ref{a}]$', 'DIRECTIVE_IN_MATH'],
    ['> [!equation]\n> x=1', 'EQUATION_BODY'],
    ['> [!equation]\n> $$ $$', 'EQUATION_BODY'],
    ['> [!equation]\n> $$x=1$$ and text', 'EQUATION_BODY'],
    ['> [!equation]\n> $$x=1$$\n> $$y=2$$', 'EQUATION_BODY'],
    ['> [!equation] A title\n> $$x=1$$', 'EQUATION_TITLE'],
    ['> [!equation]\n> $$\\begin{align}x&=1\\end{align}$$', 'NESTED_EQUATION'],
    ['> [!equation]\n> $$\n> \\label{a}\n> x=1\n> $$', 'LABEL_IN_MATH'],
  ];
  for (const [body, code] of cases) assert.ok(convert(body).diagnostics.some(item => item.code === code), body);
  assert.match(valid('> [!equation]\n> $$x=1$$').tex, /\\begin\{equation\}\nx=1\n\\end\{equation\}/);
  assert.match(valid('> [!equation]\n> $$\n> \\begin{aligned}\n> x&=1\\\\\n> y&=2\n> \\end{aligned}\n> $$').tex, /\\begin\{aligned\}/);
});

test('code, raw TeX and ordinary comments protect command-looking literals', () => {
  const body = '`[label{a}] [ref{ghost}]`\n\n```text\n[label{a}] [ref{ghost}]\n```\n\n' +
    '<!--\n[ref{ghost}]\n\n[!lemma]\n-->\n\n%% [ref{ghost}] %%\n\n' +
    '```{=latex}\n\\begin{equation}\n\\label{raw:a}\nx=1\n\\end{equation}\n```\n';
  const result = valid(body);
  assert.equal(result.document.references.length, 0);
  assert.equal(result.document.labels.length, 0);
  assert.match(result.tex, /\\label\{raw:a\}/);
});

test('HTML comments cannot split a quoted callout or leak into exported text', () => {
  const result = valid('> [!lemma] Test\n> <!--\n> [!proof]\n> [ref{ghost}]\n> -->\n> Holds.\n> [!proof]\n> Indeed.');
  assert.equal(result.document.children.length, 2);
  assert.doesNotMatch(result.tex, /ghost/);
  assert.equal((result.tex.match(/\\begin\{proof\}/g) || []).length, 1);
});

test('unchanged source is byte-exact and source edits retain labels, folding and comments', () => {
  const source = document.replace('[!lemma]', '[!lemma]-').replace('The bound holds.', 'The bound <!-- retain me --> holds.');
  const before = render(source);
  assert.equal(recover(source, before, before).markdown, source);
  const after = before.replace('x^2', 'x^4');
  const result = recover(source, before, after);
  assert.equal(render(result.markdown), after);
  assert.ok(result.markdown.includes('<!-- retain me -->'));
  assert.ok(result.markdown.includes('[!lemma]-'));
  assert.ok(result.markdown.includes('<!-- [label{eq:bound}] -->'));
});

test('new generated TeX returns to canonical commands and numbered equation callouts', () => {
  const tex = render(document);
  const result = recover('', '', tex);
  assert.equal(result.method, 'structural-inverse');
  assert.equal(render(result.markdown), tex);
  for (const expected of ['<!-- [label{sec:results}] -->', '[!equation]', '[ref{lem:bound,eq:bound}]', '[cite{author2026}]', '[todo{Check']) assert.ok(result.markdown.includes(expected), expected);
  assert.doesNotMatch(result.markdown, /\\label|add-ref|add-cite|\[!lemma\|/);
});

test('simultaneous title, label, formula and reference edits regenerate exactly', () => {
  const source = '> [!lemma] Old title\n> <!-- [label{lem:old}] -->\n> See [ref{lem:old}]: $x^2$.\n';
  const before = render(source);
  const after = before.replaceAll('Old title', 'New title').replaceAll('lem:old', 'lem:new').replaceAll('x^2', 'x^4');
  const result = recover(source, before, after);
  assert.equal(result.method, 'structural-inverse');
  assert.equal(render(result.markdown), after);
  assert.ok(result.markdown.includes('<!-- [label{lem:new}] -->'));
  assert.ok(result.markdown.includes('[ref{lem:new}]'));
});

test('structural rewrites never discard unpositionable Markdown-only comments', () => {
  const source = '> [!lemma] Old\n> <!-- [label{lem:a}] -->\n> A <!-- keep --> fact.\n';
  const before = render(source);
  assert.throws(() => recover(source, before, before.replace('lemma', 'theorem').replace('Old', 'New')), { code: 'MD_ONLY_CONTENT' });
});

test('unsupported TeX math remains exact in a raw island instead of inventing draft syntax', () => {
  const tex = '\\begin{align}\n\\label{eq:a}\nx&=1\\\\\ny&=2\n\\end{align}\n\n';
  const result = recover('', '', tex);
  assert.equal(result.method, 'raw-tex');
  assert.equal(render(result.markdown), tex);
});
