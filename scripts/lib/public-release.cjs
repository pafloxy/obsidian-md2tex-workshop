/**
 * Export an explicit public source subset without private Git history.
 * Usage: await exportPublic({ sourceRoot, output }); await verifyPublic(output);
 * Output must be fresh. Existing repositories and their contributions are never updated.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeStat, regularFile } = require('./plugin-package.cjs');

const recordName = 'public-release.json';
const schemaVersion = 'workshop-public-source.v1';

/** Report an actionable release failure without exposing scanned content. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Hash exact file bytes. */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Require portable relative file names outside private/runtime namespaces. */
function member(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..')
    || /^(?:\.git|\.obsidian|tmp|runtime|demos|dev|notes|plans)(?:\/|$)/.test(name)
    || /^agent-/.test(name) || name === recordName) fail('PUBLIC_PATH_INVALID', 'Invalid public member');
  return name;
}

/** Identify likely private data; findings contain categories and filenames only. */
function scan(bytes, name) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail('PUBLIC_BINARY_REFUSED', `Review text-only policy for ${name}`);
  const signatures = [
    ['home-path', /\/(?:home|Users)\/[a-zA-Z0-9_.-]+\//],
    ['windows-home', /[A-Z]:\\Users\\[^\\\s]+\\/],
    ['session-record', /(?:rollout-\d{4}-|\.codex\/sessions\/)/],
    ['private-vault', new RegExp(['INRIA' + 'ProjectVault', 'MD-to-' + 'Tex-Compiler'].join('|'))],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['credential', /(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|sk-[a-zA-Z0-9_-]{35,})/],
  ];
  for (const [category, pattern] of signatures) if (pattern.test(text)) {
    fail('PUBLIC_SCAN_FINDING', `${category} in ${name}; review before export`);
  }
}

/** Load the exact versioned inclusion contract, including itself. */
async function selection(root) {
  const manifest = JSON.parse(await regularFile(path.join(root, 'release/public-files.json')));
  if (manifest.schemaVersion !== 'workshop-public-files.v1' || !Array.isArray(manifest.files)
    || manifest.files.length === 0) fail('PUBLIC_SELECTION_INVALID', 'Expected a nonempty public file list');
  const files = manifest.files.map(member);
  if (new Set(files).size !== files.length || !files.includes('release/public-files.json')) {
    fail('PUBLIC_SELECTION_INVALID', 'Selection must be unique and include its own contract');
  }
  return files.sort();
}

/** Collect candidate files and reject links, special files and unexpected members. */
async function tree(root, relative = '') {
  const entries = [];
  for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
    const item = relative ? `${relative}/${name}` : name;
    const stat = await safeStat(path.join(root, item));
    if (stat?.isDirectory()) entries.push(...await tree(root, item));
    else if (stat?.isFile() && stat.nlink === 1) entries.push(item);
    else fail('PUBLIC_FILE_INVALID', `Expected unlinked regular file: ${item}`);
  }
  return entries;
}

/** Export once after reading and scanning every selected source file. */
async function exportPublic({ sourceRoot, output }) {
  sourceRoot = path.resolve(sourceRoot); output = path.resolve(output);
  if (await safeStat(output)) fail('DESTINATION_EXISTS', 'Choose a fresh public candidate directory');
  const names = await selection(sourceRoot);
  const files = [];
  for (const name of names) {
    const filename = path.join(sourceRoot, name);
    const stat = await safeStat(filename);
    if (!stat?.isFile() || stat.nlink !== 1) fail('PUBLIC_FILE_INVALID', `Expected unlinked regular source: ${name}`);
    const bytes = await regularFile(filename); scan(bytes, name);
    files.push({ name, bytes });
  }
  const record = { schemaVersion, files: files.map(({ name, bytes }) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })) };
  record.contentSha256 = hash(JSON.stringify(record.files));
  // Verify source freshness before creating the candidate; export uses captured bytes.
  for (const { name, bytes } of files) if (!bytes.equals(await regularFile(path.join(sourceRoot, name)))) {
    fail('PUBLIC_SOURCE_CHANGED', `Source changed while selecting: ${name}`);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await safeStat(path.dirname(output));
  await fs.mkdir(output);
  for (const { name, bytes } of files) {
    await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true });
    await fs.writeFile(path.join(output, name), bytes, { flag: 'wx' });
  }
  await fs.writeFile(path.join(output, recordName), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return verifyPublic(output);
}

/** Verify the exact fresh artifact; run before adding Git metadata or test output. */
async function verifyPublic(output) {
  output = path.resolve(output);
  const record = JSON.parse(await regularFile(path.join(output, recordName)));
  if (record.schemaVersion !== schemaVersion || !Array.isArray(record.files)) fail('PUBLIC_RECORD_INVALID', 'Invalid source manifest');
  const expected = await selection(output);
  if (JSON.stringify(record.files.map(item => member(item.path))) !== JSON.stringify(expected)
    || record.contentSha256 !== hash(JSON.stringify(record.files))) fail('PUBLIC_RECORD_INVALID', 'Selection or manifest digest differs');
  const actual = await tree(output);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected, recordName].sort())) {
    fail('PUBLIC_UNEXPECTED_FILES', 'Candidate file set differs; keep verification output outside it');
  }
  for (const item of record.files) {
    const bytes = await regularFile(path.join(output, item.path)); scan(bytes, item.path);
    if (item.bytes !== bytes.length || item.sha256 !== hash(bytes)) fail('PUBLIC_FILE_CHANGED', `Changed public file: ${item.path}`);
  }
  return { schemaVersion, status: 'success', directory: output, fileCount: expected.length, contentSha256: record.contentSha256 };
}

module.exports = { exportPublic, verifyPublic, scan, member };
