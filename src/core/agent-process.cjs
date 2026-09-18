/**
 * Run one approved local agent CLI with bounded file-backed stdin/stdout/stderr.
 * Usage: await runAgentProcess(profile, requestText, { cwd: '/project/tmp/job', signal });
 * The caller owns permission policy and must validate stdout as untrusted data.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { performance } = require('node:perf_hooks');

/** Check that the child has not replaced the original regular output pathname. */
async function checkedOutput(filename, handle, maximum) {
  try {
    const [open, named] = await Promise.all([handle.stat(), fs.lstat(filename)]);
    if (!open.isFile() || !named.isFile() || open.nlink !== 1 || named.nlink !== 1 || open.dev !== named.dev || open.ino !== named.ino)
      throw fault('AGENT_OUTPUT_FAILED', 'Agent output path changed.');
    if (open.size > maximum) throw fault('AGENT_OUTPUT_LIMIT', 'Agent output exceeded its byte limit.');
    return open;
  } catch (error) {
    if (error.code === 'AGENT_OUTPUT_FAILED' || error.code === 'AGENT_OUTPUT_LIMIT') throw error;
    throw fault('AGENT_OUTPUT_FAILED', 'Agent output could not be inspected.');
  }
}

/** Read the retained descriptor from offset zero, allowing at most one extra byte. */
async function readOutput(filename, handle, maximum, active) {
  active();
  const before = await checkedOutput(filename, handle, maximum);
  active();
  const buffer = Buffer.alloc(Math.min(before.size + 1, maximum + 1));
  let offset = 0;
  while (offset < buffer.length) {
    let bytesRead;
    try { ({ bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)); }
    catch { active(); throw fault('AGENT_OUTPUT_FAILED', 'Agent output could not be read.'); }
    active();
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > maximum) throw fault('AGENT_OUTPUT_LIMIT', 'Agent output exceeded its byte limit.');
  const after = await checkedOutput(filename, handle, maximum);
  active();
  if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw fault('AGENT_OUTPUT_FAILED', 'Agent output changed during readback.');
  return buffer.subarray(0, offset);
}

/** Create a typed process failure without exposing raw provider output or secrets. */
function fault(code, message) { return Object.assign(new Error(message), { code }); }
/** Send a bounded request, observe process limits, and return stdout only after a clean exit. */
async function runAgentProcess(profile, input, { cwd, signal } = {}) {
  if (process.platform !== 'linux') throw fault('AGENT_UNSUPPORTED_PLATFORM', 'This runner currently requires Linux process groups.');
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Agent request was cancelled before launch.');
  const deadline = performance.now() + profile.timeoutMs;
  /** Reject work delayed during local setup before a child can be started. */
  function checkSetup() {
    if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Agent request was cancelled before launch.');
    if (performance.now() >= deadline) throw fault('AGENT_TIMEOUT', 'Agent exceeded the invocation deadline.');
  }
  const inputPath = path.join(cwd, 'request.json'); const outPath = path.join(cwd, 'stdout.json'); const errPath = path.join(cwd, 'stderr.log');
  await fs.writeFile(inputPath, input, { flag: 'wx', mode: 0o600 });
  checkSetup();
  const inputFile = await fs.open(inputPath, 'r'); let outputFile; let errorFile;
  try { outputFile = await fs.open(outPath, 'wx+', 0o600); errorFile = await fs.open(errPath, 'wx+', 0o600); }
  catch (error) { await Promise.all([inputFile.close(), outputFile?.close()]); throw error; }
  let result;
  const env = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...profile.inheritEnv]) {
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  let cleanupFailed = false;
  try {
    checkSetup();
    result = await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(profile.executable, profile.args, { cwd, env, shell: false, detached: true, stdio: [inputFile.fd, outputFile.fd, errorFile.fd] }); }
      catch (error) {
        reject(fault('AGENT_START_FAILED', `Agent could not start: ${error.code || 'spawn error'}.`)); return;
      }
      let stopped = null; let startError = null; let inspection = Promise.resolve(); let forceTimer; let closed = false;
      /** Signal only this invocation's process group. */
      function kill(name) { if (child.pid) { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') stopped ||= fault('AGENT_CLEANUP_INCOMPLETE', 'Agent process cleanup failed.'); } } }
      /** Terminate after a typed limit, with a fixed escalation deadline. */
      function stop(error) { if (stopped) return; stopped = error; if (!closed) { kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 1000); } }
      /** Abort only this owned invocation. */
      function abort() { stop(fault('AGENT_CANCELLED', 'Agent request was cancelled.')); }
      /** Preserve the first terminal cause until descriptor readback and decoding finish. */
      function active() {
        if (signal?.aborted) abort();
        if (performance.now() >= deadline) stop(fault('AGENT_TIMEOUT', 'Agent exceeded the invocation deadline.'));
        if (stopped) throw stopped;
      }
      /** Bound retained output by inspecting open regular files while the child runs. */
      async function inspect() {
        try {
          const [out, err] = await Promise.all([outputFile.stat(), errorFile.stat()]);
          if (out.size > 256 * 1024 || err.size > 64 * 1024) stop(fault('AGENT_OUTPUT_LIMIT', 'Agent output exceeded its byte limit.'));
        } catch { stop(fault('AGENT_OUTPUT_FAILED', 'Cannot inspect agent output.')); }
      }
      /** Serialize checks so final readback cannot race a delayed size inspection. */
      function poll() { inspection = inspection.then(inspect); }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(fault('AGENT_TIMEOUT', 'Agent exceeded the invocation deadline.')), Math.max(0, deadline - performance.now()));
      const interval = setInterval(poll, 100);
      child.once('error', error => { startError = fault(error.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'AGENT_START_FAILED', `Agent could not start: ${error.code || 'spawn error'}.`); });
      child.once('close', (code, terminationSignal) => {
        closed = true; clearInterval(interval);
        kill('SIGKILL');
        void (async () => {
          try {
            await inspection;
            await inspect();
            active();
            if (startError) throw startError;
            if (code !== 0 || terminationSignal) throw fault('AGENT_EXIT_FAILED', 'Agent exited without a successful final response.');
            await checkedOutput(errPath, errorFile, 64 * 1024);
            const bytes = await readOutput(outPath, outputFile, 256 * 1024, active);
            active();
            let stdout;
            try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { throw fault('AGENT_PROTOCOL', 'Agent stdout is not valid UTF-8.'); }
            active();
            resolve({ stdout });
          } catch (error) { reject(error); }
          finally { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); }
        })();
      });
    });
  } finally {
    const closed = await Promise.allSettled([inputFile.close(), outputFile.close(), errorFile.close()]);
    cleanupFailed = closed.some(item => item.status === 'rejected');
  }
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Agent request was cancelled.');
  if (performance.now() >= deadline) throw fault('AGENT_TIMEOUT', 'Agent exceeded the invocation deadline.');
  if (cleanupFailed) throw fault('AGENT_CLEANUP_INCOMPLETE', 'Agent process cleanup failed.');
  return result;
}

module.exports = { runAgentProcess };
