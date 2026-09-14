/**
 * Versioned host/worker and repair data contracts; no I/O, compiler or AI dispatch.
 * Usage: const request = validateBuildRequest(JSON.parse(requestText));
 * Usage: const proposal = validateRepairProposal(providerOutput, verifiedContext);
 * These validators do not implement worker execution or authorize source edits.
 */
const path = require('node:path');
const { createHash } = require('node:crypto');

const protocolVersion = 'workshop-worker.v1';
const limits = Object.freeze({ sourceBytes: 1024 * 1024, requestBytes: 2 * 1024 * 1024, contextBytes: 48 * 1024, proposalBytes: 16 * 1024, regionBytes: 8192, regions: 8, edits: 4, changedBytes: 4096 });
const identityKeys = ['protocolVersion', 'jobId', 'documentId', 'sourceHash'];
const failureKeys = [...identityKeys, 'failureId', 'resolvedRecipeHash', 'toolchainFingerprint'];

/** Raise a stable diagnostic for invalid, oversized or mismatched protocol input. */
function invalid(message, code = 'INVALID_PROTOCOL') { throw Object.assign(new Error(message), { code }); }

/** Hash UTF-8 source text without normalizing newlines, BOM or mathematical content. */
function sourceHash(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Validate a plain object and its exact required/optional field names. */
function object(value, required, optional = [], label = 'record') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) invalid(`Unknown field: ${label}.${key}`);
}

/** Require bounded text; source and exact patch text are allowed to contain line breaks. */
function string(value, label, maxBytes = 512, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) invalid(`${label} must be bounded text without NUL`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) invalid(`${label} contains malformed Unicode`, 'INVALID_UNICODE');
}

/** Require an explicit normalized absolute path, independent of worker working directory. */
function absolute(value, label) {
  string(value, label, 4096);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) invalid(`${label} must be a normalized absolute path`);
}

/** Require an identifier safe for filenames and log correlation, never a source path. */
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) invalid(`${label} must be a bounded opaque identifier`);
}

/** Require a lowercase SHA-256 digest, with null allowed only for unresolved recipes. */
function sha(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(`${label} must be a SHA-256 digest`);
}

/** Check the complete wire size and copy JSON data so callers cannot change a validated object. */
function copied(value, maxBytes) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { invalid('Protocol input must be JSON data'); }
  if (!serialized || Buffer.byteLength(serialized) > maxBytes) invalid('Protocol payload exceeds its byte limit', 'PROTOCOL_LIMIT');
  return JSON.parse(serialized);
}

/** Freeze nested JSON records, preserving the revision accepted by a validator. */
function immutable(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

/** Bind a canonical logical source path to a stable identity; no scratch filename participates. */
function documentId(canonicalPath) {
  absolute(canonicalPath, 'canonicalPath');
  return sourceHash(canonicalPath);
}

/** Validate common immutable identity fields and optionally compare a captured owner. */
function identity(value, expected, keys = identityKeys) {
  if (value.protocolVersion !== protocolVersion) invalid('Unsupported worker protocol version', 'PROTOCOL_VERSION_MISMATCH');
  identifier(value.jobId, 'jobId');
  sha(value.documentId, 'documentId');
  sha(value.sourceHash, 'sourceHash');
  if (expected) for (const key of keys) if (value[key] !== expected[key]) invalid(`Mismatched ${key}`, 'PROTOCOL_OWNER_MISMATCH');
}

/** Validate the proposed immutable editor/saved-source build envelope, without reading disk. */
function validateBuildRequest(raw) {
  const value = copied(raw, limits.requestBytes);
  object(value, ['protocolVersion', 'kind', 'jobId', 'documentId', 'source', 'vaultRoot', 'outputRoot', 'recipeOverrides', 'execution']);
  if (value.kind !== 'build') invalid('Expected a build request');
  object(value.source, ['canonicalPath', 'origin', 'text', 'sha256', 'editorRevision'], [], 'source');
  absolute(value.source.canonicalPath, 'source.canonicalPath');
  string(value.source.text, 'source.text', limits.sourceBytes, true);
  sha(value.source.sha256, 'source.sha256');
  if (sourceHash(value.source.text) !== value.source.sha256) invalid('Captured source hash differs from text', 'SOURCE_HASH_MISMATCH');
  if (documentId(value.source.canonicalPath) !== value.documentId) invalid('Document identity differs from canonical source path', 'PROTOCOL_OWNER_MISMATCH');
  if (!['editor', 'disk'].includes(value.source.origin)) invalid('source.origin must be editor or disk');
  if (value.source.origin === 'editor') string(value.source.editorRevision, 'source.editorRevision', 128);
  else if (value.source.editorRevision !== null) invalid('Disk snapshots use editorRevision: null');
  identity({ ...value, sourceHash: value.source.sha256 });
  absolute(value.vaultRoot, 'vaultRoot');
  absolute(value.outputRoot, 'outputRoot');
  object(value.recipeOverrides, [], ['preamble', 'engine', 'bib', 'support', 'noBib', 'bibliography'], 'recipeOverrides');
  const recipe = value.recipeOverrides;
  if (recipe.preamble !== undefined) absolute(recipe.preamble, 'recipeOverrides.preamble');
  if (recipe.engine !== undefined && !['pdflatex', 'xelatex', 'lualatex'].includes(recipe.engine)) invalid('Unsupported TeX engine');
  if (recipe.bibliography !== undefined && !['none', 'bibtex', 'biblatex'].includes(recipe.bibliography)) invalid('Unsupported bibliography mode');
  if (recipe.noBib !== undefined && typeof recipe.noBib !== 'boolean') invalid('noBib must be boolean');
  if (recipe.noBib && recipe.bib !== undefined) invalid('bib and noBib are mutually exclusive');
  for (const key of ['bib', 'support']) if (recipe[key] !== undefined) {
    if (!Array.isArray(recipe[key]) || recipe[key].length > 64) invalid(`${key} must be a bounded path array`);
    for (const filename of recipe[key]) absolute(filename, key);
  }
  object(value.execution, ['latexmk', 'timeoutMs'], [], 'execution');
  string(value.execution.latexmk, 'execution.latexmk', 4096);
  if (!Number.isInteger(value.execution.timeoutMs) || value.execution.timeoutMs < 100 || value.execution.timeoutMs > 300000) invalid('timeoutMs must be an integer between 100 and 300000');
  return immutable(value);
}

/** Validate monotonic progress data for a captured request; a controller tracks sequence ordering. */
function validateBuildEvent(raw, request) {
  const value = copied(raw, 8192);
  object(value, [...identityKeys, 'kind', 'sequence', 'stage']);
  const owner = validateBuildRequest(request);
  identity(value, { ...owner, sourceHash: owner.source.sha256 });
  if (value.kind !== 'progress' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) invalid('Invalid progress kind or sequence');
  if (!['configuration', 'preparation', 'preflight', 'conversion', 'assembly', 'compilation', 'validation', 'publication', 'complete', 'cleanup'].includes(value.stage)) invalid('Unknown progress stage');
  return immutable(value);
}

/** Validate a core build-result envelope against its captured request, not the selected note. */
function validateBuildResult(raw, request) {
  const value = copied(raw, 4 * 1024 * 1024);
  object(value, [...identityKeys, 'kind', 'resolvedRecipeHash', 'toolchainFingerprint', 'result'], ['lastSuccessfulResult']);
  const owner = validateBuildRequest(request);
  identity(value, { ...owner, sourceHash: owner.source.sha256 });
  sha(value.resolvedRecipeHash, 'resolvedRecipeHash', true);
  sha(value.toolchainFingerprint, 'toolchainFingerprint');
  if (value.kind !== 'result' || value.result?.schemaVersion !== 'workshop-result.v1' || value.result.command !== 'build'
    || !['success', 'error'].includes(value.result.status) || !Array.isArray(value.result.diagnostics)) invalid('Expected a core build result');
  if (value.result.status === 'success' && value.resolvedRecipeHash === null) invalid('Successful results require a resolved recipe hash');
  if (value.result.status === 'success' && !value.result.source) invalid('Successful results require captured source provenance');
  if (value.result.source && (value.result.source.path !== owner.source.canonicalPath || value.result.source.sha256 !== owner.source.sha256)) invalid('Core result source differs from request', 'PROTOCOL_OWNER_MISMATCH');
  if (value.lastSuccessfulResult != null) {
    const previous = value.lastSuccessfulResult;
    if (previous.status !== 'success' || previous.source?.path !== owner.source.canonicalPath) invalid('Previous success belongs to another source', 'PROTOCOL_OWNER_MISMATCH');
    sha(previous.source.sha256, 'lastSuccessfulResult.source.sha256');
  }
  return immutable(value);
}

/** Validate a bounded failure context; region selection and diagnostic classification belong to A0. */
function validateRepairContext(raw) {
  const value = copied(raw, limits.contextBytes);
  object(value, [...failureKeys, 'kind', 'capability', 'diagnostic', 'regions', 'rule', 'promptVersion']);
  identity(value);
  identifier(value.failureId, 'failureId');
  sha(value.resolvedRecipeHash, 'resolvedRecipeHash');
  sha(value.toolchainFingerprint, 'toolchainFingerprint');
  if (value.kind !== 'repair-context' || value.capability !== 'compile.syntax-repair') invalid('Unsupported repair capability');
  string(value.promptVersion, 'promptVersion', 96);
  object(value.diagnostic, ['code', 'message'], [], 'diagnostic');
  string(value.diagnostic.code, 'diagnostic.code', 96);
  string(value.diagnostic.message, 'diagnostic.message', 2048);
  object(value.rule, ['id', 'version', 'text'], [], 'rule');
  for (const field of ['id', 'version']) string(value.rule[field], `rule.${field}`, 96);
  string(value.rule.text, 'rule.text', 8192);
  if (!Array.isArray(value.regions) || !value.regions.length || value.regions.length > limits.regions) invalid('Expected bounded repair regions');
  const ids = new Set();
  for (const region of value.regions) {
    object(region, ['id', 'text'], [], 'region');
    identifier(region.id, 'region.id');
    string(region.text, 'region.text', limits.regionBytes);
    if (ids.has(region.id)) invalid('Duplicate repair region ID');
    ids.add(region.id);
  }
  return immutable(value);
}

/** Validate an untrusted proposal's identity and exact allowed region; never apply it. */
function validateRepairProposal(raw, context) {
  const value = copied(raw, limits.proposalBytes);
  const owner = validateRepairContext(context);
  object(value, [...failureKeys, 'kind', 'capability', 'outcome', 'edits', 'explanation']);
  identity(value, owner, failureKeys);
  if (value.kind !== 'repair-proposal' || value.capability !== owner.capability) invalid('Unsupported repair proposal');
  if (!['candidate', 'no-fix', 'needs-human'].includes(value.outcome)) invalid('Unknown repair outcome');
  string(value.explanation, 'explanation', 2048);
  if (!Array.isArray(value.edits) || value.edits.length > limits.edits || (value.outcome === 'candidate' ? !value.edits.length : value.edits.length !== 0)) invalid('Outcome and edit count disagree');
  const changed = new Set();
  let bytes = 0;
  for (const edit of value.edits) {
    object(edit, ['regionId', 'before', 'after'], [], 'edit');
    const region = owner.regions.find(item => item.id === edit.regionId);
    if (!region || changed.has(edit.regionId)) invalid('Unknown or repeated repair region');
    string(edit.before, 'edit.before', limits.changedBytes);
    string(edit.after, 'edit.after', limits.changedBytes, true);
    const index = region.text.indexOf(edit.before);
    if (index < 0 || region.text.indexOf(edit.before, index + 1) >= 0 || edit.before === edit.after) invalid('Edit must change one exact unambiguous match');
    bytes += Buffer.byteLength(edit.before) + Buffer.byteLength(edit.after);
    if (bytes > limits.changedBytes) invalid('Proposed edit exceeds the change budget', 'PROTOCOL_LIMIT');
    changed.add(edit.regionId);
  }
  return immutable(value);
}

module.exports = { protocolVersion, limits, sourceHash, documentId, validateBuildRequest, validateBuildEvent, validateBuildResult, validateRepairContext, validateRepairProposal };
