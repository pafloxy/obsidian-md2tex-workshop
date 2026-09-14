/**
 * Standalone Markdown -> TeX -> PDF builds, with no Obsidian imports.
 * Example: await build({ input: 'draft.md', outDir: './tmp/builds' });
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { runProcess } = require('./process.cjs');
const { documentDirectory } = require('./artifacts.cjs');
const { resolveConfiguration } = require('./config.cjs');
const { parseSnapshot } = require('./snapshot.cjs');
const { requireProcessSuccess, auditLog } = require('./diagnostics.cjs');
const { inspectLegacyInput } = require('./preflight.cjs');
const { convertMarkdown } = require('./markdown.cjs');
const { bibliography } = require('./bibliography.cjs');

const projectRoot = path.resolve(__dirname, '../..');

/** Format a local timestamp using the project's DDMMYYHHMM convention. */
function timestamp() {
  const now = new Date();
  return [now.getDate(), now.getMonth() + 1, now.getFullYear() % 100, now.getHours(), now.getMinutes()]
    .map((part) => String(part).padStart(2, '0')).join('');
}

/** Hash source bytes or text for provenance. */
function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Read an optional record while reporting corruption rather than hiding it. */
async function optionalJson(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Write a JSON artifact; pointer publication uses an atomic rename. */
async function writeJson(filename, value, atomic = false) {
  const target = atomic ? `${filename}.${randomUUID()}.pending` : filename;
  await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: atomic ? 'wx' : 'w' });
  if (atomic) await fs.rename(target, filename);
}

/** Convert a snapshot and compile its body with a workspace preamble. */
async function build(options) {
  return runBuild(options);
}

/** Replay a verified checkpoint recipe without resolving candidate YAML paths.
 * Internal use: buildFrozen(options, { preamble, engine, bibliography, bib, support }).
 * The CLI/worker never accepts this recipe route from serialized input.
 */
async function buildFrozen(options, recipe) {
  const { preamble, engine, bibliography, bib, support } = recipe;
  return runBuild(options, { preamble, engine, bibliography, bib, support });
}

/** Execute one build; a separately supplied checkpoint recipe owns document inputs. */
async function runBuild(options, frozenRecipe = null) {
  const result = { schemaVersion: 'workshop-result.v1', command: 'build', status: 'error', stage: 'configuration', timestamp: timestamp(), diagnostics: [], artifacts: {} };
  let lock = null;
  let lockPath;
  let sourceLines;
  /** Record progress and refuse to advance a cancelled build. */
  function stage(name) {
    if (options.signal?.aborted) throw Object.assign(new Error('Build cancelled'), { code: 'BUILD_CANCELLED' });
    result.stage = name;
    options.onStage?.(name);
  }
  try {
    stage('configuration');
    if (!options.input || !options.outDir) throw new Error('build requires an input file and --out-dir');
    const input = path.resolve(options.input);
    const source = Object.hasOwn(options, 'sourceText') ? options.sourceText : await fs.readFile(input, 'utf8');
    if (typeof source !== 'string') throw new Error('sourceText must be the exact captured Markdown string');
    const snapshot = parseSnapshot(source);
    const config = await resolveConfiguration(frozenRecipe ? { ...options, ...frozenRecipe } : options, frozenRecipe ? {} : snapshot.metadata);
    if (frozenRecipe) config.origins = Object.fromEntries(Object.keys(config.origins).map(key => [key, 'checkpoint']));
    const { converter, preamblePath, preamble } = config;
    result.source = { path: input, sha256: digest(source) };
    result.converter = { mode: config.converterMode, path: converter, sha256: digest(config.converterSource) };
    result.profile = { name: config.profile, preamblePath, sha256: digest(preamble), engine: config.engine, bibliographyMode: config.bibliographyMode, origins: config.origins };
    result.dependencies = config.dependencies.map(({ bytes, ...entry }) => ({ ...entry, sha256: digest(bytes) }));
    const documentDir = documentDirectory(input, options.outDir);
    result.attemptId = `${timestamp()}-${randomUUID()}`;
    stage('preparation');
    await fs.mkdir(documentDir, { recursive: true });
    lockPath = path.join(documentDir, '.build.lock');
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error(`Another build owns this document. Inspect status before retrying: ${lockPath}`), { code: 'BUILD_BUSY', path: lockPath });
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, attemptId: result.attemptId, source: input, timestamp: result.timestamp, ...(options.jobId ? { jobId: options.jobId } : {}) }) + '\n');
    const attempt = path.join(documentDir, 'attempts', result.attemptId);
    await fs.mkdir(attempt, { recursive: true });
    result.artifacts = {
      attempt, source: path.join(attempt, 'source.md'), conversionInput: path.join(attempt, 'conversion-input.md'), body: path.join(attempt, 'body.tex'),
      tex: path.join(attempt, 'main.tex'), pdf: path.join(attempt, 'main.pdf'),
      result: path.join(attempt, 'result.json'), configuration: path.join(attempt, 'resolved-config.json'), log: path.join(attempt, 'main.log'),
      conversionLog: path.join(attempt, 'conversion.json'), compilationLog: path.join(attempt, 'compilation.json'),
      lastSuccess: path.join(documentDir, 'last-success.json'), latestAttempt: path.join(documentDir, 'latest-attempt.json'),
    };
    await fs.writeFile(result.artifacts.source, source, { flag: 'wx' });
    await fs.writeFile(result.artifacts.conversionInput, snapshot.body, { flag: 'wx' });
    result.source.bodyStartLine = snapshot.bodyStartLine;
    await writeJson(result.artifacts.configuration, { source: result.source, profile: result.profile, converter: result.converter, dependencies: result.dependencies,
      commands: { python: config.python, latexmk: config.latexmk }, timeoutMs: config.timeoutMs, vaultRoot: config.vaultRoot });
    stage('preflight');
    if (config.converterMode === 'external') result.diagnostics.push(...inspectLegacyInput(snapshot, input));
    if (result.diagnostics.length) throw Object.assign(new Error('Known unsupported Markdown'), { reported: true });
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TEXMFVAR: path.join(attempt, 'tex-cache'), TEXMFCONFIG: path.join(attempt, 'tex-config'), VARTEXFONTS: path.join(attempt, 'tex-fonts') };
    const processOptions = { cwd: attempt, env, timeoutMs: config.timeoutMs, signal: options.signal,
      ...(options.processOptions || {}) };
    stage('conversion');
    let body;
    let document;
    if (config.converterMode === 'structural') {
      const conversion = convertMarkdown(snapshot, input);
      document = conversion.document;
      body = conversion.tex;
      sourceLines = conversion.lines;
      result.artifacts.document = path.join(attempt, 'document.json');
      result.artifacts.sourceMap = path.join(attempt, 'source-map.json');
      await writeJson(result.artifacts.document, conversion.document);
      await writeJson(result.artifacts.sourceMap, { schemaVersion: 'workshop-source-map.v1', source: input, lines: sourceLines });
      await writeJson(result.artifacts.conversionLog, { converter: result.converter, diagnostics: conversion.diagnostics });
      result.diagnostics.push(...conversion.diagnostics);
      if (conversion.diagnostics.some(item => item.severity === 'error')) throw Object.assign(new Error('Markdown conversion requires attention'), { reported: true });
    } else {
      const conversion = await runProcess(config.python, [converter, result.artifacts.conversionInput, '--stdout', '--body-only'], processOptions);
      await writeJson(result.artifacts.conversionLog, conversion);
      requireProcessSuccess(conversion, 'conversion');
      body = conversion.stdout.trim();
    }
    if (!body) throw new Error('The converter returned an empty document');
    await fs.writeFile(result.artifacts.body, body + '\n', { flag: 'wx' });
    stage('assembly');
    for (const entry of config.dependencies) await fs.writeFile(path.join(attempt, entry.name), entry.bytes, { flag: 'wx' });
    const placement = bibliography(config, body, document);
    result.bibliographyPlacement = placement.placement;
    const prefix = `${preamble}\n${placement.head}\n\\begin{document}\n`;
    await fs.writeFile(result.artifacts.tex, `${prefix}${body}\n${placement.tail}\n\\end{document}\n`, { flag: 'wx' });
    if (sourceLines) {
      const offset = prefix.split('\n').length - 1;
      sourceLines = sourceLines.map(item => ({ ...item, texLine: item.bodyLine + offset }));
      await writeJson(result.artifacts.sourceMap, { schemaVersion: 'workshop-source-map.v1', source: input, generated: result.artifacts.tex, precision: 'line-range', lines: sourceLines });
    }
    stage('compilation');
    const engineFlag = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[config.engine];
    const compilation = await runProcess(config.latexmk, ['-norc', engineFlag, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-no-shell-escape', 'main.tex'], processOptions);
    await writeJson(result.artifacts.compilationLog, compilation);
    const log = await fs.readFile(result.artifacts.log, 'utf8').catch(() => '');
    requireProcessSuccess(compilation, 'compilation', log);
    stage('validation');
    if (!log) throw Object.assign(new Error('Compiler exited successfully without a TeX log'), { code: 'MISSING_LOG' });
    const pdf = await fs.readFile(result.artifacts.pdf);
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Compiler did not produce a PDF');
    result.diagnostics.push(...auditLog(log));
    if (!result.diagnostics.some((item) => item.severity === 'error')) {
      stage('complete');
      result.status = 'success';
    }
  } catch (error) {
    if (error.line && !error.path) error.path = result.source?.path || path.resolve(options.input || '.');
    if (sourceLines && error.texLine && ['main.tex', './main.tex', result.artifacts.tex].includes(error.texFile)) {
      const original = sourceLines.find(item => item.texLine === error.texLine);
      if (original) { error.path = result.source.path; error.line = original.line; if (original.endLine > original.line) error.endLine = original.endLine; }
    }
    if (!error.reported) result.diagnostics.push({ severity: 'error', code: error.code || 'BUILD_FAILED', stage: result.stage, message: error.message,
      ...Object.fromEntries(['path', 'line', 'endLine', 'texFile', 'texLine'].filter((key) => error[key] !== undefined).map((key) => [key, error[key]])) });
  }
  try {
    if (result.artifacts.result) {
      await writeJson(result.artifacts.result, result);
      await writeJson(result.artifacts.latestAttempt, result, true);
      if (result.status === 'success') await writeJson(result.artifacts.lastSuccess, result, true);
    }
  } catch (error) {
    result.status = 'error';
    result.stage = 'publication';
    result.diagnostics.push({ severity: 'error', code: 'ARTIFACT_WRITE_FAILED', stage: 'publication', message: error.message });
    if (result.artifacts.result) await writeJson(result.artifacts.result, result).catch(() => {});
    if (result.artifacts.latestAttempt) await writeJson(result.artifacts.latestAttempt, result, true).catch(() => {});
  } finally {
    if (lock) {
      // Release only the lock inode created by this invocation, never a replacement.
      try {
        const owned = await lock.stat();
        const current = await fs.stat(lockPath);
        await lock.close();
        if (owned.ino === current.ino && owned.dev === current.dev) await fs.unlink(lockPath);
      } catch (error) {
        await lock.close().catch(() => {});
        result.diagnostics.push({ severity: 'warning', code: 'LOCK_RELEASE_FAILED', stage: 'cleanup', message: error.message, path: lockPath });
      }
    }
  }
  return result;
}

/** Check recipe paths and executables without creating build artifacts. */
async function doctor(options) {
  const result = { schemaVersion: 'workshop-result.v1', command: 'doctor', status: 'error', stage: 'configuration', timestamp: timestamp(), diagnostics: [] };
  try {
    const config = await resolveConfiguration(options);
    result.profile = { name: config.profile, preamblePath: config.preamblePath, engine: config.engine, bibliographyMode: config.bibliographyMode, origins: config.origins };
    result.dependencies = config.dependencies.map(({ bytes, ...entry }) => ({ ...entry, sha256: digest(bytes) }));
    result.converter = config.converter;
    result.stage = 'environment';
    result.tools = [{ command: process.execPath, ready: true, version: `Node.js ${process.versions.node}` }];
    for (const [command, args] of [...(config.converterMode === 'external' ? [[config.python, ['--version']]] : []), [config.latexmk, ['-norc', '-v']], [config.engine, ['--version']],
      ...(config.bibliographyMode === 'none' ? [] : [[config.bibliographyMode === 'biblatex' ? 'biber' : 'bibtex', ['--version']]])]) {
      const check = await runProcess(command, args, { cwd: projectRoot, timeoutMs: config.timeoutMs });
      result.tools.push({ command, ready: !check.error && !check.limit && check.exitCode === 0, version: (check.stdout.trim() || check.stderr.trim()).split('\n')[0] });
      if (check.error || check.limit || check.exitCode !== 0) result.diagnostics.push({ severity: 'error', code: 'TOOL_UNAVAILABLE', stage: 'environment', message: check.error || check.limit || `Unable to run ${command}` });
    }
    if (!result.diagnostics.length) { result.status = 'success'; result.stage = 'complete'; }
  } catch (error) {
    result.diagnostics.push({ severity: 'error', code: error.code || 'CONFIGURATION_ERROR', stage: result.stage, message: error.message, ...(error.path ? { path: error.path } : {}) });
  }
  return result;
}

/** Return persisted build status without reading the note or creating files. */
async function status(options) {
  const result = { schemaVersion: 'workshop-result.v1', command: 'status', status: 'error', stage: 'status', timestamp: timestamp(), diagnostics: [] };
  try {
    const directory = documentDirectory(options.input, options.outDir);
    result.documentDirectory = directory;
    result.lockPath = path.join(directory, '.build.lock');
    result.busy = await fs.access(result.lockPath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
    result.activeBuild = result.busy ? await optionalJson(result.lockPath).catch((error) => {
      if (error instanceof SyntaxError) return { note: 'Lock exists; metadata is not readable yet' };
      throw error;
    }) : null;
    result.lastSuccess = await optionalJson(path.join(directory, 'last-success.json'));
    result.latestAttempt = await optionalJson(path.join(directory, 'latest-attempt.json'));
    result.status = 'success';
    result.stage = 'complete';
  } catch (error) {
    result.diagnostics.push({ severity: 'error', code: 'STATUS_UNREADABLE', stage: 'status', message: error.message });
  }
  return result;
}

module.exports = { build, buildFrozen, doctor, status, documentDirectory };
