/**
 * Retain and read request-bound worker failures, including failures before a build attempt.
 * Usage: await retainFailure({ directory, request, frame });
 * Usage: await readRecordedFailure('/absolute/job/failure.json');
 * Writes only new failure metadata in an existing job; never sources or compiler state.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { sourceHash: hash, validateBuildRequest, validateBuildResult, limits: protocolLimits } = require('./protocol.cjs');
const { canonical } = require('./explanation-contract.cjs');
const { createFailurePacket, readEvidence, limits } = require('./failure-packet.cjs');

/** Raise a stable retained-evidence diagnostic. */
function fail(message) { throw Object.assign(new Error(message), { code: 'FAILURE_RECORD_INVALID' }); }
/** Require the job's validated request to match the fixed retained sibling bytes. */
async function requestEvidence(directory, expected) {
  const file = await readEvidence(path.join(directory, 'request.json'), protocolLimits.requestBytes);
  const request = validateBuildRequest(JSON.parse(file.bytes.toString('utf8')));
  if (!path.basename(directory).startsWith(request.jobId + '-')) fail('Job directory does not match the captured request.');
  if (expected && canonical(request) !== canonical(validateBuildRequest(expected))) fail('Retained request differs from the captured request.');
  return { file, request };
}
/** Retain only failed outcomes; callers must keep recording errors secondary to compilation. */
async function retainFailure({ directory, request, frame, error, phase = 'transport' }) {
  directory = path.resolve(directory);
  const captured = await requestEvidence(directory, request);
  let outcome;
  if (frame) {
    const validated = validateBuildResult(frame, captured.request);
    if (validated.result.status === 'success' && validated.result.target?.status !== 'error') return null;
    const { lastSuccessfulResult, ...retained } = validated;
    outcome = { kind: 'worker', frame: retained };
  } else {
    if (!error || typeof error.message !== 'string' || Buffer.byteLength(error.message) > 8192 || !['startup', 'transport'].includes(phase)) fail('Invalid transport failure.');
    outcome = { kind: phase, error: { code: typeof error.code === 'string' ? error.code : 'WORKER_FAILED', message: error.message } };
  }
  const record = { schemaVersion: 'workshop-failure-record.v1', jobId: captured.request.jobId, requestHash: hash(captured.file.bytes), outcome };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > limits.resultBytes) fail('Failure metadata exceeds its byte limit.');
  const filename = path.join(directory, 'failure.json');
  await fs.writeFile(filename, serialized, { flag: 'wx', mode: 0o600 });
  return filename;
}
/** Rebuild a packet from captured request and validated outcome without following result paths. */
async function readRecordedFailure(filename) {
  filename = path.resolve(filename);
  if (path.basename(filename) !== 'failure.json') fail('Select the original job failure.json.');
  const directory = path.dirname(filename);
  const saved = await readEvidence(filename, limits.resultBytes);
  const record = JSON.parse(saved.bytes.toString('utf8'));
  if (record.schemaVersion !== 'workshop-failure-record.v1' || Object.keys(record).sort().join(',') !== 'jobId,outcome,requestHash,schemaVersion') fail('Unsupported failure record.');
  const { request, file } = await requestEvidence(directory);
  if (record.jobId !== request.jobId || record.requestHash !== hash(file.bytes)) fail('Captured request hash or job identity differs.');
  let result;
  let context;
  const outcome = record.outcome;
  if (outcome?.kind === 'worker') {
    if (Object.keys(outcome).sort().join(',') !== 'frame,kind') fail('Unexpected worker record fields.');
    const frame = validateBuildResult(outcome.frame, request);
    result = { ...frame.result, source: { path: request.source.canonicalPath, sha256: request.source.sha256 } };
    context = { origin: 'worker', jobId: request.jobId, directory, toolchainFingerprint: frame.toolchainFingerprint, resolvedRecipeHash: frame.resolvedRecipeHash };
  } else {
    if (!['startup', 'transport'].includes(outcome?.kind) || Object.keys(outcome).sort().join(',') !== 'error,kind'
      || !outcome.error || Object.keys(outcome.error).sort().join(',') !== 'code,message'
      || typeof outcome.error.code !== 'string' || typeof outcome.error.message !== 'string') fail('Invalid transport record.');
    result = { schemaVersion: 'workshop-result.v1', command: 'build', status: 'error', stage: outcome.kind === 'startup' ? 'environment' : 'transport',
      source: { path: request.source.canonicalPath, sha256: request.source.sha256 }, diagnostics: [{ severity: 'error', ...outcome.error }] };
    context = { origin: outcome.kind, jobId: request.jobId, directory, buildStatus: null };
  }
  const packet = createFailurePacket({ result, sourceText: request.source.text, context });
  if (!(await readEvidence(filename, limits.resultBytes)).bytes.equals(saved.bytes)
    || !(await readEvidence(path.join(directory, 'request.json'), protocolLimits.requestBytes)).bytes.equals(file.bytes)) fail('Failure evidence changed while preparing the packet.');
  return packet;
}

module.exports = { retainFailure, readRecordedFailure };
