/**
 * Restore an embedded release without downloads or writes to notes/settings.
 * Usage: await restoreRuntime(pluginEntry, embeddedPayload);
 * This function is embedded verbatim into the three-file release entry.
 */
async function restoreRuntime(pluginEntry, payload) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const { Buffer } = require('node:buffer');
  /** Hash the exact release bytes. */
  function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
  /** Fail closed while preserving all existing files. */
  function fail(message) { throw Object.assign(new Error(`Workshop runtime: ${message}`), { code: 'RUNTIME_INTEGRITY' }); }
  /** Reject links in every existing component, including the plugin directory. */
  async function stat(filename) {
    const absolute = path.resolve(filename);
    let current = path.parse(absolute).root;
    let result = await fs.lstat(current);
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      if (!result.isDirectory()) fail(`not a directory: ${current}`);
      current = path.join(current, part);
      try { result = await fs.lstat(current); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (result.isSymbolicLink()) fail(`symlink refused: ${current}`);
    }
    return result;
  }
  if (payload.schema !== 'workshop-embedded.v1' || !Array.isArray(payload.files)
    || payload.files.length > 1024 || !/^[a-f0-9]{64}$/.test(payload.sha256)) fail('invalid embedded inventory');
  const files = new Map();
  const inventory = [];
  let total = 0;
  for (const member of payload.files) {
    if (typeof member.path !== 'string' || !/^[\w./-]+$/.test(member.path)
      || member.path.split('/').some(part => !part || part === '.' || part === '..')
      || files.has(member.path) || typeof member.data !== 'string') fail('invalid embedded member');
    const bytes = Buffer.from(member.data, 'base64');
    total += bytes.length;
    if (total > 32 * 1024 * 1024 || bytes.length !== member.bytes || hash(bytes) !== member.sha256) fail(`embedded bytes differ: ${member.path}`);
    inventory.push({ path: member.path, bytes: member.bytes, sha256: member.sha256 });
    files.set(member.path, bytes);
  }
  if (hash(JSON.stringify(inventory)) !== payload.sha256 || !files.has('main.js')
    || !files.has('toolchain/src/obsidian/plugin.cjs') || !files.has('toolchain/scripts/workshop.cjs')) fail('incomplete embedded inventory');
  const parent = path.join(path.dirname(path.resolve(pluginEntry)), '.workshop-runtime');
  const destination = path.join(parent, payload.sha256);
  await stat(parent);
  await fs.mkdir(parent, { recursive: true });
  await stat(destination);
  let created = false;
  try { await fs.mkdir(destination); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) {
    for (const [name, bytes] of files) {
      const filename = path.join(destination, name);
      await stat(filename);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bytes, { flag: 'wx' });
    }
  }
  for (const [name, bytes] of files) {
    const filename = path.join(destination, name);
    const metadata = await stat(filename);
    if (!metadata?.isFile() || metadata.size !== bytes.length || hash(await fs.readFile(filename)) !== hash(bytes)) {
      fail(`changed or incomplete runtime: ${filename}. Preserve this directory and move it aside before retrying; no files were repaired.`);
    }
  }
  return path.join(destination, 'main.js');
}

module.exports = { restoreRuntime };
