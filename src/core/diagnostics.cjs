/**
 * Classify subprocess outcomes and final TeX logs without stale build history.
 * Example: const diagnostics = auditLog(await fs.readFile('main.log', 'utf8'));
 */

/** Raise a structured failure for a process that could not complete normally. */
function requireProcessSuccess(run, stage, log = '') {
  if (!run.error && !run.limit && run.exitCode === 0) return;
  let code = stage === 'compilation' ? 'LATEX_ERROR' : 'CONVERSION_ERROR';
  let message = run.stderr.trim() || `${stage} exited with status ${run.exitCode}`;
  const details = {};
  if (run.limit) { code = { timeout: 'PROCESS_TIMEOUT', cancelled: 'BUILD_CANCELLED', 'output-limit': 'PROCESS_OUTPUT_LIMIT' }[run.limit] || 'PROCESS_STOPPED'; message = `${stage} stopped: ${run.limit}`; }
  else if (run.error) { code = 'PROCESS_UNAVAILABLE'; message = run.error; }
  else if (stage === 'compilation') {
    const first = log.split('\n').find((line) => /^.+?:\d+:\s|^!\s/.test(line));
    if (first) {
      const match = first.match(/^(.+?):(\d+):\s+(.+)$/);
      message = match ? match[3] : first.replace(/^!\s*/, '');
      if (match) { details.texFile = match[1]; details.texLine = Number(match[2]); }
    }
  }
  throw Object.assign(new Error(message), { code, ...details });
}

/** Find reference, citation, anchor, and glyph problems in the final build log. */
function auditLog(log) {
  const diagnostics = [];
  const rules = [
    ['UNRESOLVED_REFERENCE', /(?:LaTeX Warning: Reference|There were undefined references)/, 'error'],
    ['UNRESOLVED_CITATION', /(?:Warning: Citation|There were undefined citations)/, 'error'],
    ['DUPLICATE_LABEL', /(?:Label .*multiply defined|There were multiply-defined labels)/, 'error'],
    ['DUPLICATE_DESTINATION', /destination with the same identifier/, 'error'],
    ['MISSING_GLYPH', /Missing character: There is no/, 'error'],
    ['INCOMPLETE_TEX_STATE', /\\end occurred (?:inside a group|when .*incomplete)/, 'error'],
    ['LAYOUT_WARNING', /Overfull \\[hv]box|Underfull \\[hv]box/, 'warning'],
  ];
  const lines = log.split('\n');
  for (let index = 0; index < lines.length; index++) {
    for (const [code, pattern, severity] of rules) {
      if (pattern.test(lines[index])) diagnostics.push({ severity, code, stage: 'validation', message: lines[index].trim(), logLine: index + 1 });
    }
  }
  return diagnostics;
}

module.exports = { requireProcessSuccess, auditLog };
