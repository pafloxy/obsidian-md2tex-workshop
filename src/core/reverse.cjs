/**
 * Conservative inverse candidates, accepted only by exact forward regeneration.
 * Example: recover('A **bold** claim.\n', 'A \\textbf{bold} claim.\n\n', 'A \\textbf{new} claim.\n\n');
 * No TeX evaluation, filesystem access, or guessing about macro semantics.
 */
const { convertMarkdown } = require('./markdown.cjs');

/** Render the same complete-block representation used in editing checkpoints. */
function render(markdown) {
  const converted = convertMarkdown({ body: markdown, bodyStartLine: 1 }, 'roundtrip-block.md');
  return converted.document.children.length ? converted.tex + '\n' : '';
}

/** Require both exact output and valid local syntax, deferring only cross-block references. */
function reproduces(markdown, tex) {
  const converted = convertMarkdown({ body: markdown, bodyStartLine: 1 }, 'roundtrip-block.md');
  return !converted.diagnostics.some(item => item.severity === 'error' && item.code !== 'UNRESOLVED_REFERENCE') && (converted.document.children.length ? converted.tex + '\n' : '') === tex;
}

/** Distinguish Markdown-only comments from percent signs inside literal code/raw TeX. */
function hasHiddenComments(source) {
  const stack = [convertMarkdown({ body: source, bodyStartLine: 1 }, 'roundtrip-block.md').document];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'comment') return true;
    for (const key of ['children', 'spans', 'items']) if (node[key]) stack.push(...node[key]);
  }
  return false;
}

/** Project one contiguous edit onto source only if one exact-regenerating candidate exists. */
function sourcePatch(source, before, after) {
  if (source.length > 65536 || before.length > 65536 || after.length > 65536) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-end - 1) === after.at(-end - 1)) end++;
  const removed = before.slice(start, before.length - end);
  const replacement = after.slice(start, after.length - end);
  if (/\\(?:begin|end|section|subsection|subsubsection|paragraph|subparagraph)\{|\\printbibliography\b/.test(removed + replacement)) return null;
  // An insertion needs an existing literal neighbour to avoid searching every offset.
  const context = removed || before.slice(Math.max(0, start - 24), start);
  if (!context) return null;
  const matches = [];
  let position = source.indexOf(context);
  let attempts = 0;
  while (position >= 0) {
    if (++attempts > 64) return null;
    const offset = removed ? position : position + context.length;
    const candidate = source.slice(0, offset) + replacement + source.slice(offset + removed.length);
    if (reproduces(candidate, after)) matches.push(candidate);
    position = source.indexOf(context, position + 1);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Enclose exact TeX in a collision-free pass-through fence with explicit boundaries. */
function rawIsland(tex) {
  if (!tex) return '';
  if (!tex.endsWith('\n\n')) throw Object.assign(new Error('Keep one empty line before the closing block marker; its boundary is part of the checkpoint contract.'), { code: 'BLOCK_BOUNDARY_CHANGED' });
  const content = tex.slice(0, -2);
  const longest = Math.max(2, ...(content.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}{=latex}\n${content}\n${fence}\n\n`;
}

/** Read a balanced TeX argument, protecting control symbols and line comments. */
function groupEnd(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '%') { const end = text.indexOf('\n', i); if (end < 0) return -1; i = end; continue; }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

/** Translate only known inline wrappers, protecting math and unknown macro arguments. */
function inverseInline(text, depth = 0) {
  if (depth > 48) return null;
  let output = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '%') return null; // TeX comments need raw preservation, not Markdown prose.
    if (text[i] === '$') {
      let end = i + 1;
      for (; end < text.length; end++) { if (text[end] === '\\') end++; else if (text[end] === '$') break; }
      if (end === text.length) return null;
      output += text.slice(i, end + 1); i = end + 1; continue;
    }
    if (text[i] !== '\\') { output += text[i++]; continue; }
    const command = text.slice(i).match(/^\\(?:[a-zA-Z@]+\*?|[^\n])/);
    if (!command) return null;
    const name = command[0].slice(1);
    if (['%', '&', '_', '#', '{', '}', '$'].includes(name)) {
      // Literal dollars must remain escaped so they do not introduce Markdown math.
      output += name === '$' ? '\\$' : name; i += command[0].length; continue;
    }
    let end = i + command[0].length;
    if (['textbf', 'emph', 'cref', 'cite'].includes(name) && text[end] === '{') {
      const closing = groupEnd(text, end);
      if (closing < 0) return null;
      const content = text.slice(end + 1, closing - 1);
      if (name === 'cref' || name === 'cite') output += `[${name === 'cref' ? 'ref' : 'cite'}{${content}}]`;
      else {
        const todo = name === 'textbf' && content.startsWith('[TODO: ') && content.endsWith(']');
        const inner = inverseInline(todo ? content.slice(7, -1) : content, depth + 1);
        if (inner === null) return null;
        const delimiter = name === 'textbf' ? '**' : '*';
        output += todo ? `[todo{${inner}}]` : delimiter + inner + delimiter;
      }
      i = closing; continue;
    }
    // Do not interpret text inside an unknown macro, including footnotes and URLs.
    while (['{', '['].includes(text[end])) {
      const closing = groupEnd(text, end);
      if (closing < 0) return null;
      end = closing;
    }
    output += text.slice(i, end); i = end;
  }
  return output;
}

/** Find a whole-line generated environment end; refuse complex/ambiguous nesting. */
function environmentEnd(lines, start) {
  const stack = [];
  for (let i = start; i < lines.length; i++) {
    // Generated containers put their delimiters on their own lines.
    const token = lines[i].match(/^\\(begin|end)\{([a-zA-Z*]+)\}/);
    if (!token) continue;
    if (token[1] === 'begin') stack.push(token[2]);
    else if (stack.pop() !== token[2]) return -1;
    if (!stack.length) return i;
  }
  return -1;
}

/** Propose canonical Markdown for the converter's bounded generated containers. */
function inverseBlocks(tex, depth = 0) {
  if (depth > 48 || tex.length > 262144) return null;
  const lines = tex.split('\n');
  const output = [];
  for (let i = 0; i < lines.length;) {
    if (!lines[i]) { i++; continue; }
    if (lines[i] === '\\printbibliography') {
      if (depth) return null;
      output.push('[printbibliography]'); i++; continue;
    }
    const list = lines[i].match(/^\\begin\{(itemize|enumerate)\}$/);
    if (list) {
      const end = environmentEnd(lines, i);
      if (end < 0) return null;
      i++;
      const counter = lines[i]?.match(/^\\setcounter\{enum[iv]+\}\{(\d+)\}$/);
      const firstNumber = counter ? Number(counter[1]) + 1 : 1;
      if (counter) i++;
      const items = [];
      let nesting = 0;
      for (; i < end; i++) {
        if (lines[i] === '\\item' && nesting === 0) items.push([]);
        else if (items.length) items.at(-1).push(lines[i]);
        else if (lines[i]) return null;
        if (/^\\begin\{/.test(lines[i])) nesting++;
        if (/^\\end\{/.test(lines[i])) nesting--;
      }
      const markdown = [];
      for (const [index, item] of items.entries()) {
        const inner = inverseBlocks(item.join('\n'), depth + 1);
        if (inner === null) return null;
        const prefix = list[1] === 'enumerate' ? `${firstNumber + index}. ` : '- ';
        markdown.push(inner.trimEnd().split('\n').map((line, index) => (index === 0 ? prefix : ' '.repeat(prefix.length)) + line).join('\n'));
      }
      output.push(markdown.join('\n')); i = end + 1; continue;
    }
    const equation = lines[i].match(/^\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|flalign\*?)\}$/);
    if (equation) {
      const end = environmentEnd(lines, i);
      if (end < 0) return null;
      if (equation[1] !== 'equation') return null;
      const label = lines[i + 1]?.match(/^\\label\{([a-zA-Z0-9:._/-]+)\}$/);
      const inner = lines.slice(i + (label ? 2 : 1), end).join('\n');
      const header = '[!equation]\n' + (label ? `<!-- [label{${label[1]}}] -->\n` : '');
      output.push((header + '$$\n' + inner + '\n$$').split('\n').map(line => '> ' + line).join('\n'));
      i = end + 1; continue;
    }
    const opening = lines[i].match(/^\\begin\{(theorem|lemma|definition|proposition|corollary|example|remark|property|proof|quote)\}(?:\[\{(.*)\}\])?$/);
    if (opening) {
      const end = environmentEnd(lines, i);
      if (end < 0 || lines[end] !== `\\end{${opening[1]}}`) return null;
      const title = inverseInline(opening[2] || '');
      if (title === null) return null;
      i++;
      const label = lines[i]?.match(/^\\label\{([a-zA-Z0-9:._/-]+)\}$/);
      if (label) i++;
      const inner = inverseBlocks(lines.slice(i, end).join('\n'), depth + 1);
      if (inner === null) return null;
      const header = opening[1] === 'quote' ? '' : `[!${opening[1]}]${title ? ' ' + title : ''}\n${label ? `<!-- [label{${label[1]}}] -->\n` : ''}`;
      const quoted = (header + inner.trimEnd()).split('\n').map(line => line ? '> ' + line : '>').join('\n');
      output.push(quoted); i = end + 1; continue;
    }
    const heading = lines[i].match(/^\\(section|subsection|subsubsection|paragraph|subparagraph)\{/);
    if (heading) {
      const start = heading[0].length - 1;
      const end = groupEnd(lines[i], start);
      if (end < 0 || !/^(?:\\label\{[a-zA-Z0-9:._/-]+\})?$/.test(lines[i].slice(end))) return null;
      const content = inverseInline(lines[i].slice(start + 1, end - 1));
      if (content === null) return null;
      const level = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'].indexOf(heading[1]) + 1;
      const label = lines[i].slice(end).match(/^\\label\{([^}]+)\}$/);
      output.push('#'.repeat(level) + ' ' + content + (label ? `\n<!-- [label{${label[1]}}] -->` : ''));
      i++; continue;
    }
    if (/^\\(?:begin|end)\{/.test(lines[i])) return null;
    const paragraph = [];
    while (i < lines.length && lines[i] && !/^\\(?:begin|end|section|subsection|subsubsection|paragraph|subparagraph)\{/.test(lines[i])) paragraph.push(lines[i++]);
    if (!paragraph.length) return null;
    const content = inverseInline(paragraph.join('\n'));
    if (content === null) return null;
    output.push(content);
  }
  return output.length ? output.join('\n\n') + '\n\n' : '';
}

/** Recover an edited block while retaining original authoring syntax when provable. */
function recover(source, before, after) {
  if (before === after) return { markdown: source, method: 'unchanged' };
  const projected = sourcePatch(source, before, after);
  if (projected !== null) return { markdown: projected, method: 'source-patch' };
  if (hasHiddenComments(source)) throw Object.assign(new Error('This changed block contains Markdown-only comments that cannot be safely positioned. Keep the original comments while reconciling manually.'), { code: 'MD_ONLY_CONTENT' });
  const structured = inverseBlocks(after);
  if (structured !== null && reproduces(structured, after)) return { markdown: structured, method: 'structural-inverse' };
  const markdown = rawIsland(after);
  if (!reproduces(markdown, after)) throw Object.assign(new Error('Raw preservation failed its exact regeneration check.'), { code: 'ROUNDTRIP_MISMATCH' });
  return { markdown, method: 'raw-tex' };
}

module.exports = { recover, render };
