/**
 * Bounded desktop transport to a configured standalone Node toolchain.
 * Usage: await new ToolchainClient({ nodeCommand, cliPath, outputRoot }).invoke(request, { signal, onEvent });
 * Retains request/stdout/stderr under outputRoot/.jobs; no shell, provider or source writes.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { protocolVersion, validateBuildRequest, validateBuildEvent, validateBuildResult } = require('../core/protocol.cjs');
const { releaseAbandonedJob, waitForJobExit } = require('../core/artifacts.cjs');

/** Create a bounded transport error with a retained evidence directory. */
function failure(code, message, directory) { return Object.assign(new Error(message), { code, directory }); }

/** Preserve startup evidence when a companion exits before returning a JSON object. */
function response(result, nodeCommand) {
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* An empty response commonly means Node could not load the companion. */ }
  const startup = result.code !== 0;
  const signature = result.stderr.match(/^(?:SyntaxError|TypeError|ReferenceError|RangeError|Error):[^\r\n]*/m)?.[0];
  throw failure(startup ? 'TOOLCHAIN_START_FAILED' : 'WORKER_PROTOCOL',
    `Configured Node executable "${nodeCommand}" returned no valid workshop response (exit ${result.code}). Check the Node version and companion package.${signature ? ` ${signature.slice(0, 300)}.` : ''} Details: ${path.join(result.directory, 'stderr.log')}`, result.directory);
}

/** Run configured workers with explicit process-group ownership and validated output. */
class ToolchainClient {
  /** Bind trusted executable/package paths; output location is independent of the working directory. */
  constructor({ nodeCommand = 'node', cliPath, outputRoot }) {
    this.nodeCommand = nodeCommand;
    this.cliPath = path.resolve(cliPath);
    this.outputRoot = path.resolve(outputRoot);
  }

  /** Create one fresh retained transport directory without deleting previous attempts. */
  async directory(label) {
    const root = path.join(this.outputRoot, '.jobs');
    await fs.mkdir(root, { recursive: true });
    const directory = path.join(root, `${label}-${randomUUID()}`);
    await fs.mkdir(directory);
    return directory;
  }

  /** Capture a real child through files, stream complete NDJSON frames, and bound its lifetime. */
  async run(args, directory, { signal, timeoutMs = 10000, onLine } = {}) {
    if (process.platform !== 'linux') throw failure('UNSUPPORTED_PLATFORM', 'Manual worker integration currently requires Linux process groups', directory);
    if (signal?.aborted) throw failure('BUILD_CANCELLED', 'Build cancelled before worker launch', directory);
    const outputPath = path.join(directory, 'stdout.jsonl');
    const errorPath = path.join(directory, 'stderr.log');
    const output = await fs.open(outputPath, 'wx');
    let errors;
    try { errors = await fs.open(errorPath, 'wx'); }
    catch (error) { await output.close(); throw error; }
    let child;
    let stopped;
    let forceTimer;
    let lastLine = 0;
    let reading = null;
    let code;
    /** Signal the process group created by this invocation, never the Obsidian process group. */
    function kill(name) {
      if (!child?.pid) return;
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') stopped ||= error; }
    }
    /** Stop gracefully first, retaining a fixed deadline for forceful group termination. */
    function stop(error) {
      if (stopped) return;
      stopped = error;
      kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 1500);
    }
    /** Observe cancellation without adding source or provider side effects. */
    function abort() { stop(failure('BUILD_CANCELLED', 'Build cancelled', directory)); }
    /** Consume only complete frames and reject excessive output before allocating its contents. */
    async function read(final = false) {
      const [outStat, errStat] = await Promise.all([fs.stat(outputPath), fs.stat(errorPath)]);
      if (outStat.size > 4 * 1024 * 1024 || errStat.size > 128 * 1024) throw failure('WORKER_OUTPUT_LIMIT', 'Worker output exceeded its limit', directory);
      const stdout = await fs.readFile(outputPath, 'utf8');
      if (onLine) {
        const lines = stdout.split('\n');
        const complete = lines.length - 1;
        if (final && lines[complete]) throw failure('WORKER_PROTOCOL', 'Worker ended with an incomplete frame', directory);
        while (lastLine < complete) {
          const line = lines[lastLine++];
          if (line) {
            let value;
            try { value = JSON.parse(line); }
            catch { throw failure('WORKER_PROTOCOL', 'Worker sent invalid JSON', directory); }
            onLine(value);
          }
        }
      }
      return { stdout, stderr: await fs.readFile(errorPath, 'utf8') };
    }
    /** Avoid overlapping reads while still enforcing output limits on quiet/hung workers. */
    function poll() {
      if (!reading) reading = read().catch(error => stop(error)).finally(() => { reading = null; });
    }
    let interval;
    let timer;
    try {
      const exited = new Promise(resolve => {
        child = spawn(this.nodeCommand, [this.cliPath, ...args], { cwd: path.dirname(this.cliPath), detached: true, stdio: ['ignore', output.fd, errors.fd] });
        child.once('error', error => { stopped ||= failure('NODE_UNAVAILABLE', `Cannot start configured Node: ${error.code || error.message}`, directory); });
        child.once('close', exitCode => resolve(exitCode));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      interval = setInterval(poll, 100);
      timer = setTimeout(() => stop(failure('WORKER_TIMEOUT', 'Worker exceeded the job deadline', directory)), timeoutMs);
      code = await exited;
      clearInterval(interval);
      clearTimeout(timer);
      // A worker may exit before a descendant; the owned group must not outlive the job.
      kill('SIGKILL');
      if (child.pid && !await waitForJobExit(child.pid)) stopped ||= failure('WORKER_CLEANUP_INCOMPLETE', 'A worker descendant has not stopped; retained its ownership lock', directory);
      if (reading) await reading;
      let result;
      try { result = await read(true); }
      catch (error) { stopped ||= error; }
      if (stopped) throw Object.assign(stopped, { workerPid: child.pid });
      return { ...result, code, workerPid: child.pid, directory };
    } finally {
      clearInterval(interval);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      await Promise.all([output.close(), errors.close()]);
    }
  }

  /** Negotiate actual worker features without reading plugin settings or probing AI providers. */
  async capabilities({ signal } = {}) {
    const directory = await this.directory('capabilities');
    const result = await this.run(['capabilities'], directory, { signal });
    const value = response(result, this.nodeCommand);
    if (result.code !== 0 || value.schemaVersion !== 'workshop-capabilities.v1' || value.protocolVersion !== protocolVersion
      || !value.features?.editorSnapshotBuild || !value.features?.managedWorkerGroup || !/^[a-f0-9]{64}$/.test(value.toolchainFingerprint)) {
      throw failure('TOOLCHAIN_INCOMPATIBLE', 'Configured companion does not support this manual worker interface', directory);
    }
    return value;
  }

  /** Read saved build history for one canonical source without compiling or reading the note. */
  async history(canonicalPath, { signal } = {}) {
    const directory = await this.directory('status');
    const result = await this.run(['status', canonicalPath, '--out-dir', this.outputRoot], directory, { signal });
    const value = response(result, this.nodeCommand);
    if (result.code !== 0 || value.schemaVersion !== 'workshop-result.v1' || value.command !== 'status') throw failure('HISTORY_UNAVAILABLE', 'Cannot read prior build history', directory);
    for (const item of [value.lastSuccess, value.latestAttempt]) if (item && item.source?.path !== canonicalPath) throw failure('PROTOCOL_OWNER_MISMATCH', 'Saved history belongs to another note', directory);
    return value;
  }

  /** Run bounded linked-target control commands through the same packaged CLI. */
  async targetCommand(command, canonicalPath, { target, signal, latexmk = 'latexmk', timeoutMs = 30000 } = {}) {
    if (!['tex-target', 'tex-target-status', 'tex-target-sync'].includes(command)) throw failure('INVALID_TARGET_COMMAND', 'Unsupported host target operation');
    const directory = await this.directory(command);
    const args = [command, canonicalPath];
    if (target) args.push('--target', target);
    if (command === 'tex-target-sync') args.push('--latexmk', latexmk, '--timeout-ms', String(timeoutMs), '--managed-group');
    const result = await this.run(args, directory, { signal, timeoutMs: command === 'tex-target-sync' ? timeoutMs + 5000 : 10000 });
    const value = response(result, this.nodeCommand);
    if (result.code !== 0 || value.status !== 'success') throw failure(value.diagnostics?.[0]?.code || 'TARGET_FAILED', value.diagnostics?.[0]?.message || 'Target operation failed', directory);
    if (command !== 'tex-target-sync' && value.source !== canonicalPath) throw failure('PROTOCOL_OWNER_MISMATCH', 'Target belongs to another note', directory);
    if (command === 'tex-target-sync' && value.source?.path !== canonicalPath) throw failure('PROTOCOL_OWNER_MISMATCH', 'Reverse preview belongs to another note', directory);
    return value;
  }

  /** Build one captured revision; invalid or late frames never become another note's result. */
  async invoke(raw, { signal, onEvent = () => {} } = {}) {
    const request = validateBuildRequest(raw);
    if (request.outputRoot !== this.outputRoot) throw failure('OUTPUT_ROOT_MISMATCH', 'Client and request output roots differ');
    const discovered = await this.capabilities({ signal });
    const directory = await this.directory(request.jobId);
    const requestPath = path.join(directory, 'request.json');
    await fs.writeFile(requestPath, JSON.stringify(request) + '\n', { flag: 'wx' });
    let frame = null;
    let sequence = -1;
    let workerPid;
    try {
      const processResult = await this.run(['worker', requestPath, '--managed-group'], directory, {
        signal, timeoutMs: request.execution.timeoutMs + 5000,
        /** Enforce frame ordering, exact ownership and the negotiated toolchain identity. */
        onLine(value) {
          if (frame) throw failure('WORKER_PROTOCOL', 'Worker sent data after its final result', directory);
          if (value.kind === 'progress') {
            const event = validateBuildEvent(value, request);
            if (event.sequence <= sequence) throw failure('WORKER_PROTOCOL', 'Worker progress sequence did not advance', directory);
            sequence = event.sequence;
            onEvent(event);
          } else {
            frame = validateBuildResult(value, request);
            if (frame.toolchainFingerprint !== discovered.toolchainFingerprint) throw failure('TOOLCHAIN_CHANGED', 'Toolchain changed after capability negotiation', directory);
          }
        },
      });
      workerPid = processResult.workerPid;
      if (!frame || processResult.code !== (frame.result.status === 'success' ? 0 : 1)) throw failure('WORKER_PROTOCOL', 'Missing result or inconsistent worker exit status', directory);
      return frame;
    } catch (error) {
      workerPid = error.workerPid || workerPid;
      if (workerPid) {
        try { error.lockRecovery = await releaseAbandonedJob(request, workerPid); }
        catch (cause) { error.lockRecovery = { released: false, reason: cause.message }; }
        await fs.writeFile(path.join(directory, 'termination.json'), JSON.stringify({ code: error.code || 'WORKER_FAILED', message: error.message, workerPid, lockRecovery: error.lockRecovery }, null, 2) + '\n');
      }
      throw error;
    }
  }
}

module.exports = { ToolchainClient };
