/**
 * Verify separate findings, captured context and complete copy text without a model.
 * Usage from checkout root: node --test testing/explanation-review.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceHash } = require('../src/core/protocol.cjs');
const { sealPacket, packetVersion, reviewVersion } = require('../src/core/explanation-contract.cjs');
const { explanationReview, capturedContext, referenceSegments } = require('../src/obsidian/explanation-review.cjs');

/** Produce a bounded synthetic two-mistake packet and matching reply. */
function fixture() {
  const text = 'Before.\n\\fracc{1}{2}\nBetween.\n\\sqrtt{4}\nAfter.';
  const packet = sealPacket({ schemaVersion: packetVersion, command: 'failure-packet', status: 'success', scope: 'explanation-only',
    origin: 'attempt', buildStatus: 'error', identity: { documentId: sourceHash('synthetic.md'), sourceHash: sourceHash(text), recipeFingerprint: null,
      converterHash: null, toolchainFingerprint: null, resolvedRecipeHash: null, attemptId: 'test', jobId: null, failureId: '' },
    category: 'tex', summary: 'Undefined control sequence', primaryEvidenceId: 'diagnostic-1',
    evidence: [{ id: 'diagnostic-1', kind: 'diagnostic', code: 'LATEX_ERROR', stage: 'compilation', message: 'Undefined control sequence', sourceLine: 11, sourceEndLine: 11 },
      { id: 'source-1', kind: 'source', startLine: 10, endLine: 14, text, truncated: false },
      { id: 'log-1', kind: 'log', startLine: 90, endLine: 92, text: 'Prior log\nUndefined control sequence\nLater log', truncated: false }], omittedDiagnostics: 0, omissions: [] });
  const edits = [{ evidenceId: 'source-1', startLine: 11, endLine: 11, before: '\\fracc{1}{2}', after: '\\frac{1}{2}', reason: 'Misspelled fraction command.' },
    { evidenceId: 'source-1', startLine: 13, endLine: 13, before: '\\sqrtt{4}', after: '\\sqrt{4}', reason: 'Misspelled square-root command.' }];
  const reply = { schemaVersion: reviewVersion, packetId: packet.packetId, failureId: packet.identity.failureId, sourceHash: packet.identity.sourceHash,
    verdict: 'explained', summary: '<script>quoted, inert summary</script>', evidenceIds: ['diagnostic-1', 'source-1'], suggestions: [{ text: 'Rebuild after your edits.', evidenceIds: ['source-1'] }],
    locations: edits.map(({ evidenceId, startLine, endLine, reason }) => ({ evidenceId, startLine, endLine, reason })), edits };
  return { packet, answer: { explanation: reply } };
}

test('two exact mistakes get separate findings, deduplicated locations, context and copy patches', () => {
  const f = fixture(), review = explanationReview(f.answer, f.packet);
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0].label, 'Markdown line 11');
  assert.deepEqual(review.findings[0].location, { evidenceId: 'source-1', startLine: 11, endLine: 11 });
  assert.deepEqual(review.findings[0].context.lines.map(line => [line.number, line.affected]), [[10, false], [11, true], [12, false], [13, false]]);
  assert.match(review.text, /Finding 1 — Markdown line 11/); assert.match(review.text, /Finding 2 — Markdown line 13/);
  assert.match(review.text, /> 11 \| \\fracc/); assert.match(review.text, /- \\fracc/); assert.match(review.text, /\+ \\frac/);
  assert.match(review.text, /10 \| Before\./); assert.match(review.text, /12 \| Between\./); assert.match(review.text, /14 \| After\./);
  assert.match(review.text, /yourself/); assert.match(review.text, /not been applied/); assert.match(review.summary, /<script>/);
});

test('log findings keep log coordinates and no source patch is invented', () => {
  const f = fixture(); f.answer.explanation.edits = [];
  f.answer.explanation.locations = [{ evidenceId: 'log-1', startLine: 91, endLine: 91, reason: 'Compiler symptom.' }];
  const review = explanationReview(f.answer, f.packet);
  assert.equal(review.findings[0].label, 'Compiler log line 91'); assert.equal(review.findings[0].edit, null);
  assert.equal(review.findings[0].location, null);
  assert.match(review.text, /90 \| Prior log/); assert.match(review.text, /92 \| Later log/); assert.match(review.text, /No verified patch/);
});

test('no mapped source means explicit missing context, not guessed Markdown coordinates', () => {
  const f = fixture(); f.answer.explanation.edits = []; f.answer.explanation.locations = [];
  const diagnostic = { ...f.packet.evidence[0], sourceLine: null, sourceEndLine: null };
  const { packetId, ...body } = f.packet; body.identity = { ...body.identity }; body.evidence = [diagnostic];
  const packet = sealPacket(body); const answer = { explanation: { ...f.answer.explanation, packetId: packet.packetId, failureId: packet.identity.failureId, evidenceIds: ['diagnostic-1'], suggestions: [] } };
  const review = explanationReview(answer, packet);
  assert.match(review.findings[0].label, /not established/); assert.equal(review.findings[0].context.lines.length, 0);
  assert.equal(review.findings[0].location, null);
});

test('truncated context is labelled and long ranges remain bounded with explicit omission', () => {
  const evidence = { startLine: 1, endLine: 1000, text: Array.from({ length: 1000 }, (_, n) => 'line ' + (n + 1)).join('\n'), truncated: true };
  const context = capturedContext(evidence, 3, 998);
  assert.ok(context.lines.length <= 13); assert.match(context.note, /truncated/);
  assert.ok(context.lines.some(line => line.number === null));
});

test('foreign or mismatched evidence is refused before rendering/copy construction', () => {
  const f = fixture(); f.answer.explanation.edits[0].before = 'foreign';
  assert.throws(() => explanationReview(f.answer, f.packet));
});

test('only verified current-note inline references become locations, with exact inert text preserved', () => {
  const locations = [{ evidenceId: 'source-1', startLine: 56, endLine: 58 }];
  const text = '<script>quoted</script> Go to note.md:L56, then `folder/note.md:L56-L58`. Not other.md:L56, ../note.md:L56, https://x/note.md:L56, note.md:L1, note.md:L58-L56 or note.md:L999999999999999999.';
  const parts = referenceSegments(text, 'folder/note.md', locations);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.location).map(part => [part.text, part.location.startLine, part.location.endLine]), [['note.md:L56', 56, 56], ['folder/note.md:L56-L58', 56, 58]]);
  const spaced = referenceSegments('See (My Note.md:L56).', 'folder/My Note.md', locations);
  assert.equal(spaced.filter(part => part.location)[0].text, 'My Note.md:L56');
  assert.deepEqual(referenceSegments('note.md:L56', 'note.md', []), [{ text: 'note.md:L56' }]);
  assert.equal(referenceSegments('noteXmd:L56', 'note.md', locations).some(part => part.location), false);
  assert.equal(referenceSegments('note[math](v1).md:L56', 'note[math](v1).md', locations).filter(part => part.location).length, 1);
});

test('truncated captured source locations are not navigation authority', () => {
  const f = fixture();
  const { packetId, ...body } = f.packet;
  body.identity = { ...body.identity }; body.evidence = f.packet.evidence.map(item => item.kind === 'source' ? { ...item, truncated: true } : item);
  const packet = sealPacket(body);
  const answer = { explanation: { ...f.answer.explanation, packetId: packet.packetId, failureId: packet.identity.failureId, edits: [] } };
  assert.ok(explanationReview(answer, packet).findings.every(finding => finding.location === null));
});

module.exports = { fixture };
