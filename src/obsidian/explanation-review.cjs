/**
 * Turn validated captured advice into separate inert findings and a plain-text copy.
 * Usage: const review = explanationReview(answer, packet); // no source reads or writes
 */
const { validateFailurePacket, validateExplanation } = require('../core/explanation-contract.cjs');

/** Name source/log coordinates without treating generated TeX lines as Markdown. */
function locationLabel(kind, startLine, endLine) {
  const name = kind === 'source' ? 'Markdown' : 'Compiler log';
  return `${name} ${startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`}`;
}

/** Capture at most two neighboring lines and eight affected lines; preserve absolute numbers. */
function capturedContext(evidence, startLine, endLine) {
  if (!evidence || startLine < evidence.startLine || endLine > evidence.endLine) return { lines: [], note: 'Surrounding text is unavailable in the captured evidence.' };
  const text = evidence.text.split('\n');
  const first = Math.max(evidence.startLine, startLine - 2), last = Math.min(evidence.endLine, endLine + 2);
  const lines = [];
  for (let number = first; number <= last; number++) {
    if (number >= startLine + 4 && number <= endLine - 4) {
      lines.push({ number: null, text: `… ${endLine - startLine - 7} affected lines omitted from context; see patch …`, affected: false });
      number = endLine - 4; continue;
    }
    lines.push({ number, text: text[number - evidence.startLine], affected: number >= startLine && number <= endLine });
  }
  const missing = [];
  if (first === evidence.startLine && startLine - first < 2) missing.push('Earlier context is limited to the captured excerpt.');
  if (last === evidence.endLine && last - endLine < 2) missing.push('Later context is limited to the captured excerpt.');
  if (evidence.truncated) missing.push('This excerpt was truncated; omitted text is not inferred.');
  return { lines, note: missing.join(' ') };
}

/** Validate and group exact matching locations/edits; never infer extra mistakes from raw source. */
function explanationReview(answer, rawPacket) {
  const packet = validateFailurePacket(rawPacket), reply = validateExplanation(answer.explanation, packet);
  const findings = [], matched = new Set();
  for (const edit of reply.edits || []) {
    const evidence = packet.evidence.find(item => item.id === edit.evidenceId);
    const locations = (reply.locations || []).filter((item, index) => {
      const same = item.evidenceId === edit.evidenceId && item.startLine === edit.startLine && item.endLine === edit.endLine;
      if (same) matched.add(index); return same;
    });
    const reasons = [...new Set([edit.reason, ...locations.map(item => item.reason)])];
    findings.push({ label: locationLabel(evidence.kind, edit.startLine, edit.endLine), reason: reasons.join('\n'),
      context: capturedContext(evidence, edit.startLine, edit.endLine), edit });
  }
  for (const [index, item] of (reply.locations || []).entries()) {
    if (matched.has(index)) continue;
    const evidence = packet.evidence.find(value => value.id === item.evidenceId);
    findings.push({ label: locationLabel(evidence.kind, item.startLine, item.endLine), reason: item.reason,
      context: capturedContext(evidence, item.startLine, item.endLine), edit: null });
  }
  if (!findings.length) {
    const diagnostic = packet.evidence[0], evidence = packet.evidence.find(item => item.kind === 'source');
    const start = diagnostic.sourceLine, end = diagnostic.sourceEndLine;
    findings.push({ label: start === null ? 'Location not established by captured evidence' : locationLabel('source', start, end),
      reason: diagnostic.message, context: capturedContext(evidence, start, end), edit: null });
  }
  const manual = 'Please make any suggested change yourself, then Build again. Advice has not been applied or compiler-tested.';
  const sections = [reply.summary, ...findings.map((finding, index) => [
    `Finding ${index + 1} — ${finding.label}`, finding.reason,
    ...finding.context.lines.map(line => `${line.affected ? '>' : ' '} ${line.number ?? '…'} | ${line.text}`),
    finding.context.note, finding.edit ? 'Suggested change (manual):' : 'No verified patch for this location.',
    ...(finding.edit ? [`@@ Markdown lines ${finding.edit.startLine}–${finding.edit.endLine} @@`,
      ...finding.edit.before.split('\n').map(line => '- ' + line), ...(finding.edit.after ? finding.edit.after.split('\n').map(line => '+ ' + line) : [])] : [])
  ].filter(Boolean).join('\n')), ...reply.suggestions.map(item => 'Next action: ' + item.text), manual];
  return { summary: reply.summary, findings, suggestions: reply.suggestions.map(item => item.text), manual, text: sections.join('\n\n') };
}

module.exports = { explanationReview, capturedContext };
