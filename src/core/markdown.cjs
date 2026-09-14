/**
 * Source-positioned workshop Markdown, deliberately not a full CommonMark engine.
 * Example: convertMarkdown({ body: '# Draft\n\n50% of $x_1$.', bodyStartLine: 1 }, 'draft.md');
 * Pure conversion: no filesystem, TeX execution, vault lookup, or source mutation.
 */

/** Escape literal prose/code, never raw TeX or mathematical spans. */
function escapeText(text) {
  const escapes = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '_': '\\_', '#': '\\#', '$': '\\$', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}' };
  return text.replace(/[\\{}%&_#$^~<>|]/g, char => escapes[char]);
}

/** Count physical newlines, including inside protected source spans. */
function newlines(text) { return (text.match(/\n/g) || []).length; }

/** Remove TeX comments while preserving physical newlines and escaped percent signs. */
function visibleTex(text) {
  return text.split('\n').map(original => {
    let visible = '';
    for (let i = 0; i < original.length; i++) {
      if (original[i] === '%') break;
      visible += original[i];
      if (original[i] === '\\' && i + 1 < original.length) visible += original[++i];
    }
    return visible;
  }).join('\n');
}

const environments = { theorem: 'theorem', thm: 'theorem', lemma: 'lemma', lem: 'lemma', definition: 'definition', def: 'definition', proposition: 'proposition', prop: 'proposition', corollary: 'corollary', cor: 'corollary', example: 'example', ex: 'example', remark: 'remark', rem: 'remark', note: 'remark', property: 'property', proof: 'proof' };
const validId = /^[a-zA-Z0-9:._/-]+$/;
environments.equation = 'equation';

/** Parse protected spans before interpreting Markdown punctuation. */
class DocumentParser {
  /** Keep diagnostics and declarations local to one immutable source snapshot. */
  constructor(filename) { this.filename = filename; this.diagnostics = []; this.labels = []; this.references = []; this.citations = []; this.bibliographies = []; }

  /** Attach an actionable diagnostic to an original Markdown line. */
  report(code, message, line, severity = 'error') {
    this.diagnostics.push({ severity, code, stage: 'conversion', message, path: this.filename, line });
  }

  /** Find a closing delimiter while respecting TeX escapes and line comments. */
  closing(text, delimiter, start, tex = false) {
    for (let i = start; i < text.length; i++) {
      if (text.startsWith(delimiter, i)) return i;
      if (tex && text[i] === '%') { const end = text.indexOf('\n', i); if (end < 0) return -1; i = end; }
      else if (text[i] === '\\') i++;
    }
    return -1;
  }

  /** Read balanced raw-TeX arguments without rewriting their contents. */
  groupEnd(text, start, tex = true) {
    const close = { '{': '}', '[': ']', '(': ')' }[text[start]];
    let depth = 1;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (!tex && text[i] === '`') {
        const fence = text.slice(i).match(/^`+/)[0];
        let end = text.indexOf(fence, i + fence.length);
        while (end >= 0 && (text[end - 1] === '`' || text[end + fence.length] === '`')) end = text.indexOf(fence, end + 1);
        if (end < 0) return -1;
        i = end + fence.length - 1; continue;
      }
      if (tex && text[i] === '%') { const end = text.indexOf('\n', i); if (end < 0) return -1; i = end; continue; }
      if (text[i] === text[start]) depth++;
      if (text[i] === close && --depth === 0) return i + 1;
      // Only closing characters change nesting on their own.
      if (text[i] === close && depth < 0) return -1;
    }
    return -1;
  }

  /** Read one reserved bracket command; braces balance and backslashes protect literals. */
  directive(text, line) {
    const opening = text.match(/^\[([a-zA-Z][a-zA-Z-]*)\{/);
    if (!opening) return null;
    const end = this.groupEnd(text, opening[0].length - 1, false);
    if (end < 0 || text[end] !== ']') {
      this.report('INVALID_DIRECTIVE', 'Complete the command as [command{argument}].', line);
      return { name: opening[1], value: '', length: text.length, invalid: true };
    }
    const name = opening[1];
    if (!['label', 'ref', 'cite', 'todo'].includes(name)) this.report('UNKNOWN_DIRECTIVE', `Unknown command ${name}; use label, ref, cite or todo. Titles follow the callout marker.`, line);
    return { name, value: text.slice(opening[0].length, end - 1), length: end + 1 };
  }

  /** Recognize a whole-line declaration, optionally hidden by a native HTML comment. */
  labelLine(text, line) {
    let value = text.trim();
    if (value.startsWith('<!--') && value.endsWith('-->')) value = value.slice(4, -3).trim();
    if (!value.startsWith('[label{')) return null;
    const directive = this.directive(value, line);
    if (directive.invalid || directive.length !== value.length) this.report('INVALID_LABEL_DIRECTIVE', 'Use one complete [label{identifier}] on its own line, optionally inside <!-- ... -->.', line);
    return { id: directive.value.trim(), line };
  }

  /** Require a single unwrapped display so numbering and label ownership are deterministic. */
  equation(node) {
    const spans = node.children.flatMap(child => child.type === 'paragraph' ? child.spans : [child]);
    const content = spans.filter(span => !(span.type === 'text' && !span.value.trim()));
    if (node.spans.length) this.report('EQUATION_TITLE', 'Equation callouts have no title argument; put explanatory prose before the callout.', node.line);
    if (content.length !== 1 || content[0].type !== 'math' || !content[0].display || !visibleTex(content[0].value).trim()) {
      this.report('EQUATION_BODY', 'An equation callout needs exactly one nonempty $$ display and no prose or nested callouts.', node.line);
      return;
    }
    node.math = content[0];
    if (/\\(?:begin|end)\{(?:equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|displaymath)\}/.test(visibleTex(node.math.value))) this.report('NESTED_EQUATION', 'Use aligned or split inside one equation; retain independently numbered environments in a raw TeX fence.', node.math.line);
  }

  /** Extract explicit TeX declarations/references, ignoring TeX line comments. */
  scanRaw(text, firstLine) {
    for (const [offset, visible] of visibleTex(text).split('\n').entries()) {
      for (const match of visible.matchAll(/(?<!\\)\\(label|[cC]ref|ref|eqref|pageref|autoref|nameref|cite[a-zA-Z]*)(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
        const items = match[1] === 'label' ? this.labels : match[1].startsWith('cite') ? this.citations : this.references;
        for (const id of match[2].split(',').map(value => value.trim())) items.push({ id, line: firstLine + offset });
      }
    }
  }

  /** Collapse redundant equivalent callout IDs, but never choose between conflicts. */
  attachLabel(node, declarations) {
    const ids = [...new Set(declarations.map(item => item.id))];
    if (ids.length > 1) this.report('CONFLICTING_LABEL', `This block declares conflicting IDs: ${ids.join(', ')}. Keep one explicit target.`, declarations[1].line);
    if (ids.length) {
      node.label = declarations[0];
      this.labels.push(node.label);
      if ((node.type === 'callout' && (!node.environment || node.environment === 'proof')) || (node.type === 'heading' && node.level > 3)) this.report('UNNUMBERED_LABEL', 'This block has no supported reference counter. Put the label on its numbered statement/section.', node.label.line);
    }
  }

  /** Collect declarations from opaque math/TeX and rendered inline tokens. */
  collectSpans(spans) {
    for (const span of spans) {
      if (span.type === 'text') {
        if (/^\s*label::/.test(span.value)) this.report('UNSCOPED_LABEL', 'Place label:: immediately after a heading or at the start of a callout body.', span.line);
        if (/^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)+\s*$/.test(span.value)) this.report('UNSUPPORTED_TABLE', 'Markdown tables need a dedicated table renderer; use a raw TeX table for now.', span.line);
        if (/<(?:\/?[a-zA-Z][^>]*|!--.*?)>/.test(span.value)) this.report('UNSUPPORTED_HTML', 'HTML is not converted to TeX. Use Markdown prose or an explicit raw TeX block.', span.line);
        if (/\[\^[^\]]+\]/.test(span.value)) this.report('UNSUPPORTED_FOOTNOTE', 'Markdown footnotes are not supported yet; raw TeX footnotes remain available.', span.line);
      }
      if (span.type === 'label') this.report('UNSCOPED_LABEL', 'Place a whole-line label immediately below a heading or at the start of a callout body.', span.line);
      if (span.type === 'math' && /(?<!\\)\\label\{/.test(visibleTex(span.value))) this.report('LABEL_IN_MATH', 'Move the label outside math: use an [!equation] callout with a leading <!-- [label{eq:id}] --> line, or an explicit raw TeX fence.', span.line);
      if (span.type === 'math' && /\\begin\{(?:equation|align|alignat|flalign|gather|multline)\}/.test(visibleTex(span.value))) this.report('NUMBERED_ENVIRONMENT_IN_MATH', 'Use an equation callout for one number or a raw TeX fence for independently numbered environments.', span.line);
      if (span.type === 'math' && /\[(?:(?:label|ref|cite|todo)\{|printbibliography\])/.test(visibleTex(span.value))) this.report('DIRECTIVE_IN_MATH', 'Place authoring commands outside math delimiters.', span.line);
      if (span.type === 'raw' || span.type === 'math') this.scanRaw(span.value, span.line);
      else if (span.type === 'reference' || span.type === 'citation') {
        for (const id of span.value.split(',').map(value => value.trim())) (span.type === 'reference' ? this.references : this.citations).push({ id, line: span.line });
      }
      if (span.type === 'link' && span.target.startsWith('#')) this.references.push({ id: span.target.slice(1), line: span.line });
      if (span.children) this.collectSpans(span.children);
    }
  }

  /** Check the complete document so forward and backward references are equivalent. */
  validate() {
    for (const node of this.bibliographies.slice(1)) this.report('DUPLICATE_BIBLIOGRAPHY', 'Use at most one [printbibliography] block.', node.line);
    const declared = new Map();
    for (const label of this.labels) {
      if (!validId.test(label.id)) this.report('INVALID_LABEL', `Use a nonempty literal label ID (letters, digits, : . _ / -): ${label.id}`, label.line);
      if (declared.has(label.id)) this.report('DUPLICATE_LABEL', `Label ${label.id} is already declared at line ${declared.get(label.id)}.`, label.line);
      else declared.set(label.id, label.line);
    }
    for (const ref of this.references) {
      if (!validId.test(ref.id) || !declared.has(ref.id)) {
        const deferred = this.hasOpaqueTex && validId.test(ref.id);
        this.report(deferred ? 'REFERENCE_DEFERRED_TO_TEX' : 'UNRESOLVED_REFERENCE', deferred ? `Raw TeX may declare ${ref.id}; the final compiler log must resolve this reference.` : `No declared target for ${ref.id || '(empty reference)'}.`, ref.line, deferred ? 'warning' : 'error');
      }
    }
    for (const cite of this.citations) if (!validId.test(cite.id)) this.report('INVALID_CITATION', `Use a nonempty literal citation key: ${cite.id}`, cite.line);
  }

  /** Split inline text into opaque literals/math/TeX and escaped prose spans. */
  inline(text, firstLine, depth = 0) {
    if (depth > 48) { this.report('NESTING_LIMIT', 'Inline nesting exceeds 48 levels.', firstLine); return []; }
    const spans = [];
    let i = 0;
    let line = firstLine;
    /** Retain a span and advance through its exact source extent. */
    const push = (type, end, value = text.slice(i, end), extra = {}) => {
      const endLine = line + newlines(text.slice(i, end));
      const previous = spans.at(-1);
      if (type === 'text' && previous?.type === 'text' && previous.line === line) { previous.value += value; previous.endLine = endLine; }
      else spans.push({ type, value, line, endLine, ...extra });
      line = endLine; i = end;
    };
    while (i < text.length) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) { this.report('UNCLOSED_COMMENT', 'Close the HTML <!-- ... --> comment.', line); push('comment', text.length); }
        else {
          const content = text.slice(i + 4, end).trim();
          if (content.startsWith('[label{')) this.report('UNSCOPED_LABEL', 'Put label metadata on its own line immediately below a heading or at the start of a callout body.', line);
          push('comment', end + 3);
        }
        continue;
      }
      if (text.startsWith('%%', i)) {
        const end = text.indexOf('%%', i + 2);
        if (end < 0) { this.report('UNCLOSED_COMMENT', 'Close the Obsidian %% comment.', line); push('comment', text.length); }
        else push('comment', end + 2);
        continue;
      }
      if (text.startsWith('[printbibliography]', i)) {
        this.report('BIBLIOGRAPHY_PLACEMENT', 'Put [printbibliography] on its own top-level line; use backticks for a literal example.', line);
        push('text', i + '[printbibliography]'.length); continue;
      }
      const directive = this.directive(text.slice(i), line);
      if (directive) {
        const following = text[i + directive.length];
        const definition = following === ':' && !text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim();
        if (definition || ['[', '('].includes(following)) this.report('DIRECTIVE_LINK_COLLISION', 'Separate authoring commands from Markdown link syntax; use backticks for literal examples.', line);
        const type = { label: 'label', ref: 'reference', cite: 'citation', todo: 'todo' }[directive.name] || 'text';
        const children = type === 'todo' ? this.inline(directive.value, line, depth + 1) : undefined;
        if (type === 'todo' && !directive.value.trim()) this.report('EMPTY_TODO', 'A todo command needs annotation text.', line);
        const value = ['reference', 'citation', 'label'].includes(type) ? directive.value.split(',').map(id => id.trim()).join(',') : directive.value;
        push(type, i + directive.length, value, children ? { children } : {});
        continue;
      }
      if (/^\[(?:label|ref|cite|todo)(?:[}\]\s]|$)/.test(text.slice(i))) this.report('INVALID_DIRECTIVE', 'Use [command{argument}] with braces around the argument.', line);
      const reference = text.slice(i).match(/^\[add-(ref|cite)(?::([^\]]*))?\]/);
      if (reference) { push(reference[1] === 'ref' ? 'reference' : 'citation', i + reference[0].length, reference[2] || ''); continue; }
      const todo = text.slice(i).match(/^\[todo:\s*/i);
      if (todo) {
        const end = this.groupEnd(text, i, false);
        if (end < 0) { this.report('UNCLOSED_TODO', 'Close the TODO annotation brackets.', line); push('text', text.length); }
        else push('todo', end, '', { children: this.inline(text.slice(i + todo[0].length, end - 1), line, depth + 1) });
        continue;
      }
      if (text.startsWith('[[', i) || text.startsWith('![[', i)) {
        const end = text.indexOf(']]', i);
        const embed = text[i] === '!';
        this.report(embed ? 'UNSUPPORTED_IMAGE' : 'UNSUPPORTED_WIKILINK', embed ? 'Obsidian embeds require asset resolution in M3.' : 'Cross-note wiki-links need vault/anchor resolution; use an explicit local label reference or HTTP link for now.', line);
        if (end < 0) this.report('UNCLOSED_LINK', 'Close the wiki-link brackets.', line);
        push(embed ? 'image' : 'wiki', end < 0 ? text.length : end + 2); continue;
      }
      if (text[i] === '[' || text.startsWith('![', i)) {
        const embed = text[i] === '!';
        const captionStart = i + (embed ? 1 : 0);
        const captionEnd = this.groupEnd(text, captionStart, false);
        if (captionEnd >= 0 && text[captionEnd] === '(') {
          const end = this.groupEnd(text, captionEnd, false);
          if (end < 0) { this.report('UNCLOSED_LINK', 'Close the Markdown link destination.', line); push('text', text.length); continue; }
          let target = text.slice(captionEnd + 1, end - 1);
          if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
          if (embed) this.report('UNSUPPORTED_IMAGE', 'Figure resolution belongs to M3; no image will be silently omitted.', line);
          else {
            if (target.startsWith('#')) {
              try { target = '#' + decodeURIComponent(target.slice(1)); }
              catch { this.report('INVALID_LINK', 'Invalid percent-encoded local link target.', line); }
            } else {
              try { if (!['http:', 'https:', 'mailto:'].includes(new URL(target).protocol)) throw new Error('Unsupported scheme'); }
              catch { this.report('UNSUPPORTED_LINK_TARGET', 'Use an HTTP(S)/mailto URL or #explicit-label; relative note/file links need a resolver.', line); }
            }
            if (/[\\{}\s<>]/.test(target)) this.report('INVALID_LINK', 'Link destinations must not contain whitespace, braces, or backslashes; percent-encode those characters.', line);
          }
          const children = this.inline(text.slice(captionStart + 1, captionEnd - 1), line, depth + 1);
          push(embed ? 'image' : 'link', end, '', { target, children }); continue;
        }
        if (captionEnd >= 0 && (text[captionEnd] === '[' || text[captionEnd] === ':')) this.report('UNSUPPORTED_REFERENCE_LINK', 'Reference-style Markdown links and definitions need a resolver; use an inline link for now.', line);
      }
      if (text[i] === '`') {
        const fence = text.slice(i).match(/^`+/)[0];
        let end = text.indexOf(fence, i + fence.length);
        while (end >= 0 && (text[end - 1] === '`' || text[end + fence.length] === '`')) end = text.indexOf(fence, end + 1);
        if (end < 0) { this.report('UNCLOSED_CODE', 'Close the inline code delimiter.', line); push('text', text.length); continue; }
        let value = text.slice(i + fence.length, end).replace(/\n/g, ' ');
        if (/^ .+ $/.test(value) && /\S/.test(value)) value = value.slice(1, -1);
        push('code', end + fence.length, value); continue;
      }
      const delimiter = text.startsWith('$$', i) ? '$$' : text[i] === '$' ? '$' : text.startsWith('\\[', i) ? '\\[' : text.startsWith('\\(', i) ? '\\(' : null;
      if (delimiter) {
        const close = { '\\[': '\\]', '\\(': '\\)' }[delimiter] || delimiter;
        const end = this.closing(text, close, i + delimiter.length, true);
        if (end < 0) { this.report('UNCLOSED_MATH', `Close ${delimiter} math; write \\$ for a literal currency sign.`, line); push('raw', text.length); continue; }
        push('math', end + close.length, text.slice(i + delimiter.length, end), { display: delimiter !== '$' && delimiter !== '\\(', delimiter }); continue;
      }
      if (text[i] === '\\') {
        const command = text.slice(i).match(/^\\(?:[a-zA-Z@]+\*?|[^\n])/);
        if (!command) { push('text', i + 1); continue; }
        if (command[0] === '\\begin' || command[0] === '\\end') this.report('INLINE_RAW_ENVIRONMENT', 'Put raw TeX environments in their own block or inside explicit math delimiters.', line);
        if (/^\\verb\*?$/.test(command[0])) {
          const delimiter = text[i + command[0].length];
          const end = delimiter ? text.indexOf(delimiter, i + command[0].length + 1) : -1;
          if (end < 0 || /\s|[a-zA-Z]/.test(delimiter || ' ')) { this.report('UNCLOSED_CODE', 'Complete the raw TeX verb delimiter.', line); push('text', text.length); }
          else push('raw-code', end + 1);
          continue;
        }
        let end = i + command[0].length;
        while (end < text.length) {
          const space = text.slice(end).match(/^[ \t]*/)[0].length;
          if (!['{', '['].includes(text[end + space])) break;
          const next = this.groupEnd(text, end + space);
          if (next < 0) { this.report('UNCLOSED_TEX_ARGUMENT', 'Close the raw TeX argument.', line); end = text.length; break; }
          end = next;
        }
        push('raw', end); continue;
      }
      push('text', i + 1);
    }
    return this.emphasis(spans);
  }

  /** Pair simple emphasis delimiters only in prose, never inside protected spans. */
  emphasis(spans) {
    const result = [];
    const stack = [{ children: result }];
    for (const span of spans) {
      if (span.type !== 'text') { stack.at(-1).children.push(span); continue; }
      const chunks = span.value.split(/(\*+|_+)/);
      for (let i = 0; i < chunks.length; i++) {
        const value = chunks[i];
        if (!value) continue;
        const marker = /^[*_]{1,2}$/.test(value);
        const before = chunks[i - 1]?.at(-1) || '';
        const after = chunks[i + 1]?.[0] || '';
        const intraword = value[0] === '_' && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after);
        if (marker && !intraword && stack.at(-1).marker === value && !/\s/.test(before)) {
          const completed = stack.pop();
          stack.at(-1).children.push({ type: value.length === 2 ? 'strong' : 'emphasis', children: completed.children, line: completed.line, endLine: span.endLine });
        } else if (marker && !intraword && !/\s/.test(after) && (after || i === chunks.length - 2)) {
          if (stack.length >= 48) { this.report('NESTING_LIMIT', 'Emphasis nesting exceeds 48 levels.', span.line); stack.at(-1).children.push({ ...span, value }); }
          else stack.push({ marker: value, children: [], line: span.line });
        } else stack.at(-1).children.push({ ...span, value });
      }
    }
    while (stack.length > 1) {
      const unclosed = stack.pop();
      stack.at(-1).children.push({ type: 'text', value: unclosed.marker, line: unclosed.line, endLine: unclosed.line }, ...unclosed.children);
    }
    return result;
  }

  /** Track opaque regions solely to distinguish adjacent quoted callout headers. */
  quoteBarrier(text, state) {
    const fence = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (state.fence) {
      if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !fence[2].trim()) state.fence = null;
    } else if (fence && !state.comment && !state.math && !state.code && !state.raw.length) state.fence = fence[1];
    else {
      for (let i = 0; i < text.length; i++) {
        if (state.code) { if (text.startsWith(state.code, i)) { i += state.code.length - 1; state.code = null; } continue; }
        if (state.comment) { if (text.startsWith(state.comment, i)) { i += state.comment.length - 1; state.comment = false; } continue; }
        if (state.math) {
          if (text.startsWith(state.math, i)) { i += state.math.length - 1; state.math = null; }
          else if (text[i] === '\\') i++;
          else if (text[i] === '%') break;
          continue;
        }
        const literalEnvironment = ['verbatim', 'verbatim*', 'lstlisting', 'minted'].includes(state.raw.at(-1));
        if (literalEnvironment) {
          const close = `\\end{${state.raw.at(-1)}}`;
          if (text.startsWith(close, i)) { state.raw.pop(); i += close.length - 1; }
          continue;
        }
        const environment = text.slice(i).match(/^\\(begin|end)\{([a-zA-Z*]+)\}/);
        if (environment) {
          if (environment[1] === 'begin') state.raw.push(environment[2]);
          else state.raw.pop();
          i += environment[0].length - 1; continue;
        }
        if (state.raw.length) { if (text[i] === '%') break; continue; }
        if (text.startsWith('<!--', i)) { state.comment = '-->'; i += 3; }
        else if (text.startsWith('%%', i)) { state.comment = '%%'; i++; }
        else if (text[i] === '`') { state.code = text.slice(i).match(/^`+/)[0]; i += state.code.length - 1; }
        else if (text.startsWith('$$', i)) { state.math = '$$'; i++; }
        else if (text[i] === '$') state.math = '$';
        else if (text.startsWith('\\[', i) || text.startsWith('\\(', i)) { state.math = text[i + 1] === '[' ? '\\]' : '\\)'; i++; }
        else if (text[i] === '\\') i++;
      }
    }
    return state.fence || state.comment || state.math || state.code || state.raw.length;
  }

  /** Parse block containers while retaining original physical line numbers. */
  blocks(lines, depth = 0) {
    if (depth > 48) { this.report('NESTING_LIMIT', 'Block nesting exceeds 48 levels.', lines[0]?.line || 1); return []; }
    const nodes = [];
    for (let i = 0; i < lines.length;) {
      const start = lines[i];
      const text = start.text;
      if (!text.trim()) { i++; continue; }
      if (/^ {0,3}\[printbibliography\][ \t]*$/.test(text)) {
        const node = { type: 'bibliography', line: start.line, endLine: start.line };
        if (depth) this.report('BIBLIOGRAPHY_PLACEMENT', 'Put [printbibliography] at the top level, outside lists and callouts.', start.line);
        this.bibliographies.push(node); nodes.push(node); i++; continue;
      }
      if (/^(?: {4}|\t)/.test(text)) this.report('UNSUPPORTED_INDENTED_CODE', 'Use a fenced code block for literal indented content.', start.line);
      if (/^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]?.text || '') && !/^ {0,3}#/.test(text)) this.report('UNSUPPORTED_SETEXT_HEADING', 'Use an explicit # heading instead of an underlined heading.', lines[i + 1].line);
      if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(text)) { nodes.push({ type: 'rule', line: start.line, endLine: start.line }); i++; continue; }
      const fence = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const content = [];
        let end = i + 1;
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
        while (end < lines.length && !close.test(lines[end].text)) content.push(lines[end++]);
        if (end === lines.length) this.report('UNCLOSED_FENCE', 'Close the fenced code block before building.', start.line);
        if (fence[2].trim() === '{=latex}') {
          this.hasOpaqueTex = true;
          nodes.push({ type: 'raw', line: start.line + 1, endLine: lines[Math.min(end, lines.length - 1)].line, value: content.map(item => item.text).join('\n'), opaque: true, sourceLine: start.line });
          i = end + 1; continue;
        }
        if (content.some(item => item.text.includes('\\end{verbatim}'))) this.report('CODE_TERMINATOR_COLLISION', 'Code contains the TeX verbatim terminator; a different literal-code renderer is required.', start.line);
        nodes.push({ type: 'code', line: start.line, endLine: lines[Math.min(end, lines.length - 1)].line, content, language: fence[2].trim() });
        i = end + 1; continue;
      }
      if (/^ {0,3}(?:%%|<!--)/.test(text)) {
        const comment = [start];
        let joined = text;
        const html = /^ {0,3}<!--/.test(text);
        const close = html ? '-->' : '%%';
        const offset = joined.indexOf(html ? '<!--' : '%%') + (html ? 4 : 2);
        while (joined.indexOf(close, offset) < 0 && i + 1 < lines.length) { comment.push(lines[++i]); joined += '\n' + lines[i].text; }
        const spans = this.inline(joined, start.line);
        this.collectSpans(spans);
        nodes.push({ type: 'paragraph', line: start.line, endLine: comment.at(-1).line, spans });
        i++; continue;
      }
      const displayStart = text.match(/^\s*(\$\$|\\\[)/);
      if (displayStart) {
        const delimiter = displayStart[1] === '$$' ? '$$' : '\\]';
        let joined = text;
        const offset = text.indexOf(displayStart[1]) + displayStart[1].length;
        const content = [start];
        while (this.closing(joined, delimiter, offset, true) < 0 && i + 1 < lines.length) { content.push(lines[++i]); joined += '\n' + lines[i].text; }
        const spans = this.inline(joined, start.line);
        this.collectSpans(spans);
        nodes.push({ type: 'paragraph', line: start.line, endLine: content.at(-1).line, spans });
        i++; continue;
      }
      const rawEnvironment = text.match(/^\s*\\begin\{([a-zA-Z*]+)\}/);
      if (rawEnvironment) {
        const content = [];
        const stack = [];
        const literal = ['verbatim', 'verbatim*', 'lstlisting', 'minted'].includes(rawEnvironment[1]);
        let complete = false;
        do {
          const current = lines[i++];
          content.push(current);
          if (literal) complete = current.text.includes(`\\end{${rawEnvironment[1]}}`);
          else {
            for (const token of visibleTex(current.text).matchAll(/(?<!\\)\\(begin|end)\{([a-zA-Z*]+)\}/g)) {
              if (token[1] === 'begin') stack.push(token[2]);
              else if (stack.pop() !== token[2]) this.report('MISMATCHED_ENVIRONMENT', `Mismatched raw TeX environment ${token[2]}.`, current.line);
            }
            complete = stack.length === 0;
          }
        } while (!complete && i < lines.length);
        if (!complete) this.report('UNCLOSED_ENVIRONMENT', `Close the ${rawEnvironment[1]} environment.`, start.line);
        const value = content.map(item => item.text).join('\n');
        if (!literal) this.scanRaw(value, start.line);
        nodes.push({ type: 'raw', line: start.line, endLine: content.at(-1).line, value });
        continue;
      }
      const heading = text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
      if (heading) heading[2] = heading[2].replace(/[ \t]+#+[ \t]*$/, '');
      if (/^ {0,3}>/.test(text)) {
        const quoted = [];
        const state = { fence: null, comment: false, math: null, code: null, raw: [] };
        while (i < lines.length && /^ {0,3}>/.test(lines[i].text)) {
          quoted.push({ ...lines[i], text: lines[i].text.replace(/^ {0,3}> ?/, '') }); i++;
          const opaque = this.quoteBarrier(quoted.at(-1).text, state);
          // Adjacent same-level callouts need not have an unquoted blank line.
          if (!opaque && i < lines.length && /^ {0,3}> ?\[!/.test(lines[i].text)) break;
        }
        const header = quoted[0].text.match(/^\s*\[!([a-zA-Z-]+)(?:\|([^\]]+))?\][+-]?\s*(.*)$/);
        if (!header && /^\s*\[!/.test(quoted[0].text)) this.report('INVALID_CALLOUT', 'Complete the callout header before building.', start.line);
        const node = { type: header ? 'callout' : 'quote', line: start.line, endLine: quoted.at(-1).line };
        if (header) {
          node.environment = environments[header[1].toLowerCase()];
          node.kind = header[1].toLowerCase();
          if (!node.environment) this.report('GENERIC_CALLOUT', `Callout ${node.kind} is rendered as an unnumbered titled quotation.`, start.line, 'warning');
          node.spans = this.inline(header[3], start.line);
          if (header[2]) this.report('CALLOUT_METADATA', 'The callout pipe is viewer metadata, not a title or label. Put the title after ] and use a leading <!-- [label{id}] --> line.', start.line);
          const declarations = [];
          for (const span of node.spans) if (span.type === 'raw' && /^\\label\{[^}]+\}$/.test(span.value)) declarations.push({ id: span.value.slice(7, -1), line: span.line });
          node.spans = node.spans.filter(span => !(span.type === 'raw' && /^\\label\{[^}]+\}$/.test(span.value)));
          quoted.shift();
          while (quoted.length) {
            const meta = quoted[0].text.match(/^\s*(?:label::\s*(\S+)|\\label\{([^}]+)\})\s*$/);
            const label = this.labelLine(quoted[0].text, quoted[0].line);
            if (label) { declarations.push(label); quoted.shift(); }
            else if (meta) { declarations.push({ id: meta[1] || meta[2], line: quoted[0].line }); quoted.shift(); }
            else if (!quoted[0].text.trim()) quoted.shift();
            else break;
          }
          this.attachLabel(node, declarations);
          this.collectSpans(node.spans);
        }
        node.children = this.blocks(quoted, depth + 1);
        if (node.environment === 'equation') this.equation(node);
        nodes.push(node); continue;
      }
      const listStart = text.match(/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/);
      if (listStart) {
        const ordered = /^\d/.test(listStart[1]);
        const items = [];
        const node = { type: 'list', ordered, start: ordered ? Number.parseInt(listStart[1], 10) : 1, line: start.line, items };
        while (i < lines.length) {
          const item = lines[i].text.match(/^ {0,3}([-+*]|\d+[.)])\s+(.*)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const indentation = lines[i].text.length - item[2].length;
          const content = [{ ...lines[i], text: item[2] }];
          i++;
          while (i < lines.length) {
            if (lines[i].text.startsWith(' '.repeat(indentation))) { content.push({ ...lines[i], text: lines[i].text.slice(indentation) }); i++; }
            else if (!lines[i].text.trim() && lines[i + 1]?.text.startsWith(' '.repeat(indentation))) { content.push(lines[i++]); }
            else break;
          }
          items.push({ line: content[0].line, endLine: content.at(-1).line, children: this.blocks(content, depth + 1) });
          if (!lines[i]?.text.trim() && /^ {0,3}([-+*]|\d+[.)])\s/.test(lines[i + 1]?.text || '')) i++;
        }
        node.endLine = items.at(-1).endLine;
        nodes.push(node); continue;
      }
      if (heading) {
        const spans = this.inline(heading[2], start.line);
        const declarations = spans.filter(span => span.type === 'raw' && /^\\label\{[^}]+\}$/.test(span.value)).map(span => ({ id: span.value.slice(7, -1), line: span.line }));
        const node = { type: 'heading', level: heading[1].length, line: start.line, endLine: start.line, spans: spans.filter(span => !(span.type === 'raw' && /^\\label\{[^}]+\}$/.test(span.value))) };
        i++;
        while (i < lines.length) {
          const label = this.labelLine(lines[i].text, lines[i].line);
          const metadata = lines[i].text.match(/^\s*label::\s*(\S+)\s*$/);
          if (!label && !metadata) break;
          declarations.push(label || { id: metadata[1], line: lines[i].line });
          node.endLine = lines[i++].line;
        }
        this.attachLabel(node, declarations); this.collectSpans(node.spans);
        nodes.push(node); continue;
      }
      const paragraph = [start];
      i++;
      while (i < lines.length && lines[i].text.trim() && !/^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|%%|<!--|[-+*]\s|\d+[.)]\s|\\begin\{|\[printbibliography\])/.test(lines[i].text)) paragraph.push(lines[i++]);
      const spans = this.inline(paragraph.map(item => item.text).join('\n'), start.line);
      this.collectSpans(spans);
      nodes.push({ type: 'paragraph', line: start.line, endLine: paragraph.at(-1).line, spans });
    }
    return nodes;
  }
}

/** Emit TeX with one original source line for each emitted physical line. */
function renderDocument(nodes) {
  const output = [];
  const map = [];
  const segments = [];
  /** Append text while keeping line-level provenance (not character-level SyncTeX). */
  function emit(text, line) {
    for (const [offset, value] of text.split('\n').entries()) { output.push(value); map.push({ bodyLine: output.length, line: line + offset }); }
  }
  /** Render inline spans; raw TeX/math are opaque and literal code is escaped. */
  function inline(spans) {
    return spans.map(span => {
      if (span.type === 'text') return escapeText(span.value);
      if (span.type === 'comment') return '\n'.repeat(span.endLine - span.line);
      if (span.type === 'code') return `\\texttt{${escapeText(span.value)}}`;
      if (span.type === 'strong' || span.type === 'emphasis') return `\\${span.type === 'strong' ? 'textbf' : 'emph'}{${inline(span.children)}}`;
      if (span.type === 'todo') return `\\textbf{[TODO: ${inline(span.children)}]}`;
      if (span.type === 'link') {
        const destination = span.target.replace(/[%#&_]/g, char => `\\${char}`);
        return span.target.startsWith('#') ? `\\hyperref[${span.target.slice(1)}]{${inline(span.children)}}` : `\\href{${destination}}{${inline(span.children)}}`;
      }
      if (span.type === 'reference') return `\\cref{${span.value}}`;
      if (span.type === 'citation') return `\\cite{${span.value}}`;
      if (span.type === 'math') {
        if (!span.display) return `$${span.value}$`;
        const outer = visibleTex(span.value).trim().match(/^\\begin\{(align\*?|alignat\*?|flalign\*?|equation\*?|gather\*?|multline\*?|displaymath)\}/);
        if (outer && visibleTex(span.value).trim().endsWith(`\\end{${outer[1]}}`)) return span.value;
        return `\\[${span.value}\\]`;
      }
      return span.value;
    }).join('');
  }
  /** Flatten rendered inline pieces while preserving collapsed-code source ranges. */
  function pieces(spans) {
    return spans.flatMap(span => {
      if (['strong', 'emphasis', 'link', 'todo'].includes(span.type)) {
        const wrapper = inline([{ ...span, children: [] }]);
        const tail = span.type === 'todo' ? 2 : 1;
        return [{ text: wrapper.slice(0, -tail), line: span.line }, ...pieces(span.children), { text: wrapper.slice(-tail), line: span.endLine }];
      }
      return [{ text: inline([span]), line: span.line, endLine: span.type === 'code' ? span.endLine : undefined }];
    });
  }
  /** Emit an inline block with exact line provenance or an honest source-line range. */
  function emitInline(prefix, spans, suffix, node) {
    let pending = '';
    let first = null;
    let last = null;
    const fragments = [{ text: prefix, line: node.line }, ...pieces(spans), { text: suffix, line: node.endLine }];
    /** Publish one physical output line and clear its accumulated source range. */
    function flush(fallback) {
      output.push(pending);
      map.push({ bodyLine: output.length, line: first ?? fallback, endLine: last ?? fallback });
      pending = ''; first = null; last = null;
    }
    for (const fragment of fragments) {
      const parts = fragment.text.split('\n');
      for (const [offset, value] of parts.entries()) {
        const line = fragment.endLine === undefined ? fragment.line + offset : fragment.line;
        if (value) {
          pending += value;
          first = Math.min(first ?? line, line);
          last = Math.max(last ?? line, fragment.endLine ?? line);
        }
        if (offset < parts.length - 1) flush(line);
      }
    }
    flush(node.endLine);
  }
  /** Render nested block containers without reparsing their contents. */
  function blocks(children, enumerationDepth = 0, topLevel = false) {
   for (const node of children) {
    const outputStart = output.length;
    if (node.type === 'code') {
      emit('\\begin{verbatim}', node.line);
      for (const item of node.content) emit(item.text, item.line);
      emit('\\end{verbatim}', node.endLine);
    } else if (node.type === 'raw') emit(node.value, node.line);
    else if (node.type === 'bibliography') emit('\\printbibliography', node.line);
    else if (node.type === 'rule') emit('\\par\\noindent\\rule{\\linewidth}{0.4pt}', node.line);
    else if (node.type === 'list') {
      const environment = node.ordered ? 'enumerate' : 'itemize';
      emit(`\\begin{${environment}}`, node.line);
      if (node.ordered && node.start !== 1) emit(`\\setcounter{${['enumi', 'enumii', 'enumiii', 'enumiv'][enumerationDepth] || 'enumiv'}}{${node.start - 1}}`, node.line);
      for (const item of node.items) { emit('\\item', item.line); blocks(item.children, enumerationDepth + (node.ordered ? 1 : 0)); }
      emit(`\\end{${environment}}`, node.endLine);
    }
    else if (node.type === 'heading') {
      const command = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'][node.level - 1];
      emitInline(`\\${command}{`, node.spans, `}${node.label ? `\\label{${node.label.id}}` : ''}`, node);
    } else if (node.environment === 'equation') {
      emit('\\begin{equation}', node.line);
      if (node.label) emit(`\\label{${node.label.id}}`, node.label.line);
      if (node.math) {
        const value = node.math.value.replace(/^\n/, '').replace(/\n$/, '');
        emit(value, node.math.line + (node.math.value.startsWith('\n') ? 1 : 0));
      }
      emit('\\end{equation}', node.endLine);
    } else if (node.type === 'callout' || node.type === 'quote') {
      const environment = node.environment || 'quote';
      if (node.environment && node.spans?.length) emitInline(`\\begin{${environment}}[{`, node.spans, '}]', { ...node, endLine: node.line });
      else emit(`\\begin{${environment}}`, node.line);
      if (node.type === 'callout' && !node.environment) emitInline(`\\textbf{${escapeText(node.kind)}${node.spans?.length ? ': ' : ''}`, node.spans || [], '}\\par', { ...node, endLine: node.line });
      if (node.label) emit(`\\label{${node.label.id}}`, node.label.line);
      blocks(node.children, enumerationDepth);
      emit(`\\end{${environment}}`, node.endLine);
    } else emitInline('', node.spans, '', node);
    emit('', node.endLine);
    if (topLevel) segments.push({ line: node.sourceLine || node.line, endLine: node.endLine, tex: output.slice(outputStart).join('\n') + '\n' });
   }
  }
  blocks(nodes, 0, true);
  return { tex: output.join('\n'), lines: map, segments };
}

/** Convert one immutable snapshot into a document, TeX, diagnostics, and source map. */
function convertMarkdown(snapshot, filename) {
  const parser = new DocumentParser(filename);
  if (Buffer.byteLength(snapshot.body) > 4 * 1024 * 1024) {
    parser.report('SOURCE_SIZE_LIMIT', 'Structural conversion currently accepts at most 4 MiB of Markdown.', snapshot.bodyStartLine);
    return { document: { type: 'document', children: [] }, tex: '', lines: [], diagnostics: parser.diagnostics };
  }
  const lines = snapshot.body.split(/\r?\n/).map((text, index) => ({ text, line: snapshot.bodyStartLine + index }));
  const children = parser.blocks(lines);
  parser.validate();
  return { document: { type: 'document', labels: parser.labels, references: parser.references, citations: parser.citations, children }, ...renderDocument(children), diagnostics: parser.diagnostics };
}

module.exports = { convertMarkdown };
