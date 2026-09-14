/**
 * Bounded local subprocess execution for the workshop core.
 * Example: await runProcess('python3', ['--version'], { cwd: process.cwd() });
 */
const { spawn } = require('node:child_process');

/** Run a process, retaining output and terminating its process group on limits. */
function runProcess(command, args, { cwd, env = process.env, timeoutMs = 30000, maxBytes = 20 * 1024 * 1024, signal: abortSignal, grouped = process.platform !== 'win32', onLimit }) {
  if (abortSignal?.aborted) return Promise.resolve({ command, args, exitCode: null, signal: null, limit: 'cancelled', error: null, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let limit = null;
    let error = null;
    let killTimer;
    /** Signal only the process (group) created by this invocation. */
    function signal(name) {
      if (!child.pid) return;
      try { grouped ? process.kill(-child.pid, name) : child.kill(name); }
      catch (cause) { if (cause.code !== 'ESRCH') error = cause.message; }
    }
    /** Stop work on timeout or output overflow, with bounded escalation. */
    function stop(reason) {
      if (limit) return;
      limit = reason;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), 200);
      if (reason !== 'cancelled') onLimit?.(reason);
    }
    /** Cancel only the subprocess owned by this invocation. */
    function abort() { stop('cancelled'); }
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= maxBytes) chunks[stream].push(chunk);
        else stop('output-limit');
      });
    }
    child.on('error', (cause) => { error = `${cause.code || 'PROCESS_ERROR'}: ${cause.message}`; });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      if (limit && grouped) signal('SIGKILL');
      resolve({ command, args, exitCode, signal: exitSignal, limit, error,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
  });
}

module.exports = { runProcess };
