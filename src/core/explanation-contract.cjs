/**
 * Pure bounded failure-packet and explanation-response contracts; no I/O or model calls.
 * Usage: validateExplanation(response, validateFailurePacket(packet));
 * Usage: sealPacket(packetFields); // used only by the deterministic evidence builder
 */
const { sourceHash: hash } = require('./protocol.cjs');
const packetVersion = 'workshop-failure-packet.v2';
const responseVersion = 'workshop-explanation.v1';
const reviewVersion = 'workshop-explanation.v2';
const limits = Object.freeze({ packetBytes: 48 * 1024, responseBytes: 8192, excerptBytes: 4096 });
const categories = ['tool-setup', 'execution', 'bibliography', 'target-publication', 'unsupported-syntax', 'configuration', 'markdown', 'tex', 'output-validation', 'runtime'];

/** Raise a stable contract failure without interpreting free text as instructions. */
function fail(message, code = 'INVALID_EXPLANATION') { throw Object.assign(new Error(message), { code }); }
/** Serialize JSON with canonical object-key order; array order remains significant. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** Copy bounded JSON before validation so caller mutation cannot affect accepted data. */
function copy(value, maximum) {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maximum) fail('Payload exceeds its byte limit.', 'EXPLANATION_LIMIT');
  return JSON.parse(text);
}
/** Require exact keys so replies cannot introduce command or source-write authority. */
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('Unexpected or missing contract field.');
}
/** Require well-formed, bounded Unicode text. */
function text(value, maximum, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.includes('\0') || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value) fail('Expected bounded valid text.');
}
/** Validate an optional or required SHA-256 identity. */
function sha(value, nullable = false) { if (!(nullable && value === null) && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail('Expected a SHA-256 identity.'); }
/** Require bounded integer counters and line locations. */
function integer(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum || value > 10000000) fail('Invalid counter or line location.'); }
/** Freeze nested validated records. */
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
/** Derive a signature that excludes per-job/per-attempt identifiers for future deduplication. */
function failureSignature(packet) {
  const { attemptId, jobId, failureId, ...identity } = packet.identity;
  const { id, kind, ...diagnostic } = packet.evidence[0];
  return hash(canonical({ identity, category: packet.category, diagnostic }));
}
/** Seal a deterministic packet and validate the exact same public contract consumers use. */
function sealPacket(fields) {
  fields.identity.failureId = failureSignature(fields);
  return validateFailurePacket({ ...fields, packetId: hash(canonical(fields)) });
}
/** Validate packet shape, digest and evidence identities without reading source files. */
function validateFailurePacket(raw) {
  const packet = copy(raw, limits.packetBytes);
  object(packet, ['schemaVersion', 'command', 'status', 'scope', 'origin', 'buildStatus', 'identity', 'category', 'summary', 'primaryEvidenceId', 'evidence', 'omittedDiagnostics', 'omissions', 'packetId']);
  if (packet.schemaVersion !== packetVersion || packet.command !== 'failure-packet' || packet.status !== 'success'
    || packet.scope !== 'explanation-only' || !['attempt', 'worker', 'startup', 'transport'].includes(packet.origin)
    || !['success', 'error', null].includes(packet.buildStatus) || !categories.includes(packet.category)) fail('Unsupported failure packet.', 'INVALID_FAILURE_PACKET');
  object(packet.identity, ['documentId', 'sourceHash', 'recipeFingerprint', 'converterHash', 'toolchainFingerprint', 'resolvedRecipeHash', 'attemptId', 'jobId', 'failureId']);
  for (const key of ['documentId', 'sourceHash', 'failureId']) sha(packet.identity[key]);
  for (const key of ['recipeFingerprint', 'converterHash', 'toolchainFingerprint', 'resolvedRecipeHash']) sha(packet.identity[key], true);
  for (const key of ['attemptId', 'jobId']) if (packet.identity[key] !== null && (typeof packet.identity[key] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(packet.identity[key]))) fail('Invalid attempt/job identity.');
  if (!packet.identity.attemptId && !packet.identity.jobId) fail('Missing attempt and job identity.');
  if (['startup', 'transport'].includes(packet.origin) && (packet.buildStatus !== null || packet.identity.attemptId !== null || !packet.identity.jobId || packet.identity.toolchainFingerprint !== null)) fail('Transport failure cannot claim a completed build or verified worker identity.');
  if (packet.origin === 'attempt' && (!packet.identity.attemptId || packet.identity.jobId !== null || packet.buildStatus === null)) fail('Invalid build-attempt origin.');
  if (packet.origin === 'worker' && (!packet.identity.jobId || !packet.identity.toolchainFingerprint || packet.buildStatus === null)) fail('Invalid validated-worker origin.');
  if ((packet.buildStatus === 'success') !== (packet.category === 'target-publication')) fail('Only failed target publication can accompany a successful PDF.');
  text(packet.summary, 1024);
  if (/[\r\n\t]/.test(packet.summary)) fail('Summary must be one line.');
  if (!Array.isArray(packet.evidence) || packet.evidence.length < 1 || packet.evidence.length > 3) fail('Invalid evidence count.');
  const ids = new Set();
  for (const item of packet.evidence) {
    if (item.kind === 'diagnostic') {
      object(item, ['id', 'kind', 'code', 'stage', 'message', 'sourceLine', 'sourceEndLine']);
      text(item.code, 96); text(item.stage, 64); text(item.message, 1024);
      if (item.sourceLine !== null) { integer(item.sourceLine, 1); integer(item.sourceEndLine, item.sourceLine); }
      else if (item.sourceEndLine !== null) fail('Source range requires a start.');
    } else {
      object(item, ['id', 'kind', 'startLine', 'endLine', 'text', 'truncated']);
      if (!['source', 'log'].includes(item.kind) || typeof item.truncated !== 'boolean') fail('Invalid evidence kind.');
      integer(item.startLine, 1); integer(item.endLine, item.startLine); text(item.text, limits.excerptBytes, true);
      if (item.endLine !== item.startLine + item.text.split('\n').length - 1) fail('Evidence line range differs from text.');
    }
    if (item.id !== `${item.kind}-1` || ids.has(item.id)) fail('Invalid or duplicate evidence ID.');
    ids.add(item.id);
  }
  if (packet.evidence[0].kind !== 'diagnostic' || packet.primaryEvidenceId !== 'diagnostic-1') fail('Missing primary diagnostic.');
  integer(packet.omittedDiagnostics);
  if (!Array.isArray(packet.omissions) || packet.omissions.length > 12) fail('Invalid omissions.');
  packet.omissions.forEach(item => text(item, 512));
  sha(packet.packetId);
  const { packetId, ...body } = packet;
  if (failureSignature(packet) !== packet.identity.failureId || hash(canonical(body)) !== packetId) fail('Failure packet digest differs.', 'FAILURE_PACKET_CHANGED');
  return freeze(packet);
}
/** Accept only bounded explanation text tied to the expected packet and supplied evidence. */
function validateExplanation(raw, expectedPacket) {
  const packet = validateFailurePacket(expectedPacket);
  const response = copy(raw, limits.responseBytes);
  const review = response.schemaVersion === reviewVersion;
  object(response, ['schemaVersion', 'packetId', 'failureId', 'sourceHash', 'verdict', 'summary', 'evidenceIds', 'suggestions', ...(review ? ['locations', 'edits'] : [])]);
  if (![responseVersion, reviewVersion].includes(response.schemaVersion) || !['explained', 'uncertain', 'needs-human'].includes(response.verdict)) fail('Unsupported explanation response.');
  for (const [key, expected] of [['packetId', packet.packetId], ['failureId', packet.identity.failureId], ['sourceHash', packet.identity.sourceHash]]) {
    if (response[key] !== expected) fail(`Explanation has a different ${key}.`, 'STALE_EXPLANATION');
  }
  const known = new Set(packet.evidence.map(item => item.id));
  /** Reject unsupported citations rather than allowing fabricated evidence identifiers. */
  function references(value) {
    if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length || value.some(id => !known.has(id))) fail('Explanation cites unknown, duplicate or missing evidence.');
  }
  text(response.summary, 1200); references(response.evidenceIds);
  if (!Array.isArray(response.suggestions) || response.suggestions.length > 3) fail('At most three manual suggestions are accepted.');
  for (const suggestion of response.suggestions) { object(suggestion, ['text', 'evidenceIds']); text(suggestion.text, 600); references(suggestion.evidenceIds); }
  if (review) {
    if (!Array.isArray(response.locations) || response.locations.length > 3 || !Array.isArray(response.edits) || response.edits.length > 3) fail('At most three locations and manual edits are accepted.');
    /** Resolve a reply range only inside a supplied, complete excerpt. */
    function range(item, sourceOnly = false) {
      const evidence = packet.evidence.find(value => value.id === item.evidenceId);
      if (!evidence || !['source', 'log'].includes(evidence.kind) || (sourceOnly && (evidence.kind !== 'source' || evidence.truncated))) fail('Location requires a supplied excerpt; edits require complete source evidence.');
      integer(item.startLine, evidence.startLine); integer(item.endLine, item.startLine);
      if (item.endLine > evidence.endLine) fail('Location is outside supplied evidence.');
      text(item.reason, 600);
      return evidence;
    }
    for (const location of response.locations) { object(location, ['evidenceId', 'startLine', 'endLine', 'reason']); range(location); }
    const edits = [...response.edits].sort((a, b) => a.startLine - b.startLine);
    let previousEnd = 0;
    for (const edit of edits) {
      object(edit, ['evidenceId', 'startLine', 'endLine', 'before', 'after', 'reason']);
      const evidence = range(edit, true);
      text(edit.before, 4096, true); text(edit.after, 4096, true);
      const expected = evidence.text.split('\n').slice(edit.startLine - evidence.startLine, edit.endLine - evidence.startLine + 1).join('\n');
      if (edit.before !== expected || edit.before === edit.after || edit.startLine <= previousEnd) fail('Manual edit does not match captured lines, overlaps, or makes no change.');
      if (['tool-setup', 'execution', 'configuration', 'target-publication'].includes(packet.category)) fail('This failure category cannot justify a source syntax patch.');
      previousEnd = edit.endLine;
    }
  }
  return freeze(response);
}

module.exports = { packetVersion, responseVersion, reviewVersion, limits, canonical, sealPacket, validateFailurePacket, validateExplanation };
