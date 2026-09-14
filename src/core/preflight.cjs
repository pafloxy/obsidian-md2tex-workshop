/**
 * Conservative checks for demonstrated failures in the legacy converter.
 * Example: const issues = inspectLegacyInput(snapshot, '/vault/note.md');
 * This is a bounded compatibility guard, not a complete Markdown parser.
 */
const calloutTypes = new Set(['lemma', 'lem', 'theorem', 'thm', 'definition', 'def', 'proof', 'proposition', 'prop', 'corollary', 'cor', 'example', 'ex', 'remark', 'rem', 'note', 'property', 'algorithm', 'alg', 'algo']);

/** Identify unsupported or lossy constructs with original Markdown locations. */
function inspectLegacyInput(snapshot, filename) {
  const diagnostics = [];
  const lines = snapshot.body.split(/\r?\n/);
  let inFence = false;
  let inComment = false;
  let displayMath = false;
  let inlineMath = false;
  let rawMath = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/^(?:>\s*)+/, '');
    /** Attach a diagnostic to the current original source line. */
    function report(code, message) {
      diagnostics.push({ severity: 'error', code, stage: 'preflight', message, path: filename, line: index + snapshot.bodyStartLine });
    }
    if (/^\s*%%\s*$/.test(line)) { inComment = !inComment; continue; }
    if (inComment) continue;
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) report('UNSUPPORTED_CODE_BLOCK', 'The legacy converter cannot preserve fenced code. Keep this source unchanged for the parser milestone or use a separate TeX workflow.');
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/\\begin\{(?:verbatim|lstlisting|minted)\}/.test(line)) report('UNSUPPORTED_RAW_CODE', 'The legacy converter does not protect raw TeX code environments from Markdown transformations.');
    if (/\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|displaymath)\}/.test(line)) rawMath = true;
    if (rawMath) {
      if (/\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?|displaymath)\}/.test(line)) rawMath = false;
      continue;
    }
    if (!displayMath && !inlineMath) {
      if (/!\[/.test(line)) report('UNSUPPORTED_IMAGE', 'Markdown/Obsidian images are not preserved by the legacy converter. Use explicit TeX graphics with declared support files pending image support.');
      else if (/\[\[/.test(line)) report('UNSUPPORTED_WIKILINK', 'The legacy converter drops wiki-link targets or text. Use explicit display text or TeX links pending link support.');
      else if (/\[[^\]]*\]\([^)]+\)/.test(line)) report('UNSUPPORTED_MARKDOWN_LINK', 'The legacy converter drops Markdown link destinations. Use an explicit TeX hyperlink pending link support.');
      const callout = line.match(/^\s*\[!(\w+)/);
      if (callout && !calloutTypes.has(callout[1].toLowerCase())) report('UNSUPPORTED_CALLOUT', `The legacy converter has no default environment for ${callout[1]}.`);
      const label = line.match(/^\s*label::\s*(\S+)/);
      if (label && !snapshot.body.includes(`\\label{${label[1]}}`) && !snapshot.body.includes(`|${label[1]}]`)) report('MISSING_EXPLICIT_LABEL', `label:: ${label[1]} is discarded by the legacy converter. Supply an explicit TeX/callout label until metadata labels are supported.`);
      // Explicit TeX command/comment lines are an advanced escape hatch.
      if (/^\s*[\\%]/.test(line) && !/^\s*\\[\[(]/.test(line)) continue;
    }
    for (let column = 0; column < line.length; column++) {
      if (line[column] === '\\') {
        const next = line[column + 1];
        if (next === '[') displayMath = true;
        if (next === ']') displayMath = false;
        if (next === '(') inlineMath = true;
        if (next === ')') inlineMath = false;
        column++;
        continue;
      }
      if (line[column] === '$') {
        if (line[column + 1] === '$') { displayMath = !displayMath; column++; }
        else inlineMath = !inlineMath;
      } else if (!displayMath && !inlineMath && /[%&_]/.test(line[column])) {
        report('UNESCAPED_TEX_CHARACTER', `Unescaped ${line[column]} outside math can fail compilation or lose text with the legacy converter. Escape it explicitly in prose/code; use math delimiters for mathematical content.`);
        break;
      }
    }
  }
  return diagnostics;
}

module.exports = { inspectLegacyInput };
