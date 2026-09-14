/**
 * Verify release boundaries, repeatability and hostile file refusal without TeX.
 * Usage from root: node --test --test-isolation=none testing/public-release.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { exportPublic, verifyPublic } = require('../scripts/lib/public-release.cjs');

/** Prepare synthetic public and private material under project tmp/. */
async function fixture() {
  const scratch = path.resolve(__dirname, '../tmp'); await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, 'public-release-test-'));
  const sourceRoot = path.join(base, 'source'); await fs.mkdir(path.join(sourceRoot, 'release'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'release/public-files.json'), JSON.stringify({ schemaVersion: 'workshop-public-files.v1', files: ['README.md', 'release/public-files.json'] }));
  await fs.writeFile(path.join(sourceRoot, 'README.md'), '# Synthetic public project\n');
  await fs.writeFile(path.join(sourceRoot, 'private-record.json'), 'never export this');
  return { base, sourceRoot, output: path.join(base, 'candidate') };
}

test('public selection is reproducible, excludes unselected files and never overwrites', async () => {
  const f = await fixture(); const a = await exportPublic(f);
  const b = await exportPublic({ ...f, output: path.join(f.base, 'second') });
  assert.equal(a.contentSha256, b.contentSha256);
  await assert.rejects(fs.access(path.join(f.output, 'private-record.json')), { code: 'ENOENT' });
  await assert.rejects(exportPublic(f), { code: 'DESTINATION_EXISTS' });
  assert.equal((await verifyPublic(f.output)).contentSha256, a.contentSha256);
});

test('candidate tampering and unexpected output fail verification', async () => {
  const f = await fixture(); await exportPublic(f);
  await fs.appendFile(path.join(f.output, 'README.md'), 'changed');
  await assert.rejects(verifyPublic(f.output), { code: 'PUBLIC_FILE_CHANGED' });
  const g = await fixture(); await exportPublic(g);
  await fs.writeFile(path.join(g.output, 'private.json'), '{}');
  await assert.rejects(verifyPublic(g.output), { code: 'PUBLIC_UNEXPECTED_FILES' });
});

test('escaping selection and private content fail before any candidate write', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.sourceRoot, 'release/public-files.json'), JSON.stringify({ schemaVersion: 'workshop-public-files.v1', files: ['../secret', 'release/public-files.json'] }));
  await assert.rejects(exportPublic(f), { code: 'PUBLIC_PATH_INVALID' });
  await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  const g = await fixture();
  await fs.writeFile(path.join(g.sourceRoot, 'README.md'), '/' + 'home/' + 'writer/private.md');
  await assert.rejects(exportPublic(g), { code: 'PUBLIC_SCAN_FINDING' });
  await assert.rejects(fs.access(g.output), { code: 'ENOENT' });
});

test('linked source files and linked output parents are refused', async () => {
  const f = await fixture();
  await fs.rename(path.join(f.sourceRoot, 'README.md'), path.join(f.base, 'original.md'));
  await fs.symlink(path.join(f.base, 'original.md'), path.join(f.sourceRoot, 'README.md'));
  await assert.rejects(exportPublic(f), { code: 'SYMLINK_REFUSED' });
  const g = await fixture(); const parent = path.join(g.base, 'linked');
  await fs.symlink(g.sourceRoot, parent, 'dir');
  await assert.rejects(exportPublic({ ...g, output: path.join(parent, 'candidate') }), { code: 'SYMLINK_REFUSED' });
  await assert.rejects(fs.access(path.join(g.sourceRoot, 'candidate')), { code: 'ENOENT' });
});
