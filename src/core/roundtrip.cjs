/**
 * Source-aware TeX editing checkpoints, independent of Obsidian and live settings.
 * Usage via CLI, project root: node scripts/workshop.cjs tex-checkout draft.md --out-dir ./tmp/editing
 * Then: node scripts/workshop.cjs tex-sync /path/returned/as/artifacts.session
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { build } = require('./workshop.cjs');
const { parseSnapshot } = require('./snapshot.cjs');
const { convertMarkdown } = require('./markdown.cjs');
const { recover } = require('./reverse.cjs');
const { reconcile } = require('./reconcile.cjs');
const { envelope } = require('./tex-envelope.cjs');

/** Identify exact bytes, not a whitespace-normalized approximation. */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Format Europe/Paris wall time with the project's DDMMYYHHMM convention. */
function timestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return ['day', 'month', 'year', 'hour', 'minute'].map(type => parts.find(part => part.type === type).value).join('');
}

/** Stop without modifying source when a preservation invariant fails. */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Read bounded, valid UTF-8 without silently replacing invalid source bytes. */
async function readText(filename, limit = 16 * 1024 * 1024) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > limit) fail('INPUT_SIZE_LIMIT', `Expected a regular file no larger than ${limit} bytes: ${filename}`);
  const bytes = await fs.readFile(filename);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('INVALID_ENCODING', `Use valid UTF-8: ${filename}`); }
}

/** Create a new JSON artifact, never overwrite a previous preview/checkpoint. */
async function writeJson(filename, value) { await fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }

/** Expose all success/failure information at the public CLI result boundary. */
async function operation(command, action) {
  const result = { schemaVersion: 'workshop-roundtrip.v1', command, status: 'error', timestamp: timestamp(), diagnostics: [], artifacts: {} };
  try { await action(result); result.status = 'success'; }
  catch (error) { result.diagnostics.push({ severity: 'error', code: error.code || 'ROUNDTRIP_FAILED', message: error.message }); }
  if (command === 'tex-sync' && result.status === 'success') result.seal = hash(JSON.stringify(result));
  if (result.artifacts.report) await writeJson(result.artifacts.report, result).catch(error => {
    result.status = 'error'; result.diagnostics.push({ severity: 'error', code: 'REPORT_WRITE_FAILED', message: error.message });
  });
  return result;
}

/** Refuse symlink/hard-link targets and capture the identity of an existing note. */
async function targetIdentity(filename) {
  const absolute = path.resolve(filename);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(absolute) !== absolute) fail('UNSAFE_APPLY_TARGET', 'Apply requires an existing regular file with no symlink path components or hard links.');
  return stat;
}

/** Create and flush recoverable bytes without replacing any existing artifact. */
async function durableCreate(filename, content, mode = 0o600) {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

/** Apply only an unchanged validated preview to an explicitly named, backed-up note. */
async function apply(options) {
  return operation('tex-apply', async result => {
    const reportPath = path.resolve(options.preview);
    const preview = JSON.parse(await readText(reportPath));
    const { seal, ...sealed } = preview;
    if (preview.schemaVersion !== 'workshop-roundtrip.v1' || preview.command !== 'tex-sync' || preview.status !== 'success' || preview.outcome !== 'ready' || hash(JSON.stringify(sealed)) !== seal) fail('INVALID_PREVIEW', 'Only an intact, successful tex-sync preview can be applied.');
    const loaded = await loadSession(preview.session);
    const target = path.resolve(options.input);
    if (target !== loaded.baseline.sourcePath || target !== preview.source.path) fail('WRONG_APPLY_TARGET', 'The explicitly named Markdown is not the checkpoint source.');
    const originalStat = await targetIdentity(target);
    const original = await readText(target, 4 * 1024 * 1024);
    const candidate = await readText(path.join(path.dirname(reportPath), 'candidate.md'), 4 * 1024 * 1024);
    if (hash(original) !== preview.source.sha256 || hash(candidate) !== preview.candidateHash || loaded.sessionHash !== preview.sessionHash || hash(await readText(preview.texPath || path.join(loaded.directory, 'main.tex'))) !== preview.texHash) fail('STALE_PREVIEW', 'Markdown, TeX, candidate, or checkpoint changed since preview; rerun tex-sync before applying.');
    const converted = convertMarkdown(parseSnapshot(candidate), target);
    if (hash(converted.tex + '\n') !== preview.expectedBodyHash || converted.diagnostics.some(item => item.severity === 'error')) fail('STALE_PREVIEW', 'The candidate no longer regenerates the validated TeX.');
    const lockPath = target + '.md2tex-apply.lock';
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('APPLY_BUSY', `Another apply or stale lock exists: ${lockPath}. Inspect ownership before recovery.`); throw error; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, timestamp: timestamp(), target, preview: reportPath }) + '\n');
      const application = path.join(path.dirname(reportPath), 'applications', `${timestamp()}-${randomUUID()}`);
      await fs.mkdir(application, { recursive: true });
      result.artifacts.backup = path.join(application, 'original.md');
      result.artifacts.report = path.join(application, 'apply.json');
      await durableCreate(result.artifacts.backup, original);
      const pending = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.pending`);
      result.artifacts.pending = pending;
      await durableCreate(pending, candidate, originalStat.mode & 0o777);
      const finalStat = await targetIdentity(target);
      if (finalStat.ino !== originalStat.ino || finalStat.dev !== originalStat.dev || hash(await readText(target)) !== preview.source.sha256 || hash(await readText(preview.texPath || path.join(loaded.directory, 'main.tex'))) !== preview.texHash) fail('STALE_PREVIEW', 'The note or TeX changed during apply; backup and pending candidate are retained without replacing the note.');
      await fs.rename(pending, target);
      delete result.artifacts.pending;
      result.artifacts.updated = target;
      if (hash(await readText(target)) !== preview.candidateHash) fail('APPLY_READBACK_CHANGED', 'Readback changed after replacement; pause other editors and inspect the backup. No rollback was attempted.');
      result.outcome = 'applied';
      result.diagnostics.push({ severity: 'warning', code: 'EDITOR_COORDINATION', message: 'Apply checks hashes and uses an atomic rename, but other editors do not share this lock. Keep editors/autosave paused during apply and reload the note afterward.' });
    } finally {
      const owned = await lock.stat();
      await lock.close();
      const current = await fs.lstat(lockPath).catch(() => null);
      if (current?.ino === owned.ino && current.dev === owned.dev) await fs.unlink(lockPath);
    }
  });
}

/** Rescue untracked TeX into new review artifacts without claiming lost provenance. */
async function importTex(options) {
  return operation('tex-import', async result => {
    const original = await readText(path.resolve(options.input), 4 * 1024 * 1024);
    const directory = path.join(path.resolve(options.outDir), `import-${timestamp()}-${randomUUID()}`);
    await fs.mkdir(directory, { recursive: true });
    result.artifacts.original = path.join(directory, 'original.tex');
    result.artifacts.report = path.join(directory, 'import.json');
    await fs.writeFile(result.artifacts.original, original, { flag: 'wx' });
    const parts = options.bodyOnly ? { body: original, preamble: null } : envelope(original);
    let body = parts.body;
    const added = body.endsWith('\n\n') ? 0 : body.endsWith('\n') ? 1 : 2;
    body += '\n'.repeat(added);
    const recovered = recover('', '', body);
    let prefix = '';
    if (parts.preamble !== null) {
      result.artifacts.preamble = path.join(directory, 'preamble.tex');
      await fs.writeFile(result.artifacts.preamble, parts.preamble, { flag: 'wx' });
      prefix = `---\ntex-workshop-preamble: ${JSON.stringify(result.artifacts.preamble)}\n---\n\n`;
    }
    result.artifacts.candidate = path.join(directory, 'candidate.md');
    await fs.writeFile(result.artifacts.candidate, prefix + recovered.markdown, { flag: 'wx' });
    result.outcome = 'review-required';
    result.method = recovered.method;
    result.boundaryNewlinesAdded = added;
    result.bodyHash = hash(body);
    result.diagnostics.push({ severity: 'warning', code: 'UNTRACKED_IMPORT', message: 'No original Markdown history is available. Only the body was reverse-converted; inspect the original, preamble, dependencies and candidate. No TeX was executed, no source replaced, and this report cannot authorize tex-apply.' });
    if (added) result.diagnostics.push({ severity: 'warning', code: 'IMPORT_BOUNDARY_PADDING', message: `Added ${added} terminal newline(s) to frame the body as Markdown blocks; all existing body bytes and the complete original TeX are retained.` });
  });
}

/** Make marker spelling deterministic within one uniquely named checkpoint. */
function marker(id, block, edge) { return `% md2tex:${id}:${block}:${edge}\n`; }

/** Require common literal resource reads to resolve to frozen local dependency names. */
function checkResources(tex, dependencies, checkpointId = null) {
  const visible = envelope(tex, checkpointId).visibleTex;
  const names = new Set(dependencies.flatMap(file => [file.name, file.name.replace(/\.(?:tex|bib|pdf|png|jpe?g)$/i, '')]));
  for (const match of visible.matchAll(/(?<!\\)\\(?:input|include|includegraphics\*?|bibliography|addbibresource|lstinputlisting|verbatiminput)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g)) {
    for (const name of match[1].split(',')) if (!names.has(name.trim())) fail('UNTRACKED_RESOURCE', `Literal TeX file read is outside the frozen recipe: ${name}. Declare the file with --support/--bib at checkout and use its staged basename. Macro-generated file reads still require manual dependency review.`);
  }
}

/** Convert immutable build output into an editable copy and hashed baseline. */
async function checkout(options) {
  return operation('tex-checkout', async result => {
    if (options.converter) fail('STRUCTURAL_REQUIRED', 'Editing checkpoints require the local structural converter.');
    if (!options.built) await readText(path.resolve(options.input), 4 * 1024 * 1024);
    const built = options.built || await build(options);
    result.build = built;
    if (built.status !== 'success') fail('CHECKPOINT_BUILD_FAILED', 'The Markdown must build successfully before a checkpoint can be created; see build.diagnostics.');
    const source = await readText(built.artifacts.source);
    const converted = convertMarkdown(parseSnapshot(source), built.source.path);
    const body = await readText(built.artifacts.body);
    const tex = await readText(built.artifacts.tex);
    checkResources(tex, built.dependencies);
    if (converted.segments.map(segment => segment.tex).join('') !== body) fail('BASELINE_MISMATCH', 'The current converter does not reproduce the successful build.');
    const map = JSON.parse(await readText(built.artifacts.sourceMap));
    const bodyStart = tex.split('\n').slice(0, map.lines[0].texLine - 1).join('\n').length + 1;
    if (tex.slice(bodyStart, bodyStart + body.length) !== body) fail('BASELINE_MISMATCH', 'Cannot locate the exact generated body.');
    const offsets = [0];
    for (const match of source.matchAll(/\n/g)) offsets.push(match.index + 1);
    const blocks = converted.segments.map((segment, index) => {
      const start = offsets[segment.line - 1];
      const end = index + 1 < converted.segments.length ? offsets[converted.segments[index + 1].line - 1] : source.length;
      return { id: `b${String(index + 1).padStart(4, '0')}`, source: source.slice(start, end), start, end, tex: segment.tex };
    });
    const id = randomUUID();
    const directory = path.join(path.resolve(options.outDir), 'editing', `${timestamp()}-${id}`);
    const frozen = path.join(directory, '_checkpoint');
    await fs.mkdir(path.join(frozen, 'dependencies'), { recursive: true });
    const preamble = await readText(built.profile.preamblePath);
    if (hash(preamble) !== built.profile.sha256) fail('STALE_PREAMBLE', 'The preamble changed during checkout; create a fresh checkpoint.');
    const files = [];
    await fs.writeFile(path.join(frozen, 'preamble.tex'), preamble, { flag: 'wx' });
    files.push({ name: 'preamble.tex', sha256: hash(preamble) });
    for (const dependency of built.dependencies) {
      const bytes = await fs.readFile(path.join(built.artifacts.attempt, dependency.name));
      if (hash(bytes) !== dependency.sha256) fail('BASELINE_MISMATCH', `Changed dependency: ${dependency.name}`);
      await fs.writeFile(path.join(frozen, 'dependencies', dependency.name), bytes, { flag: 'wx' });
      await fs.writeFile(path.join(directory, dependency.name), bytes, { flag: 'wx' });
      files.push({ name: `dependencies/${dependency.name}`, editableName: dependency.name, kind: dependency.kind, sha256: hash(bytes) });
    }
    const baseline = { schemaVersion: 'workshop-checkpoint.v1', id, sourcePath: built.source.path, source, sourceHash: hash(source), converterHash: built.converter.sha256,
      prefix: tex.slice(0, bodyStart), suffix: tex.slice(bodyStart + body.length), mdPrefix: source.slice(0, blocks[0].start), blocks, files,
      recipe: { engine: built.profile.engine, bibliography: built.profile.bibliographyMode } };
    const baselineText = JSON.stringify(baseline, null, 2) + '\n';
    await fs.writeFile(path.join(frozen, 'baseline.json'), baselineText, { flag: 'wx' });
    result.artifacts.session = path.join(directory, 'session.json');
    result.artifacts.tex = path.join(directory, 'main.tex');
    await writeJson(result.artifacts.session, { schemaVersion: 'workshop-session.v1', id, baselineHash: hash(baselineText) });
    await fs.writeFile(result.artifacts.tex, baseline.prefix + blocks.map(block => marker(id, block.id, 'begin') + block.tex + marker(id, block.id, 'end')).join('') + baseline.suffix, { flag: 'wx' });
    result.source = { path: built.source.path, sha256: hash(source) };
    result.blockCount = blocks.length;
  });
}

/** Verify baseline integrity and recipe snapshots before using their provenance. */
async function loadSession(filename) {
  const sessionPath = path.resolve(filename);
  const directory = path.dirname(sessionPath);
  const session = JSON.parse(await readText(sessionPath));
  if (session.schemaVersion !== 'workshop-session.v1' || !/^[0-9a-f-]{36}$/.test(session.id)) fail('INVALID_SESSION', 'Not a supported editing session.');
  const baselineText = await readText(path.join(directory, '_checkpoint/baseline.json'));
  if (hash(baselineText) !== session.baselineHash) fail('BASELINE_CHANGED', 'Checkpoint baseline changed; restore it or create a fresh checkpoint.');
  const baseline = JSON.parse(baselineText);
  if (baseline.id !== session.id || baseline.schemaVersion !== 'workshop-checkpoint.v1' || hash(baseline.source) !== baseline.sourceHash) fail('INVALID_SESSION', 'Inconsistent checkpoint metadata.');
  if (hash(await fs.readFile(path.join(__dirname, 'markdown.cjs'))) !== baseline.converterHash) fail('CONVERTER_CHANGED', 'The converter changed since checkout; use the checkpoint converter version or create a fresh checkpoint.');
  for (const file of baseline.files) {
    if (!/^(?:dependencies\/)?[a-zA-Z0-9_. -]+$/.test(file.name) || file.name.includes('..')) fail('INVALID_SESSION', 'Unsafe checkpoint dependency name.');
    if (hash(await fs.readFile(path.join(directory, '_checkpoint', file.name))) !== file.sha256) fail('DEPENDENCY_CHANGED', `Frozen dependency changed: ${file.name}`);
    if (file.editableName && hash(await fs.readFile(path.join(directory, file.editableName))) !== file.sha256) fail('DEPENDENCY_CHANGED', `Edited dependency ${file.editableName}; dependency reconciliation is not implemented.`);
  }
  return { directory, sessionPath, baseline, sessionHash: hash(await readText(sessionPath)) };
}

/** Read every marked block exactly once, refusing edits outside tracked content. */
function editedBlocks(baseline, tex) {
  if (!tex.startsWith(baseline.prefix)) fail('WRAPPER_CHANGED', 'The preamble/document opening changed. Reconcile the recipe separately, then make a new checkpoint.');
  let cursor = baseline.prefix.length;
  const blocks = [];
  for (const block of baseline.blocks) {
    const open = marker(baseline.id, block.id, 'begin');
    const close = marker(baseline.id, block.id, 'end');
    if (!tex.startsWith(open, cursor)) fail('MARKER_CHANGED', `Missing, moved, or damaged ${block.id} marker. Keep markers in order; insert/delete content inside them.`);
    cursor += open.length;
    const end = tex.indexOf(close, cursor);
    if (end < 0 || (end > cursor && tex[end - 1] !== '\n')) fail('MARKER_CHANGED', `Missing or damaged end marker for ${block.id}.`);
    const content = tex.slice(cursor, end);
    if (content.includes(`% md2tex:${baseline.id}:`)) fail('MARKER_CHANGED', `Nested/duplicate marker in ${block.id}.`);
    blocks.push(content); cursor = end + close.length;
  }
  if (tex.slice(cursor) !== baseline.suffix) fail('WRAPPER_CHANGED', 'Content outside tracked blocks or the bibliography/document ending changed. Put body edits inside the markers.');
  return blocks;
}

/** Prepare a validated candidate without replacing the user's Markdown. */
async function sync(options) {
  return operation('tex-sync', async result => {
    const loaded = await loadSession(options.input);
    const { directory, baseline } = loaded;
    if (options.expectedSource && baseline.sourcePath !== path.resolve(options.expectedSource)) fail('CHECKPOINT_SOURCE_MOVED', 'This checkpoint belongs to the previous source path; rebuild the unchanged linked target before reverse preview');
    const texPath = path.resolve(options.texPath || path.join(directory, 'main.tex'));
    const tex = await readText(texPath, 8 * 1024 * 1024);
    const current = await readText(baseline.sourcePath, 4 * 1024 * 1024);
    const preview = path.join(directory, 'previews', `${timestamp()}-${randomUUID()}`);
    await fs.mkdir(preview, { recursive: true });
    result.artifacts.report = path.join(preview, 'preview.json');
    result.artifacts.current = path.join(preview, 'current.md');
    result.artifacts.edited = path.join(preview, 'edited.tex');
    await fs.writeFile(result.artifacts.current, current, { flag: 'wx' });
    await fs.writeFile(result.artifacts.edited, tex, { flag: 'wx' });
    checkResources(tex, baseline.files.filter(file => file.editableName).map(file => ({ name: file.editableName })), baseline.id);
    const edited = editedBlocks(baseline, tex);
    result.changes = [];
    const recovered = baseline.blocks.map((block, index) => {
      const recovered = recover(block.source, block.tex, edited[index]);
      result.changes.push({ block: block.id, method: recovered.method });
      return { ...recovered, tex: edited[index] };
    });
    const merged = reconcile(baseline, current, recovered, options.prefer);
    result.diagnostics.push(...merged.warnings);
    const candidate = merged.markdown;
    const converted = convertMarkdown(parseSnapshot(candidate), baseline.sourcePath);
    if (converted.tex + '\n' !== merged.tex) fail('ROUNDTRIP_MISMATCH', 'The candidate does not regenerate the expected merged TeX exactly; no Markdown was replaced.');
    result.artifacts.candidate = path.join(preview, 'candidate.md');
    await fs.writeFile(result.artifacts.candidate, candidate, { flag: 'wx' });
    result.source = { path: baseline.sourcePath, sha256: hash(current) };
    result.session = loaded.sessionPath;
    result.texHash = hash(tex);
    if (options.texPath) result.texPath = texPath;
    result.candidateHash = hash(candidate);
    result.sessionHash = loaded.sessionHash;
    result.expectedBodyHash = hash(merged.tex);
    result.diagnostics.push(...result.changes.filter(change => change.method === 'raw-tex').map(change => ({ severity: 'warning', code: 'RAW_TEX_PRESERVED', message: `${change.block} remains explicit raw TeX inside Markdown; its bytes were verified, not translated into ordinary Markdown.` })));
    const dependencies = baseline.files.filter(file => file.kind);
    const bib = dependencies.filter(file => file.kind === 'bibliography').map(file => path.join(directory, '_checkpoint', file.name));
    const support = dependencies.filter(file => file.kind === 'support').map(file => path.join(directory, '_checkpoint', file.name));
    result.build = await build({ input: result.artifacts.candidate, outDir: path.join(preview, 'build'), preamble: path.join(directory, '_checkpoint/preamble.tex'), ...baseline.recipe, bib, noBib: !bib.length, support, timeoutMs: options.timeoutMs, latexmk: options.latexmk, signal: options.signal, processOptions: options.processOptions });
    if (result.build.status !== 'success') fail('CANDIDATE_BUILD_FAILED', 'Candidate is preserved but cannot be applied: inspect build.diagnostics.');
    await loadSession(loaded.sessionPath);
    if (hash(await readText(baseline.sourcePath)) !== result.source.sha256 || hash(await readText(texPath)) !== result.texHash || hash(await readText(result.artifacts.candidate)) !== result.candidateHash) fail('STALE_PREVIEW', 'An input changed during compilation. The candidate/build remain available, but a new preview is required.');
    if (hash(await readText(result.build.artifacts.body)) !== result.expectedBodyHash || await readText(result.build.artifacts.tex) !== baseline.prefix + merged.tex + baseline.suffix) fail('ROUNDTRIP_MISMATCH', 'The compiled artifacts do not match the frozen wrapper and expected merged body.');
    result.artifacts.pdf = result.build.artifacts.pdf;
    result.outcome = 'ready';
  });
}

module.exports = { checkout, sync, apply, importTex };
