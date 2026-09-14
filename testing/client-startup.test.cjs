/**
 * Verify startup failures through real file-backed client commands.
 * Usage from root: node --test --test-isolation=none testing/client-startup.test.cjs
 * Synthetic companions and retained logs stay under project tmp/.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ToolchainClient } = require('../src/obsidian/client.cjs');

/** Create a synthetic companion that reproduces a worker response at the transport boundary. */
async function fixture(stdout, stderr, code) {
  const root = path.resolve(__dirname, '../tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'client-startup-'));
  const cliPath = path.join(directory, 'companion.cjs');
  await fs.writeFile(cliPath, `/** Synthetic companion; invoked by transport tests. */\nprocess.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};\n`);
  return { directory, client: new ToolchainClient({ nodeCommand: process.execPath, cliPath, outputRoot: directory }) };
}

for (const command of ['capabilities', 'history', 'targetCommand']) {
  test(`${command} preserves startup failure evidence instead of parsing empty output`, async () => {
    const stderr = "SyntaxError: Unexpected token '.'\n";
    const { directory, client } = await fixture('', stderr, 1);
    const args = command === 'targetCommand' ? ['tex-target-status', path.join(directory, 'draft.md')] : command === 'history' ? [path.join(directory, 'draft.md')] : [];
    await assert.rejects(() => client[command](...args), asyncError => {
      assert.equal(asyncError.code, 'TOOLCHAIN_START_FAILED');
      assert.match(asyncError.message, /Node/);
      assert.match(asyncError.message, /SyntaxError/);
      assert.doesNotMatch(asyncError.message, /Unexpected end of JSON input/);
      assert.equal(path.dirname(asyncError.directory), path.join(directory, '.jobs'));
      return true;
    });
    const jobs = await fs.readdir(path.join(directory, '.jobs'));
    assert.equal(await fs.readFile(path.join(directory, '.jobs', jobs[0], 'stderr.log'), 'utf8'), stderr);
  });
}

test('empty, malformed and non-object successful responses are protocol errors', async () => {
  for (const response of ['', '{broken', 'null', '[]']) {
    const { client } = await fixture(response, '', 0);
    await assert.rejects(() => client.capabilities(), { code: 'WORKER_PROTOCOL' });
  }
});

test('valid failed target responses retain the actual ownership diagnostic', async () => {
  const { directory, client } = await fixture(JSON.stringify({ status: 'error', diagnostics: [{ code: 'TARGET_OWNER_MISMATCH', message: 'Ownership changed' }] }), '', 1);
  await assert.rejects(() => client.targetCommand('tex-target-status', path.join(directory, 'draft.md')), { code: 'TARGET_OWNER_MISMATCH', message: 'Ownership changed' });
});
