/**
 * Locate a conservative literal document envelope without evaluating TeX.
 * Example: envelope('\\documentclass{article}\n\\begin{document}\nText\n\\end{document}\n');
 * Macro-generated document boundaries and nonstandard category codes are unsupported.
 */

/** Separate literal whole-line document boundaries, protecting comments and verbatim. */
function envelope(tex, checkpointId = null) {
  const lines = tex.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  let literal = null;
  const boundaries = [];
  const visibleLines = [];
  for (const original of lines) {
    const line = original.replace(/\r?\n$/, '');
    if (literal) {
      if (checkpointId && line.startsWith(`% md2tex:${checkpointId}:`)) throw Object.assign(new Error('A checkpoint marker is inside a verbatim/literal environment. Keep that whole environment inside one marked block; otherwise stripping markers would remove printable content.'), { code: 'MARKER_IN_LITERAL' });
      if (line.includes(`\\end{${literal}}`)) literal = null;
      offset += original.length; continue;
    }
    let visible = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%') break;
      const verb = line.slice(i).match(/^\\verb\*?([^a-zA-Z\s])/);
      if (verb) {
        const end = line.indexOf(verb[1], i + verb[0].length);
        if (end < 0) throw Object.assign(new Error('Unclosed inline verbatim delimiter in the TeX envelope.'), { code: 'AMBIGUOUS_ENVELOPE' });
        visible += ' '.repeat(end + 1 - i); i = end; continue;
      }
      visible += line[i];
      if (line[i] === '\\' && i + 1 < line.length) visible += line[++i];
    }
    const startLiteral = visible.match(/\\begin\{(verbatim\*?|lstlisting|minted)\}/);
    visibleLines.push(visible);
    if (startLiteral && !visible.includes(`\\end{${startLiteral[1]}}`)) literal = startLiteral[1];
    if (/\\(?:catcode|endlinechar|newlinechar)\b/.test(visible)) throw Object.assign(new Error('Nonstandard TeX tokenization cannot be imported safely by this prototype.'), { code: 'UNSUPPORTED_TEX_TOKENIZATION' });
    const tokens = [...visible.matchAll(/\\(begin|end)\{document\}/g)];
    if (tokens.length) {
      if (!/^\s*\\(?:begin|end)\{document\}\s*$/.test(visible) || tokens.length !== 1) throw Object.assign(new Error('Use literal whole-line document boundaries; macro/inline document envelopes need manual separation.'), { code: 'AMBIGUOUS_ENVELOPE' });
      boundaries.push({ edge: tokens[0][1], start: offset, end: offset + original.length });
    }
    offset += original.length;
  }
  if (literal || boundaries.length !== 2 || boundaries[0].edge !== 'begin' || boundaries[1].edge !== 'end') throw Object.assign(new Error('Expected exactly one literal begin/end document pair outside comments and verbatim. Use --body-only only for an actual body fragment.'), { code: 'AMBIGUOUS_ENVELOPE' });
  const [begin, end] = boundaries;
  const tail = tex.slice(end.end);
  if (tail.split('\n').some(line => line.trim() && !line.trimStart().startsWith('%'))) throw Object.assign(new Error('Content after end{document} requires manual review; the full original is not a body fragment.'), { code: 'TRAILING_TEX_CONTENT' });
  return { preamble: tex.slice(0, begin.start), body: tex.slice(begin.end, end.start), tail, visibleTex: visibleLines.join('\n') };
}

module.exports = { envelope };
