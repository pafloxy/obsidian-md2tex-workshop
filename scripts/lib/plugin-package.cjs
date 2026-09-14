/**
 * Stage and install complete local plugin packages without implicit deployment.
 * Usage: await stagePackage({ sourceRoot, output });
 * Usage: const plan = await planInstall({ packageDir, target });
 * Usage: await installPackage({ packageDir, target, expectedPlan: plan.sha256, backupDir });
 * Installation preserves unowned files; close the plugin before replacing its code.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const recordName = 'workshop-package.json';
const schemaVersion = 'workshop-package.v1';

/** Hash bytes or a stable serialized manifest. */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Raise a stable packaging diagnostic. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Return file metadata or null, rejecting symlinks in every existing path segment. */
async function safeStat(filename) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let stat = await fs.lstat(current);
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    if (!stat.isDirectory()) fail('NOT_DIRECTORY', `Not a directory: ${current}`);
    current = path.join(current, part);
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED', `Use a real path instead of a symlink: ${current}`);
  }
  return stat;
}

/** Read only an existing regular file with no symlink path components. */
async function regularFile(filename) {
  const stat = await safeStat(filename);
  if (!stat?.isFile()) fail('PACKAGE_FILE_REQUIRED', `Regular file required: ${filename}`);
  return fs.readFile(filename);
}

/** Check that a package member stays within the fixed code/assets namespace. */
function validMember(name) {
  return typeof name === 'string' && !name.includes('\\') && !name.includes('\0')
    && name.split('/').every(part => part && part !== '.' && part !== '..')
    && (/^(main\.js|manifest\.json|styles\.css|LICENSE|THIRD_PARTY_NOTICES\.md|release\/third-party\.json)$/.test(name)
      || /^licenses\/[\w.-]+$/.test(name)
      || /^assets\//.test(name)
      || /^toolchain\/(scripts\/workshop\.cjs|package\.json)$/.test(name)
      || /^toolchain\/src\/(core|obsidian)\/[\w-]+\.cjs$/.test(name)
      || /^toolchain\/assets\//.test(name));
}

/** Walk a selected source tree deterministically, refusing non-regular entries. */
async function collect(directory, prefix, files) {
  const stat = await safeStat(directory);
  if (!stat?.isDirectory()) fail('PACKAGE_DIRECTORY_REQUIRED', `Directory required: ${directory}`);
  for (const name of (await fs.readdir(directory)).sort()) {
    const source = path.join(directory, name);
    const relative = `${prefix}/${name}`;
    const entry = await safeStat(source);
    if (entry?.isDirectory()) await collect(source, relative, files);
    else {
      if (!validMember(relative)) fail('INVALID_PACKAGE_PATH', `Unsupported package member: ${relative}`);
      files.set(relative, await regularFile(source));
    }
  }
}

/** Reject equal or nested directories before any packaging or installation writes. */
function separateDirectories(...directories) {
  const paths = directories.map(item => path.resolve(item));
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const relative = path.relative(paths[i], paths[j]);
    const reverse = path.relative(paths[j], paths[i]);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse))) {
      fail('OVERLAPPING_DIRECTORIES', `Directories must be separate: ${paths[i]} and ${paths[j]}`);
    }
  }
}

/** Create a fresh output directory; never clean or overwrite a previous package/backup. */
async function freshDirectory(directory) {
  if (await safeStat(directory)) fail('DESTINATION_EXISTS', `Choose a new directory: ${directory}`);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory);
}

/** Stage the thin manual host and its complete, relocatable deterministic companion. */
async function stagePackage({ sourceRoot, output }) {
  sourceRoot = path.resolve(sourceRoot);
  output = path.resolve(output);
  const files = new Map();
  for (const [source, destination] of [['src/main.js', 'main.js'], ['manifest.json', 'manifest.json'], ['styles.css', 'styles.css'], ['scripts/workshop.cjs', 'toolchain/scripts/workshop.cjs']]) {
    files.set(destination, await regularFile(path.join(sourceRoot, source)));
  }
  await collect(path.join(sourceRoot, 'src/core'), 'toolchain/src/core', files);
  await collect(path.join(sourceRoot, 'src/obsidian'), 'toolchain/src/obsidian', files);
  await collect(path.join(sourceRoot, 'assets'), 'assets', files);
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'release/third-party.json']) files.set(name, await regularFile(path.join(sourceRoot, name)));
  await collect(path.join(sourceRoot, 'licenses'), 'licenses', files);
  for (const [name, bytes] of [...files]) if (name.startsWith('assets/')) files.set(`toolchain/${name}`, bytes);
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  if (manifest.id !== 'md2tex-workshop' || manifest.isDesktopOnly !== true) fail('INVALID_MANIFEST', 'Expected the desktop md2tex-workshop manifest');
  files.set('toolchain/package.json', Buffer.from(JSON.stringify({ name: 'md2tex-workshop-toolchain', version: manifest.version, private: true, type: 'commonjs' }, null, 2) + '\n'));
  const members = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  const record = { schemaVersion, pluginId: manifest.id, version: manifest.version,
    hostIntegration: 'cli-manual', toolchainEntry: 'toolchain/scripts/workshop.cjs',
    files: members, contentSha256: hash(JSON.stringify(members)) };
  for (const tree of ['src', 'assets', 'scripts']) separateDirectories(output, path.join(sourceRoot, tree));
  await freshDirectory(output);
  for (const [name, bytes] of files) {
    const filename = path.join(output, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: 'wx' });
  }
  await fs.writeFile(path.join(output, recordName), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await readPackage(output);
  return { status: 'success', command: 'package', packageDir: output, contentSha256: record.contentSha256, fileCount: files.size, hostIntegration: record.hostIntegration };
}

/** Verify declared package bytes and its fixed namespace before trusting deployment input. */
async function readPackage(packageDir) {
  packageDir = path.resolve(packageDir);
  const recordBytes = await regularFile(path.join(packageDir, recordName));
  const record = JSON.parse(recordBytes.toString('utf8'));
  if (record.schemaVersion !== schemaVersion || record.pluginId !== 'md2tex-workshop' || !Array.isArray(record.files)
    || record.files.length > 1024 || record.toolchainEntry !== 'toolchain/scripts/workshop.cjs') fail('INVALID_PACKAGE', 'Unsupported package manifest');
  const names = new Set();
  const files = new Map();
  for (const member of record.files) {
    if (!validMember(member.path) || names.has(member.path)) fail('INVALID_PACKAGE_PATH', `Invalid or duplicate package member: ${member.path}`);
    names.add(member.path);
    const bytes = await regularFile(path.join(packageDir, member.path));
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) fail('PACKAGE_CHANGED', `Package bytes changed: ${member.path}`);
    files.set(member.path, bytes);
  }
  for (const required of ['main.js', 'manifest.json', 'styles.css', 'toolchain/package.json', 'toolchain/scripts/workshop.cjs', 'toolchain/src/core/workshop.cjs', 'toolchain/src/core/protocol.cjs', 'toolchain/src/obsidian/plugin.cjs', 'toolchain/src/obsidian/client.cjs', 'toolchain/assets/preambles/default-preamble.tex']) {
    if (!names.has(required)) fail('INCOMPLETE_PACKAGE', `Missing required package member: ${required}`);
  }
  if (hash(JSON.stringify(record.files)) !== record.contentSha256) fail('PACKAGE_CHANGED', 'Package inventory hash does not match');
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  if (manifest.id !== record.pluginId || manifest.version !== record.version || manifest.isDesktopOnly !== true) fail('INVALID_MANIFEST', 'Plugin manifest differs from package identity');
  files.set(recordName, recordBytes);
  return { record, files };
}

/** Describe managed-file changes, reading neither settings nor unowned output history. */
async function prepareInstall({ packageDir, target }) {
  packageDir = path.resolve(packageDir);
  target = path.resolve(target);
  separateDirectories(packageDir, target);
  const { record, files } = await readPackage(packageDir);
  const targetStat = await safeStat(target);
  if (targetStat && !targetStat.isDirectory()) fail('NOT_DIRECTORY', `Target is not a directory: ${target}`);
  const changes = [];
  for (const [name, bytes] of files) {
    const destination = path.join(target, name);
    const stat = await safeStat(destination);
    if (stat && !stat.isFile()) fail('TARGET_NOT_FILE', `Managed destination is not a regular file: ${destination}`);
    const before = stat ? await regularFile(destination) : null;
    if (name === 'manifest.json' && before && JSON.parse(before.toString('utf8')).id !== record.pluginId) fail('PLUGIN_ID_MISMATCH', 'Target belongs to a different plugin');
    const oldHash = before === null ? null : hash(before);
    const newHash = hash(bytes);
    changes.push({ path: name, before: oldHash, after: newHash, action: oldHash === newHash ? 'unchanged' : oldHash === null ? 'create' : 'replace' });
  }
  const plan = { schemaVersion: 'workshop-install-plan.v1', packageDir, target, contentSha256: record.contentSha256, changes };
  return { plan: { ...plan, sha256: hash(JSON.stringify(plan)) }, files };
}

/** Return a review-only installation plan; no files or directories are created. */
async function planInstall(options) { return (await prepareInstall(options)).plan; }

/** Apply an exact reviewed plan with backups; partial failure never triggers blind rollback. */
async function installPackage({ packageDir, target, expectedPlan, backupDir }) {
  if (!/^[a-f0-9]{64}$/.test(expectedPlan || '') || !backupDir) fail('REVIEW_REQUIRED', 'Apply requires --expect-plan SHA256 and a fresh --backup-dir');
  packageDir = path.resolve(packageDir);
  target = path.resolve(target);
  backupDir = path.resolve(backupDir);
  separateDirectories(packageDir, target, backupDir);
  const { plan, files } = await prepareInstall({ packageDir, target });
  if (plan.sha256 !== expectedPlan) fail('STALE_INSTALL_PLAN', 'Package or managed target files changed; review a fresh plan');
  await freshDirectory(backupDir);
  const report = { schemaVersion: 'workshop-install-report.v1', status: 'prepared', plan, completed: [], backupDir };
  const reportPath = path.join(backupDir, 'installation.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  try {
    for (const change of plan.changes) if (change.action === 'replace') {
      const previous = await regularFile(path.join(target, change.path));
      if (hash(previous) !== change.before) fail('STALE_INSTALL_PLAN', `Target changed before backup: ${change.path}`);
      const backup = path.join(backupDir, 'files', change.path);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, previous, { flag: 'wx' });
    }
    if ((await planInstall({ packageDir, target })).sha256 !== expectedPlan) fail('STALE_INSTALL_PLAN', 'Package or target changed while preparing backups');
    for (const change of plan.changes) {
      if (change.action === 'unchanged') continue;
      const destination = path.join(target, change.path);
      await safeStat(destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (change.action === 'create') await fs.writeFile(destination, files.get(change.path), { flag: 'wx' });
      else {
        const pending = `${destination}.${randomUUID()}.pending`;
        await fs.writeFile(pending, files.get(change.path), { flag: 'wx' });
        if (hash(await regularFile(destination)) !== change.before) fail('STALE_INSTALL_PLAN', `Target changed before replacement: ${change.path}`);
        await fs.rename(pending, destination);
      }
      report.completed.push(change.path);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      if (hash(await regularFile(destination)) !== change.after) fail('INSTALL_READBACK_FAILED', `Readback differs: ${change.path}`);
    }
    for (const change of plan.changes) if (hash(await regularFile(path.join(target, change.path))) !== change.after) fail('INSTALL_READBACK_FAILED', `Final readback differs: ${change.path}`);
    report.status = 'success';
  } catch (error) {
    report.status = 'error';
    report.diagnostic = { code: error.code || 'INSTALL_FAILED', message: error.message };
    throw Object.assign(error, { reportPath });
  } finally {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return { status: 'success', command: 'install', target, reportPath, changedFiles: report.completed.length };
}

module.exports = { stagePackage, readPackage, planInstall, installPackage, safeStat, regularFile };
