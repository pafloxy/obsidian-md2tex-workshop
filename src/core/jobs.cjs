/**
 * Execute immutable host requests through the existing compiler and recover owned job locks.
 * Usage: await executeBuild(request, { signal, emit: event => writeEvent(event) });
 * Usage: await runWorker(requestPath, { managedGroup: true });
 * Managed groups require a Linux worker launched with detached:true; terminal workers
 * without that option retain the CLI's individual subprocess-group behavior.
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { status } = require('./workshop.cjs');
const { buildLinked: build } = require('./targets.cjs');
const { capabilities } = require('./capabilities.cjs');
const { limits, protocolVersion, sourceHash, validateBuildRequest, validateBuildResult } = require('./protocol.cjs');

/** Read bounded UTF-8 JSON from a regular file without following its final symlink. */
async function readJson(filename, maximum) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular JSON file');
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw Object.assign(new Error('Job data exceeds its byte limit'), { code: 'PROTOCOL_LIMIT' });
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

/** Run one validated source snapshot, retaining its canonical history and actual recipe. */
async function executeBuild(raw, { signal, emit = () => {}, processOptions } = {}) {
  const request = validateBuildRequest(raw);
  const discovered = await capabilities();
  const owner = { protocolVersion, jobId: request.jobId, documentId: request.documentId, sourceHash: request.source.sha256 };
  let sequence = 0;
  const result = await build({ input: request.source.canonicalPath, sourceText: request.source.text, outDir: request.outputRoot,
    vaultRoot: request.vaultRoot, ...request.recipeOverrides, ...request.execution, signal, processOptions, jobId: request.jobId,
    /** Stream only working stages; completion follows artifact publication and lock release. */
    onStage(stage) { if (stage !== 'complete') emit({ ...owner, kind: 'progress', sequence: sequence++, stage }); },
  });
  const recipe = result.profile ? { profile: result.profile, dependencies: result.dependencies, converter: result.converter, execution: request.execution } : null;
  const history = await status({ input: request.source.canonicalPath, outDir: request.outputRoot });
  const frame = validateBuildResult({ ...owner, kind: 'result', resolvedRecipeHash: recipe ? sourceHash(JSON.stringify(recipe)) : null,
    toolchainFingerprint: discovered.toolchainFingerprint, result, lastSuccessfulResult: history.lastSuccess || null }, request);
  emit(frame);
  return frame;
}

/** Prove this Linux process is its own process-group leader before signaling the job group. */
async function assertGroupLeader() {
  if (process.platform !== 'linux') throw Object.assign(new Error('Managed worker groups are currently supported on Linux'), { code: 'UNSUPPORTED_PLATFORM' });
  const stat = await fs.readFile('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (Number(fields[2]) !== process.pid) throw Object.assign(new Error('Managed worker must be launched as its own process group'), { code: 'INVALID_PROCESS_GROUP' });
}

/** Run a CLI worker with bounded request input, NDJSON output and cooperative termination. */
async function runWorker(requestPath, { managedGroup = false } = {}) {
  if (managedGroup) await assertGroupLeader();
  const abort = new AbortController();
  /** Cancel compiler work without exiting before its final artifacts and owned lock are handled. */
  function cancel() { abort.abort(); }
  process.on('SIGTERM', cancel);
  process.on('SIGINT', cancel);
  try {
    const request = await readJson(requestPath, limits.requestBytes);
    return await executeBuild(request, { signal: abort.signal,
      emit: frame => process.stdout.write(JSON.stringify(frame) + '\n'),
      ...(managedGroup ? { processOptions: { grouped: false,
        /** Terminate every member of the verified job group on a compiler limit. */
        onLimit() { process.kill(-process.pid, 'SIGTERM'); },
      } } : {}),
    });
  } finally {
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}

/** Own a non-build CLI operation's inherited TeX group with the same cancellation policy. */
async function managedOperation(action) {
  await assertGroupLeader();
  const abort = new AbortController();
  /** Keep the operation alive long enough to release its owned locks. */
  function cancel() { abort.abort(); }
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try { return await action({ signal: abort.signal, processOptions: { grouped: false, onLimit() { process.kill(-process.pid, 'SIGTERM'); } } }); }
  finally { process.off('SIGTERM', cancel); process.off('SIGINT', cancel); }
}

module.exports = { executeBuild, runWorker, managedOperation };
