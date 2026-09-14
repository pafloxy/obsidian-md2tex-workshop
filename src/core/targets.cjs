/**
 * Persistent whole-file Markdown/TeX links, guarded publication and explicit reverse review.
 * Usage: await setTarget({ input: 'draft.md', target: 'paper.tex' });
 * Usage: await buildLinked({ input: 'draft.md', outDir: './output' });
 * Usage: await previewTarget({ input: 'draft.md' }); await applyTarget({ input, preview });
 * Sidecars are local project data. No target is adopted, deleted or overwritten unconditionally.
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sourceHash: hash } = require('./protocol.cjs');
const { build } = require('./workshop.cjs');
const { checkout, sync, apply } = require('./roundtrip.cjs');

/** Raise a stable linked-target diagnostic, separate from TeX compilation errors. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Read regular unaliased files with a bounded allocation; null means absent. */
async function read(filename, maximum = 16 * 1024 * 1024) {
  let handle;
  try {
    if (await fs.realpath(path.dirname(filename)) !== path.dirname(filename)) fail('UNSAFE_TARGET', 'Target and metadata parents must not be symlinks');
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) fail('UNSAFE_TARGET', `Expected a regular unaliased file of at most ${maximum} bytes: ${filename}`);
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size) fail('TARGET_CHANGED_DURING_READ', 'File size changed while reading; retry without editing it');
    const bytes = buffer.subarray(0, total);
    return { bytes, sha256: hash(bytes), ino: stat.ino, dev: stat.dev, mode: stat.mode };
  } finally { await handle.close(); }
}

/** Write a fresh retained artifact with explicit creation semantics. */
async function create(filename, value) { await fs.writeFile(filename, value, { flag: 'wx', mode: 0o600 }); }

/** Serialize owned state through a fresh file and atomic pointer replacement. */
async function stateWrite(filename, state) {
  const pending = filename + '.' + randomUUID() + '.pending';
  await create(pending, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(pending, filename);
}

/** Load the shared sidecar, checking source/target ownership and relative-path integrity. */
async function load(input) {
  input = path.resolve(input);
  const bindingPath = input + '.workshop.json';
  const bindingFile = await read(bindingPath, 8192);
  if (!bindingFile) return null;
  const binding = JSON.parse(bindingFile.bytes);
  if (binding.schemaVersion !== 'workshop-link.v1' || typeof binding.target !== 'string' || path.isAbsolute(binding.target) || !/^[a-f0-9-]{36}$/.test(binding.id)) fail('INVALID_TARGET_LINK', 'Invalid Markdown target sidecar');
  const target = path.resolve(path.dirname(input), binding.target);
  if (!target.endsWith('.tex')) fail('INVALID_TARGET_LINK', 'A linked target must end in .tex');
  const directory = target + '.workshop';
  const statePath = path.join(directory, 'state.json');
  const file = await read(statePath, 32768);
  if (!file) fail('INVALID_TARGET_LINK', 'The target ownership record is missing');
  const state = JSON.parse(file.bytes);
  if (state.schemaVersion !== 'workshop-target.v1' || state.id !== binding.id || typeof state.source !== 'string' || path.resolve(path.dirname(target), state.source) !== input
    || !Number.isSafeInteger(state.generation) || state.generation < 0 || (state.texHash !== null && !/^[a-f0-9]{64}$/.test(state.texHash))) fail('TARGET_OWNER_MISMATCH', 'The target ownership record does not match this Markdown note');
  if (state.session && (path.isAbsolute(state.session) || path.relative(directory, path.resolve(directory, state.session)).startsWith('..'))) fail('INVALID_TARGET_LINK', 'Checkpoint is outside the owned target directory');
  return { input, bindingPath, binding, bindingHash: bindingFile.sha256, target, directory, statePath, state, stateHash: file.sha256 };
}

/** Report a managed target and external edits without creating any files. */
async function targetStatus({ input }) {
  const link = await load(input);
  if (!link) return { schemaVersion: 'workshop-target-result.v1', command: 'tex-target-status', status: 'success', linked: false, source: path.resolve(input) };
  const current = await read(link.target);
  return { schemaVersion: 'workshop-target-result.v1', command: 'tex-target-status', status: 'success', linked: true,
    source: link.input, target: link.target, generation: link.state.generation, state: link.statePath,
    session: link.state.session ? path.resolve(link.directory, link.state.session) : null,
    externallyEdited: (current?.sha256 || null) !== link.state.texHash, published: Boolean(link.state.texHash), sha256: current?.sha256 || null };
}

/** Claim a new whole-file target; existing files/links require explicit separate reconciliation. */
async function setTarget({ input, target }) {
  input = path.resolve(input); target = path.resolve(target);
  if (!input.endsWith('.md') || !target.endsWith('.tex')) fail('INVALID_TARGET_LINK', 'Use an existing .md source and a new .tex target');
  if (!await read(input)) fail('SOURCE_MISSING', 'Save the Markdown note before linking a target');
  const existing = await load(input);
  if (existing) {
    if (existing.target !== target) fail('TARGET_ALREADY_LINKED', 'This note already has a target; unlink it explicitly before changing the path');
    return targetStatus({ input });
  }
  if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) fail('UNSAFE_TARGET', 'Use a real, existing target directory');
  if (await read(target)) fail('TARGET_EXISTS', 'The selected TeX already exists. Import/reconcile it explicitly; linking will not adopt or overwrite it');
  const id = randomUUID(); const directory = target + '.workshop';
  try { await fs.mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') fail('TARGET_ALREADY_CLAIMED', 'This target has an ownership/history directory. Inspect it instead of replacing it'); throw error; }
  await create(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 'workshop-target.v1', id, source: path.relative(path.dirname(target), input), generation: 0, texHash: null, session: null }) + '\n');
  await create(input + '.workshop.json', JSON.stringify({ schemaVersion: 'workshop-link.v1', id, target: path.relative(path.dirname(input), target) }, null, 2) + '\n');
  return targetStatus({ input });
}

/** Serialize publication/reverse apply and keep a stale interrupted lock inspectable. */
async function locked(link, action) {
  const filename = path.join(link.directory, 'operation.lock');
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('TARGET_BUSY', `Another operation or interrupted lock owns the target: ${filename}`); throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, source: link.input, target: link.target }) + '\n'); return await action(); }
  finally {
    const owned = await handle.stat(); await handle.close();
    const current = await fs.lstat(filename).catch(() => null);
    if (current?.ino === owned.ino && current.dev === owned.dev) await fs.unlink(filename);
  }
}

/** Recheck both the binding and state after any asynchronous preparation. */
async function fresh(link) {
  const current = await load(link.input);
  if (!current || current.bindingHash !== link.bindingHash || current.stateHash !== link.stateHash) fail('TARGET_STATE_CHANGED', 'The linked target changed during this operation; retry from its current state');
}

/** Publish a marked checkpoint to the same named TeX, preserving the old bytes and state. */
async function publish(link, built, options) {
  return locked(link, async () => {
    await fresh(link);
    const original = await read(link.target);
    if ((original?.sha256 || null) !== link.state.texHash) fail('TARGET_EDITED', 'The linked TeX has external edits. Preview its round trip before rebuilding this target');
    const key = hash(JSON.stringify([built.source, built.converter, built.profile, built.dependencies]));
    if (link.state.buildKey === key && original) return { status: 'success', outcome: 'unchanged', target: link.target, generation: link.state.generation };
    const checkpoint = await checkout({ built, outDir: link.directory });
    if (checkpoint.status !== 'success') fail('TARGET_CHECKPOINT_FAILED', checkpoint.diagnostics.map(item => item.message).join('; '));
    const directory = path.dirname(checkpoint.artifacts.session);
    const candidate = await read(checkpoint.artifacts.tex);
    // Stage support beside the fixed TeX only if absent or already byte-identical.
    for (const dependency of built.dependencies) {
      if (dependency.name !== path.basename(dependency.name) || dependency.name === path.basename(link.target)) fail('TARGET_DEPENDENCY_CONFLICT', 'Dependency name collides with the target');
      const current = await read(path.join(path.dirname(link.target), dependency.name));
      if (current && current.sha256 !== dependency.sha256) fail('TARGET_DEPENDENCY_CONFLICT', `Existing dependency differs: ${dependency.name}. Reconcile it explicitly`);
    }
    if (original) await create(path.join(directory, 'previous-target.tex'), original.bytes);
    await create(path.join(directory, 'previous-state.json'), JSON.stringify(link.state, null, 2) + '\n');
    const pending = link.target + '.' + randomUUID() + '.pending';
    await create(pending, candidate.bytes);
    await fresh(link);
    const current = await read(link.target);
    if ((current?.sha256 || null) !== link.state.texHash || current?.ino !== original?.ino || current?.dev !== original?.dev) fail('TARGET_EDITED', 'TeX changed during publication; retained the candidate and backup');
    if (options.signal?.aborted) fail('BUILD_CANCELLED', 'Target publication cancelled');
    for (const dependency of built.dependencies) {
      const destination = path.join(path.dirname(link.target), dependency.name);
      try { await fs.copyFile(path.join(built.artifacts.attempt, dependency.name), destination, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST' || (await read(destination))?.sha256 !== dependency.sha256) throw error; }
    }
    await fresh(link);
    const final = await read(link.target);
    if ((final?.sha256 || null) !== link.state.texHash || final?.ino !== original?.ino || final?.dev !== original?.dev) fail('TARGET_EDITED', 'TeX changed while staging dependencies; retained the candidate and backup');
    if (options.signal?.aborted) fail('BUILD_CANCELLED', 'Target publication cancelled');
    if (original) { await fs.chmod(pending, original.mode & 0o777); await fs.rename(pending, link.target); }
    else { await fs.link(pending, link.target); await fs.unlink(pending); }
    if ((await read(link.target)).sha256 !== candidate.sha256) fail('TARGET_READBACK_CHANGED', 'Target changed after replacement; inspect retained backup, no rollback was attempted');
    await stateWrite(link.statePath, { ...link.state, generation: link.state.generation + 1, texHash: candidate.sha256, sourceHash: built.source.sha256,
      buildKey: key, session: path.relative(link.directory, checkpoint.artifacts.session) });
    return { status: 'success', outcome: 'published', target: link.target, generation: link.state.generation + 1, session: checkpoint.artifacts.session,
      backup: original ? path.join(directory, 'previous-target.tex') : null };
  });
}

/** Keep core build success distinct from a guarded linked-target publication conflict. */
async function buildLinked(options) {
  let link; let linkError;
  try { link = await load(options.input); } catch (error) { linkError = error; }
  const built = await build(options);
  if (built.status !== 'success') return built;
  try {
    if (linkError) throw linkError;
    if (link) built.target = await publish(link, built, options);
  } catch (error) {
    built.target = { status: 'error', target: link?.target || null, code: error.code || 'TARGET_FAILED', message: error.message };
    built.diagnostics.push({ severity: 'warning', stage: 'target-publication', code: built.target.code, message: built.target.message });
  }
  if (built.target) {
    built.artifacts.targetReport = path.join(built.artifacts.attempt, 'target-publication.json');
    await create(built.artifacts.targetReport, JSON.stringify(built.target, null, 2) + '\n');
  }
  return built;
}

/** Reverse-preview edits in the named TeX against its last published checkpoint. */
async function previewTarget(options) {
  const link = await load(options.input);
  if (!link?.state.session) fail('TARGET_NOT_PUBLISHED', 'Build the linked note before requesting a reverse preview');
  return locked(link, async () => {
    await fresh(link);
    return sync({ ...options, input: path.resolve(link.directory, link.state.session), texPath: link.target, expectedSource: link.input });
  });
}

/** Explicit saved-file apply reuses existing preview/freshness/backup guards, then acknowledges TeX. */
async function applyTarget(options) {
  const link = await load(options.input);
  if (!link?.state.session) fail('TARGET_NOT_PUBLISHED', 'No published target checkpoint exists');
  return locked(link, async () => {
    await fresh(link);
    const preview = JSON.parse((await read(path.resolve(options.preview))).bytes);
    if (preview.texPath !== link.target || preview.session !== path.resolve(link.directory, link.state.session)) fail('WRONG_TARGET_PREVIEW', 'This preview belongs to a different target generation');
    const applied = await apply(options);
    if (applied.status === 'success') {
      if ((await read(link.target))?.sha256 !== preview.texHash) fail('TARGET_EDITED', 'TeX changed after Markdown apply; inspect both sources and the retained backup');
      await stateWrite(link.statePath, { ...link.state, generation: link.state.generation + 1, texHash: preview.texHash, buildKey: null });
    }
    return applied;
  });
}

/** Disconnect without deleting the target or history; the retained target remains claimed. */
async function unlinkTarget({ input }) {
  const link = await load(input);
  if (!link) return targetStatus({ input });
  return locked(link, async () => {
    await fresh(link);
    await fs.rename(link.bindingPath, path.join(link.directory, 'unlinked-' + randomUUID() + '.json'));
    return targetStatus({ input });
  });
}

module.exports = { setTarget, targetStatus, unlinkTarget, buildLinked, previewTarget, applyTarget };
