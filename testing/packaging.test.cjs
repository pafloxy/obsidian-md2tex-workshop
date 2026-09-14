/**
 * Verify staging, reviewed installation and relocated CLI operation in disposable vaults.
 * Usage from root: node --test --test-isolation=none testing/packaging.test.cjs
 * All outputs stay in project tmp/; the installed plugin and real settings are not read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { stagePackage, readPackage, planInstall, installPackage } = require('../scripts/lib/plugin-package.cjs');
const { execute } = require('./execute.cjs');
const root = path.resolve(__dirname, '..');

/** Create an isolated case with a space in its path to exercise argument/path handling. */
async function scratch() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  return fs.mkdtemp(path.join(root, 'tmp/plugin package-'));
}

/** Stage the real source into a fresh directory inside one test case. */
async function stage(directory, name = 'candidate') {
  const output = path.join(directory, name);
  return stagePackage({ sourceRoot: root, output });
}

/** Run the real CLI with file-based subprocess capture and parse its JSON result. */
async function invoke(script, args = [], cwd = root) {
  const result = await execute(process.execPath, [script, ...args], { cwd }).catch(error => error);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test('staging is deterministic, complete and refuses an existing destination', async () => {
  const dir = await scratch();
  const first = await stage(dir, 'first');
  const second = await stage(dir, 'second');
  assert.equal(first.contentSha256, second.contentSha256);
  const { record } = await readPackage(first.packageDir);
  assert.equal(record.hostIntegration, 'cli-manual');
  assert.ok(record.files.some(item => item.path === 'toolchain/src/core/roundtrip.cjs'));
  assert.ok(record.files.some(item => item.path === 'toolchain/assets/support/eptcs/eptcs.cls'));
  assert.ok(record.files.every(item => !/(^|\/)(data\.json|node_modules|runtime|tmp)(\/|$)/.test(item.path)));
  const before = await fs.readFile(path.join(first.packageDir, 'main.js'));
  await assert.rejects(() => stage(dir, 'first'), { code: 'DESTINATION_EXISTS' });
  assert.deepEqual(await fs.readFile(path.join(first.packageDir, 'main.js')), before);
});

test('default deployment is read-only and apply requires an exact reviewed plan', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const target = path.join(dir, 'vault/.obsidian/plugins/md2tex-workshop');
  const script = path.join(root, 'scripts/deploy-plugin.cjs');
  const preview = await invoke(script, ['--package', packageDir, '--target', target]);
  assert.equal(preview.code, 0, preview.stderr);
  await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
  const refused = await invoke(script, ['--package', packageDir, '--target', target, '--apply']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /REVIEW_REQUIRED/);
  await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
  const installed = await invoke(script, ['--package', packageDir, '--target', target, '--apply', '--expect-plan', preview.json.sha256, '--backup-dir', path.join(dir, 'backup')]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(installed.json.status, 'success');
});

test('upgrade backs up managed replacements and preserves settings and output history', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const target = path.join(dir, 'installed');
  await fs.mkdir(path.join(target, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(target, 'main.js'), 'prior plugin code\n');
  await fs.writeFile(path.join(target, 'data.json'), '{"fixtureOnly":true}\n');
  await fs.writeFile(path.join(target, 'runtime/previous.pdf'), 'preserved output');
  const plan = await planInstall({ packageDir, target });
  assert.ok(!plan.changes.some(item => item.path === 'data.json'));
  const result = await installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir: path.join(dir, 'backup') });
  assert.equal(await fs.readFile(path.join(dir, 'backup/files/main.js'), 'utf8'), 'prior plugin code\n');
  assert.equal(await fs.readFile(path.join(target, 'data.json'), 'utf8'), '{"fixtureOnly":true}\n');
  assert.equal(await fs.readFile(path.join(target, 'runtime/previous.pdf'), 'utf8'), 'preserved output');
  const report = JSON.parse(await fs.readFile(result.reportPath));
  assert.equal(report.status, 'success');
  assert.ok((await planInstall({ packageDir, target })).changes.every(item => item.action === 'unchanged'));
});

test('changed targets or packages fail before installation writes or backup creation', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const target = path.join(dir, 'installed');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'main.js'), 'before');
  const plan = await planInstall({ packageDir, target });
  await fs.writeFile(path.join(target, 'main.js'), 'concurrent change');
  const backupDir = path.join(dir, 'backup');
  await assert.rejects(() => installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir }), { code: 'STALE_INSTALL_PLAN' });
  assert.deepEqual(await fs.readdir(target), ['main.js']);
  await assert.rejects(() => fs.access(backupDir), { code: 'ENOENT' });
  await fs.appendFile(path.join(packageDir, 'main.js'), '\nchanged');
  await assert.rejects(() => planInstall({ packageDir, target }), { code: 'PACKAGE_CHANGED' });
});

test('package traversal and symlink targets are refused without changing their referents', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  const target = path.join(dir, 'installed');
  await fs.mkdir(target);
  await fs.symlink(outside, path.join(target, 'toolchain'), 'dir');
  await assert.rejects(() => planInstall({ packageDir, target }), { code: 'SYMLINK_REFUSED' });
  assert.deepEqual(await fs.readdir(outside), []);
  const recordPath = path.join(packageDir, 'workshop-package.json');
  const record = JSON.parse(await fs.readFile(recordPath));
  record.files.unshift({ path: '../outside/data.json', bytes: 1, sha256: '0'.repeat(64) });
  await fs.writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(() => readPackage(packageDir), { code: 'INVALID_PACKAGE_PATH' });
});

test('overlapping package, target and backup paths are refused', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  await assert.rejects(() => planInstall({ packageDir, target: path.join(packageDir, 'nested') }), { code: 'OVERLAPPING_DIRECTORIES' });
  const target = path.join(dir, 'installed');
  const plan = await planInstall({ packageDir, target });
  await assert.rejects(() => installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir: path.join(target, 'backup') }), { code: 'OVERLAPPING_DIRECTORIES' });
  await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
});

test('partial installation records completed writes and retains backups without blind rollback', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const target = path.join(dir, 'installed');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'main.js'), 'prior plugin code');
  const plan = await planInstall({ packageDir, target });
  const backupDir = path.join(dir, 'backup');
  const originalWrite = fs.writeFile;
  /** Simulate one destination I/O failure while retaining real backup/report writes. */
  fs.writeFile = async function failStyles(filename, ...args) {
    if (filename === path.join(target, 'styles.css')) throw Object.assign(new Error('Injected destination failure'), { code: 'EIO' });
    return originalWrite.call(fs, filename, ...args);
  };
  try {
    await assert.rejects(() => installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir }), { code: 'EIO' });
  } finally { fs.writeFile = originalWrite; }
  const report = JSON.parse(await fs.readFile(path.join(backupDir, 'installation.json')));
  assert.equal(report.status, 'error');
  assert.ok(report.completed.includes('main.js'));
  assert.equal(await fs.readFile(path.join(backupDir, 'files/main.js'), 'utf8'), 'prior plugin code');
  assert.deepEqual(await fs.readFile(path.join(target, 'main.js')), await fs.readFile(path.join(packageDir, 'main.js')));
});

test('relocated scratch-vault companion keeps its fingerprint and builds through the real CLI', async () => {
  const dir = await scratch();
  const { packageDir } = await stage(dir);
  const target = path.join(dir, 'vault/.obsidian/plugins/md2tex-workshop');
  const plan = await planInstall({ packageDir, target });
  await installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir: path.join(dir, 'backup') });
  await fs.rename(path.join(dir, 'vault'), path.join(dir, 'relocated vault'));
  const vault = path.join(dir, 'relocated vault');
  const cli = path.join(vault, '.obsidian/plugins/md2tex-workshop/toolchain/scripts/workshop.cjs');
  const original = await invoke(path.join(root, 'scripts/workshop.cjs'), ['capabilities']);
  const relocated = await invoke(cli, ['capabilities'], dir);
  assert.equal(relocated.code, 0, relocated.stderr);
  assert.equal(relocated.json.toolchainFingerprint, original.json.toolchainFingerprint);
  assert.equal(relocated.json.features.editorSnapshotBuild, true);
  assert.equal(relocated.json.features.managedRepair, false);
  const input = path.join(vault, 'draft.md');
  const source = '# Relocated draft\n\n> [!lemma] A simple statement\n> <!-- [label{lem:one}] -->\n>\n> The square $x^2$ is nonnegative.\n\nSee [ref{lem:one}].\n';
  await fs.writeFile(input, source);
  const build = await invoke(cli, ['build', input, '--out-dir', path.join(vault, 'output'), '--vault-root', vault], dir);
  assert.equal(build.code, 0, JSON.stringify(build.json));
  assert.equal(build.json.status, 'success');
  assert.deepEqual(build.json.diagnostics, []);
  assert.equal(await fs.readFile(build.json.artifacts.source, 'utf8'), source);
  assert.equal((await fs.readFile(build.json.artifacts.pdf)).subarray(0, 5).toString(), '%PDF-');
  assert.ok(build.json.profile.preamblePath.startsWith(path.join(vault, '.obsidian/plugins/md2tex-workshop/toolchain/assets')));
});
