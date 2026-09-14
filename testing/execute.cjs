/**
 * Test subprocess capture through files, including sandboxes that deny IPC pipes.
 * Usage: await execute(process.execPath, ['scripts/workshop.cjs', 'doctor'], { cwd: root });
 * Every capture is retained under the project's tmp/ directory for failure inspection.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Execute a real subprocess with bounded reads and execFile-like success/error results. */
async function execute(command, args, options = {}) {
  const scratch = path.resolve(__dirname, '../tmp');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'test-process-'));
  const stdoutPath = path.join(directory, 'stdout.log');
  const stderrPath = path.join(directory, 'stderr.log');
  const stdoutFile = await fs.open(stdoutPath, 'wx');
  const stderrFile = await fs.open(stderrPath, 'wx');
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, timeout: options.timeout || 120000, stdio: ['ignore', stdoutFile.fd, stderrFile.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
  const limit = options.maxBuffer || 4 * 1024 * 1024;
  for (const filename of [stdoutPath, stderrPath]) if ((await fs.stat(filename)).size > limit) throw new Error(`Test subprocess output exceeds ${limit} bytes: ${filename}`);
  const stdout = await fs.readFile(stdoutPath, 'utf8');
  const stderr = await fs.readFile(stderrPath, 'utf8');
  if (result.code !== 0) throw Object.assign(new Error(`Subprocess failed (${result.signal || result.code}): ${command}; evidence: ${directory}`), { ...result, stdout, stderr });
  return { ...result, stdout, stderr };
}

module.exports = { execute };
