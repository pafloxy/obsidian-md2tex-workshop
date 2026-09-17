/**
 * Run one approved local agent CLI with bounded file-backed stdin/stdout/stderr.
 * Usage: await runAgentProcess(profile, requestText, { cwd: '/project/tmp/job', signal });
 * The caller owns permission policy and must validate stdout as untrusted data.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

/** Create a typed process failure without exposing raw provider output or secrets. */
function fault(code, message) { return Object.assign(new Error(message), { code }); }
/** Send a bounded request, observe process limits, and return stdout only after a clean exit. */
async function runAgentProcess(profile, input, { cwd, signal } = {}) {
  if (process.platform !== 'linux') throw fault('AGENT_UNSUPPORTED_PLATFORM', 'This runner currently requires Linux process groups.');
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Agent request was cancelled before launch.');
  const inputPath = path.join(cwd, 'request.json'); const outPath = path.join(cwd, 'stdout.json'); const errPath = path.join(cwd, 'stderr.log');
  await fs.writeFile(inputPath, input, { flag: 'wx', mode: 0o600 });
  const inputFile = await fs.open(inputPath, 'r'); let outputFile; let errorFile;
  try { outputFile = await fs.open(outPath, 'wx', 0o600); errorFile = await fs.open(errPath, 'wx', 0o600); }
  catch (error) { await Promise.all([inputFile.close(), outputFile?.close()]); throw error; }
  const env = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...profile.inheritEnv]) {
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  }
  try {
    if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Agent request was cancelled before launch.');
    return await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(profile.executable, profile.args, { cwd, env, shell: false, detached: true, stdio: [inputFile.fd, outputFile.fd, errorFile.fd] }); }
      catch (error) { reject(fault('AGENT_START_FAILED', `Agent could not start: ${error.code || 'spawn error'}.`)); return; }
      let stopped = null; let startError = null; let inspection = Promise.resolve(); let forceTimer;
      /** Signal only this invocation's process group. */
      function kill(name) { if (child.pid) { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') stopped ||= fault('AGENT_CLEANUP_INCOMPLETE', 'Agent process cleanup failed.'); } } }
      /** Terminate after a typed limit, with a fixed escalation deadline. */
      function stop(error) { if (stopped) return; stopped = error; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 1000); }
      /** Abort only this owned invocation. */
      function abort() { stop(fault('AGENT_CANCELLED', 'Agent request was cancelled.')); }
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
      const timer = setTimeout(() => stop(fault('AGENT_TIMEOUT', 'Agent exceeded the invocation deadline.')), profile.timeoutMs);
      const interval = setInterval(poll, 100);
      child.once('error', error => { startError = fault(error.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'AGENT_START_FAILED', `Agent could not start: ${error.code || 'spawn error'}.`); });
      child.once('close', async (code, terminationSignal) => {
        clearTimeout(timer); clearTimeout(forceTimer); clearInterval(interval); signal?.removeEventListener('abort', abort);
        kill('SIGKILL');
        await inspection;
        await inspect();
        if (stopped || startError) { reject(stopped || startError); return; }
        if (code !== 0 || terminationSignal) { reject(fault('AGENT_EXIT_FAILED', 'Agent exited without a successful final response.')); return; }
        try {
          const bytes = await fs.readFile(outPath);
          resolve({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
        } catch { reject(fault('AGENT_PROTOCOL', 'Agent stdout is not valid UTF-8.')); }
      });
    });
  } finally { await Promise.all([inputFile.close(), outputFile.close(), errorFile.close()]); }
}

module.exports = { runAgentProcess };
