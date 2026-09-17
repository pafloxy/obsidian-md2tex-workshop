/**
 * Build local, bounded explanation evidence from a retained failed attempt.
 * Usage: const packet = await readFailurePacket('/absolute/attempt/result.json');
 * Usage: const packet = createFailurePacket({ result, sourceText, logText });
 * No provider, compiler, source writes or arbitrary artifact-path traversal.
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { sourceHash: hash } = require('./protocol.cjs');
const { sealPacket, packetVersion } = require('./explanation-contract.cjs');

const limits = Object.freeze({ packetBytes: 48 * 1024, resultBytes: 256 * 1024, sourceBytes: 1024 * 1024, logBytes: 256 * 1024, excerptBytes: 4096 });

/** Refuse missing or inconsistent evidence with a stable diagnostic. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Clip UTF-8 text without splitting a Unicode character or stripping a BOM. */
function clip(text, bytes) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(String(text)).subarray(0, bytes), { stream: true });
}

/** Classify recorded diagnostics without guessing a Markdown error from tool failures. */
function classifyFailure(diagnostic, stage) {
  const code = diagnostic.code || 'BUILD_FAILED';
  if (stage === 'target-publication') return 'target-publication';
  if (/PROCESS_UNAVAILABLE|NODE_UNAVAILABLE|TOOL_UNAVAILABLE|UNSUPPORTED_NODE|TOOLCHAIN|START_FAILED/.test(code)) return 'tool-setup';
  if (/TIMEOUT|OUTPUT_LIMIT|CANCELLED|BUILD_BUSY/.test(code)) return 'execution';
  if (/CITATION|BIBLIOGRAPHY/.test(code)) return 'bibliography';
  if (/UNSUPPORTED_/.test(code)) return 'unsupported-syntax';
  if (['configuration', 'environment'].includes(stage)) return 'configuration';
  if (['preflight', 'conversion'].includes(stage)) return 'markdown';
  if (stage === 'compilation') return 'tex';
  if (stage === 'validation') return 'output-validation';
  return 'runtime';
}

/** Construct an immutable packet from exact captured bytes, never the current note. */
function createFailurePacket({ result: original, sourceText, logText = '', logTruncated = false, context = {} }) {
  const targetFailed = original?.status === 'success' && original.target?.status === 'error';
  const result = targetFailed ? { ...original, status: 'error', stage: 'target-publication', diagnostics: [
    { severity: 'error', stage: 'target-publication', code: original.target.code || 'TARGET_FAILED', message: original.target.message || 'Linked target publication failed.' },
  ] } : original;
  if (!result || result.schemaVersion !== 'workshop-result.v1' || result.command !== 'build' || result.status !== 'error') fail('FAILURE_REQUIRED', 'Select a recorded failed build result.');
  if (!result.source || !path.isAbsolute(result.source.path || '') || !/^[a-f0-9]{64}$/.test(result.source.sha256 || '')
    || (!/^[A-Za-z0-9_-]{1,100}$/.test(result.attemptId || '') && !/^[A-Za-z0-9_-]{1,100}$/.test(context.jobId || ''))) fail('FAILURE_EVIDENCE_MISSING', 'The failure has no retained source/attempt identity.');
  if (typeof sourceText !== 'string' || Buffer.byteLength(sourceText) > limits.sourceBytes || hash(sourceText) !== result.source.sha256) fail('FAILURE_SOURCE_CHANGED', 'Captured failing source is missing, oversized or changed.');
  if (Buffer.from(sourceText).toString('utf8') !== sourceText) fail('FAILURE_SOURCE_CHANGED', 'Captured source is not exact UTF-8.');
  if (typeof logText !== 'string' || Buffer.byteLength(logText) > limits.logBytes) fail('FAILURE_EVIDENCE_LIMIT', 'Log input exceeds its bounded prefix.');
  const errors = Array.isArray(result.diagnostics) ? result.diagnostics.filter(item => item?.severity === 'error') : [];
  if (!errors.length) fail('FAILURE_EVIDENCE_MISSING', 'The recorded failure has no error diagnostic.');
  const first = errors[0];
  const stage = clip(first.stage || result.stage || 'unknown', 64);
  const replacements = [[result.source.path, '[source]'], [result.artifacts?.attempt, '[attempt]'],
    [original.target?.target, '[target]'], [context.directory, '[evidence]'], [result.profile?.preamblePath, '[preamble]'], [result.converter?.path, '[converter]'],
    ...(result.dependencies || []).map(item => [item.path, '[resource]'])].filter(([name]) => typeof name === 'string' && name.length).sort((a, b) => b[0].length - a[0].length);
  /** Remove known local resource paths from prose evidence; source excerpts remain literal. */
  function redact(text) { for (const [name, token] of replacements) text = text.split(name).join(token); return text; }
  const diagnostic = { code: clip(first.code || 'BUILD_FAILED', 96), stage,
    message: clip(redact(String(first.message || 'Recorded build failure')), 1024) };
  const lines = sourceText.split('\n');
  const mapped = first.path === result.source.path && Number.isSafeInteger(first.line) && first.line > 0 && first.line <= lines.length;
  diagnostic.sourceLine = mapped ? first.line : null;
  diagnostic.sourceEndLine = mapped ? (Number.isSafeInteger(first.endLine) && first.endLine >= first.line && first.endLine <= lines.length ? first.endLine : first.line) : null;
  const evidence = [{ id: 'diagnostic-1', kind: 'diagnostic', ...diagnostic }];
  const omissions = [];
  if (mapped) {
    let start = Math.max(1, first.line - 2);
    const end = Math.min(lines.length, Math.max(first.line + 2, diagnostic.sourceEndLine));
    let contextReduced = false;
    let raw = lines.slice(start - 1, end).join('\n');
    if (Buffer.byteLength(raw) > limits.excerptBytes) { start = first.line; raw = lines[first.line - 1]; contextReduced = true; }
    const text = clip(raw, limits.excerptBytes);
    evidence.push({ id: 'source-1', kind: 'source', startLine: start, endLine: start + text.split('\n').length - 1, text, truncated: text !== raw || contextReduced });
  } else omissions.push('No verified Markdown source location is available.');
  if (logText) {
    const logLines = logText.split('\n');
    let index = Number.isSafeInteger(first.logLine) && first.logLine > 0 && first.logLine <= logLines.length
      ? first.logLine - 1 : logLines.findIndex(line => /^!\s|(?:LaTeX|Package .+) Error:/.test(line) || (/^.+?:\d+:\s/.test(line) && !/\bwarning\b/i.test(line)));
    if (index < 0) { index = 0; omissions.push('No causal signature matched in the retained log prefix; the excerpt is context only.'); }
    const start = Math.max(0, index - 1);
    const raw = redact(logLines.slice(start, index + 7).join('\n'));
    const text = clip(raw, limits.excerptBytes);
    evidence.push({ id: 'log-1', kind: 'log', startLine: start + 1, endLine: start + text.split('\n').length, text, truncated: text !== raw });
  } else omissions.push('No TeX log was supplied for this failure.');
  if (logTruncated) omissions.push('Only the first 256 KiB of the TeX log was inspected.');
  if (!context.toolchainFingerprint) omissions.push('Historical full-toolchain identity was not recorded.');
  if (targetFailed) omissions.push('PDF compilation succeeded; linked target publication failed.');
  const recipeFingerprint = result.profile ? hash(JSON.stringify({ profile: result.profile, dependencies: result.dependencies || [] })) : null;
  const identity = { documentId: hash(result.source.path), sourceHash: result.source.sha256, recipeFingerprint,
    converterHash: result.converter?.sha256 || null, toolchainFingerprint: context.toolchainFingerprint || null, resolvedRecipeHash: context.resolvedRecipeHash || null };
  const category = classifyFailure(diagnostic, stage);
  const packet = { schemaVersion: packetVersion, command: 'failure-packet', status: 'success', scope: 'explanation-only', origin: context.origin || 'attempt',
    buildStatus: Object.hasOwn(context, 'buildStatus') ? context.buildStatus : original.status,
    identity: { ...identity, attemptId: result.attemptId || null, jobId: context.jobId || null }, category, summary: diagnostic.message.replace(/[\r\n\t]+/g, ' '),
    primaryEvidenceId: 'diagnostic-1', evidence, omittedDiagnostics: errors.length - 1, omissions };
  return sealPacket(packet);
}

/** Read regular unaliased evidence with bounded allocation and stable file metadata. */
async function readEvidence(filename, maximum, prefix = false) {
  if (await fs.realpath(path.dirname(filename)) !== path.dirname(filename)) fail('UNSAFE_FAILURE_EVIDENCE', 'Evidence parents must not contain symlinks.');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail('UNSAFE_FAILURE_EVIDENCE', 'Evidence must be a regular unaliased file.');
    if (!prefix && before.size > maximum) fail('FAILURE_EVIDENCE_LIMIT', 'Evidence file exceeds its byte limit.');
    const bytes = Buffer.alloc(Math.min(before.size, maximum));
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat();
    if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('FAILURE_EVIDENCE_CHANGED', 'Evidence changed while reading.');
    return { bytes, truncated: before.size > maximum };
  } finally { await handle.close(); }
}

/** Load only fixed sibling filenames, verify source ownership, and return local JSON evidence. */
async function readFailurePacket(resultPath) {
  resultPath = path.resolve(resultPath);
  const record = await readEvidence(resultPath, limits.resultBytes);
  let result = JSON.parse(record.bytes.toString('utf8'));
  const directory = path.dirname(resultPath);
  if (path.basename(resultPath) !== 'result.json' || result.artifacts?.result !== resultPath || result.artifacts?.attempt !== directory
    || result.attemptId !== path.basename(directory) || result.artifacts?.source !== path.join(directory, 'source.md')) fail('FAILURE_OWNER_MISMATCH', 'Use the original attempt result.json with matching ownership.');
  let targetRecord;
  if (result.status === 'success') {
    try {
      targetRecord = await readEvidence(path.join(directory, 'target-publication.json'), limits.resultBytes);
      const target = JSON.parse(targetRecord.bytes.toString('utf8'));
      if (target?.status === 'error' && typeof target.code === 'string' && typeof target.message === 'string') result = { ...result, target };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const source = await readEvidence(path.join(directory, 'source.md'), limits.sourceBytes);
  const sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes);
  let log = { bytes: Buffer.alloc(0), truncated: false };
  try { if (result.status !== 'success') log = await readEvidence(path.join(directory, 'main.log'), limits.logBytes, true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packet = createFailurePacket({ result, sourceText, logText: new TextDecoder('utf-8', { ignoreBOM: true }).decode(log.bytes, { stream: log.truncated }), logTruncated: log.truncated });
  if (!(await readEvidence(resultPath, limits.resultBytes)).bytes.equals(record.bytes)
    || !(await readEvidence(path.join(directory, 'source.md'), limits.sourceBytes)).bytes.equals(source.bytes)) fail('FAILURE_EVIDENCE_CHANGED', 'Evidence changed while preparing the packet.');
  if (targetRecord && !(await readEvidence(path.join(directory, 'target-publication.json'), limits.resultBytes)).bytes.equals(targetRecord.bytes)) fail('FAILURE_EVIDENCE_CHANGED', 'Target publication record changed while preparing evidence.');
  return packet;
}

module.exports = { limits, classifyFailure, createFailurePacket, readFailurePacket, readEvidence };
