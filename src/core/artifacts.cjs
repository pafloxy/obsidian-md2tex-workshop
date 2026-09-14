/**
 * Stable artifact namespaces and conservative recovery of a terminated worker's lock.
 * Usage: documentDirectory(inputPath, outputRoot);
 * Usage: await releaseAbandonedJob(request, workerPid);
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { sourceHash, validateBuildRequest } = require('./protocol.cjs');

/** Resolve the existing canonical-path namespace without using transport filenames. */
function documentDirectory(input, outDir) {
  const absolute = path.resolve(input);
  const name = path.basename(absolute, path.extname(absolute)).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'draft';
  return path.join(path.resolve(outDir), `${name}-${sourceHash(absolute).slice(0, 12)}`);
}

/** Detect live group members on Linux; zombies cannot execute or write build artifacts. */
async function groupActive(groupId) {
  if (!exists(-groupId)) return false;
  if (process.platform !== 'linux') return true;
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const text = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === groupId && fields[0] !== 'Z') return true;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return true;
    }
  }
  return false;
}

/** Inspect whether a worker process/group still exists; permission errors never mean dead. */
function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Wait a bounded grace period for signaled workers/descendants to stop before releasing ownership. */
async function waitForJobExit(workerPid, timeoutMs = 1000) {
  if (!Number.isSafeInteger(workerPid) || workerPid <= 1) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    if (!exists(workerPid) && !await groupActive(workerPid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
}

/** Release only a dead worker's matching job lock; leave ambiguous or active ownership intact. */
async function releaseAbandonedJob(raw, workerPid) {
  const request = validateBuildRequest(raw);
  if (!Number.isSafeInteger(workerPid) || workerPid <= 1 || exists(workerPid) || await groupActive(workerPid)) return { released: false, reason: 'owner-or-group-active' };
  const filename = path.join(documentDirectory(request.source.canonicalPath, request.outputRoot), '.build.lock');
  let handle;
  try { handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ENOENT') return { released: false, reason: 'no-lock' }; throw error; }
  try {
    const owned = await handle.stat();
    if (!owned.isFile() || owned.size > 4096) return { released: false, reason: 'invalid-lock' };
    const lock = JSON.parse(await handle.readFile('utf8'));
    if (lock.pid !== workerPid || lock.jobId !== request.jobId || lock.source !== request.source.canonicalPath) return { released: false, reason: 'different-owner' };
    const current = await fs.lstat(filename);
    if (current.ino !== owned.ino || current.dev !== owned.dev || current.isSymbolicLink()) return { released: false, reason: 'replaced-lock' };
    await fs.unlink(filename);
    return { released: true, reason: 'dead-owned-job', attemptId: lock.attemptId };
  } finally { await handle.close(); }
}

module.exports = { documentDirectory, releaseAbandonedJob, waitForJobExit };
