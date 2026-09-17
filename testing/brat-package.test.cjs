/**
 * Exercise embedded release integrity without running a native Obsidian instance.
 * Usage from root: node --test --test-isolation=none testing/brat-package.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { stageBratPackage } = require('../scripts/lib/brat-package.cjs');
const root = path.resolve(__dirname, '..');

/** Load only the generated class and its runtime resolver, using an inert host base. */
async function fixture() {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/brat package-'));
  const output = path.join(dir, 'release');
  const result = await stageBratPackage({ sourceRoot: root, output });
  const entry = path.join(output, 'main.js');
  const context = { module: { exports: {} },
    /** Supply an inert host while keeping standard Node modules real. */
    require(name) { return name === 'obsidian' ? { Plugin: class {} } : require(name); },
  };
  vm.runInNewContext(await fs.readFile(entry, 'utf8'), context, { filename: entry });
  return { dir, output, result, entry, resolve: context.module.exports.resolveRuntimeEntry };
}

test('three-file releases are deterministic, retain notices and reuse exact runtime files', async () => {
  const f = await fixture();
  const other = await stageBratPackage({ sourceRoot: root, output: path.join(f.dir, 'other') });
  assert.deepEqual(f.result.files, other.files);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['main.js', 'manifest.json', 'styles.css']);
  await assert.rejects(() => stageBratPackage({ sourceRoot: root, output: f.output }), { code: 'DESTINATION_EXISTS' });
  await fs.writeFile(path.join(f.output, 'data.json'), '{"preserve":true}\n');
  const runtime = await f.resolve(f.entry);
  const before = await fs.stat(runtime);
  assert.equal(await f.resolve(f.entry), runtime);
  assert.equal((await fs.stat(runtime)).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(path.join(f.output, 'data.json'), 'utf8'), '{"preserve":true}\n');
  assert.match(await fs.readFile(path.join(path.dirname(runtime), 'THIRD_PARTY_NOTICES.md'), 'utf8'), /EPTCS/);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(runtime), 'toolchain/src/core/markdown.cjs')), await fs.readFile(path.join(root, 'src/core/markdown.cjs')));
});

test('changed and incomplete runtimes are refused without overwriting evidence', async () => {
  const f = await fixture();
  const runtime = await f.resolve(f.entry);
  const converter = path.join(path.dirname(runtime), 'toolchain/src/core/markdown.cjs');
  await fs.writeFile(converter, 'user edit');
  await assert.rejects(() => f.resolve(f.entry), { code: 'RUNTIME_INTEGRITY' });
  assert.equal(await fs.readFile(converter, 'utf8'), 'user edit');
  const g = await fixture();
  await fs.mkdir(path.join(g.output, '.workshop-runtime', g.result.runtimeSha256), { recursive: true });
  await assert.rejects(() => g.resolve(g.entry), { code: 'RUNTIME_INTEGRITY' });
});

test('runtime symlinks cannot redirect extraction or loading', async () => {
  const f = await fixture();
  const outside = path.join(f.dir, 'untouched');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.output, '.workshop-runtime'));
  await assert.rejects(() => f.resolve(f.entry), { code: 'RUNTIME_INTEGRITY' });
  assert.deepEqual(await fs.readdir(outside), []);
  const g = await fixture();
  const runtime = await g.resolve(g.entry);
  const member = path.join(path.dirname(runtime), 'toolchain/src/core/markdown.cjs');
  await fs.rename(member, member + '.preserved');
  await fs.symlink(member + '.preserved', member);
  await assert.rejects(() => g.resolve(g.entry), { code: 'RUNTIME_INTEGRITY' });
});

test('a changed embedded release creates a separate runtime and preserves the previous one', async () => {
  const f = await fixture();
  const prior = await f.resolve(f.entry);
  const { collectPackage } = require('../scripts/lib/plugin-package.cjs');
  const { restoreRuntime } = require('../src/brat-runtime.cjs');
  const { createHash } = require('node:crypto');
  const { files, record } = await collectPackage(root);
  const changed = Buffer.from('A changed release notice.\n');
  files.set('THIRD_PARTY_NOTICES.md', changed);
  const inventory = record.files.map(member => member.path === 'THIRD_PARTY_NOTICES.md'
    ? { path: member.path, bytes: changed.length, sha256: createHash('sha256').update(changed).digest('hex') } : member);
  const payload = { schema: 'workshop-embedded.v1', sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
    files: inventory.map(member => ({ ...member, data: files.get(member.path).toString('base64') })) };
  const next = await restoreRuntime(f.entry, payload);
  assert.notEqual(next, prior);
  assert.match(await fs.readFile(path.join(path.dirname(prior), 'THIRD_PARTY_NOTICES.md'), 'utf8'), /EPTCS/);
  assert.equal(await f.resolve(f.entry), prior);
  payload.files[0].path = '../escape.cjs';
  await assert.rejects(() => restoreRuntime(f.entry, payload), { code: 'RUNTIME_INTEGRITY' });
  await assert.rejects(fs.access(path.join(f.output, '.workshop-runtime/escape.cjs')), { code: 'ENOENT' });
});
