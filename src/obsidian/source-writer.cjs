/**
 * Commit one core-prepared Markdown candidate through public Obsidian write interfaces.
 * Usage: const writer = new SourceWriter({ app, MarkdownView, sourceStore });
 * Usage: await writer.apply(file, preparedTargetApplyResult);
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { sourceHash, limits } = require('../core/protocol.cjs');

/** Raise a stable host-write diagnostic without changing linked-target state. */
function writerError(code, message, partial = false) { throw Object.assign(new Error(message), { code, partial }); }

/** Decode bounded UTF-8 exactly, rejecting symlinked or aliased candidate artifacts. */
async function readCandidate(filename, expectedHash) {
  const canonical = path.resolve(filename);
  if (await fs.realpath(canonical) !== canonical) writerError('UNSAFE_CANDIDATE', 'The prepared Markdown candidate must not use symlink path components');
  const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limits.sourceBytes) writerError('UNSAFE_CANDIDATE', 'The prepared Markdown candidate is not a bounded regular file');
    const bytes = await handle.readFile();
    if (sourceHash(bytes) !== expectedHash) writerError('STALE_PREVIEW', 'The prepared Markdown candidate changed before the host write');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return writerError('INVALID_UTF8', 'The prepared Markdown candidate is not valid UTF-8'); }
  } finally { await handle.close(); }
}

/** Own compare-and-write behavior while the existing SourceStore remains read-only. */
class SourceWriter {
  /** Bind the public vault/editor interfaces and the canonical read-side source module. */
  constructor({ app, MarkdownView, sourceStore, saveTimeoutMs = 10000, pollDelayMs = 25 }) {
    this.app = app;
    this.MarkdownView = MarkdownView;
    this.sources = sourceStore;
    this.saveTimeoutMs = saveTimeoutMs;
    this.pollDelayMs = pollDelayMs;
  }

  /** Validate the small host-facing prepared-change interface. */
  preparation(file, value) {
    const canonicalPath = this.sources.canonical(file);
    if (!value || value.status !== 'success' || value.outcome !== 'ready' || value.source !== canonicalPath
      || !/^[a-f0-9]{64}$/.test(value.sourceHash || '') || !/^[a-f0-9]{64}$/.test(value.candidateHash || '')
      || typeof value.artifacts?.candidate !== 'string' || typeof value.artifacts?.permit !== 'string') writerError('INVALID_APPLY_PREPARATION', 'The host write requires one successful prepared change for this exact note');
    return { canonicalPath, sourceHash: value.sourceHash, candidateHash: value.candidateHash, candidatePath: value.artifacts.candidate, permit: value.artifacts.permit };
  }

  /** Commit through one editor transaction or a guarded saved-file vault write. */
  async apply(file, value) {
    const prepared = this.preparation(file, value);
    const candidate = await readCandidate(prepared.candidatePath, prepared.candidateHash);
    const views = this.sources.editors(file.path);
    if (views.length > 1) writerError('MULTIPLE_EDITORS', 'Close the additional views of this note before applying reviewed TeX changes');
    if (views.length === 1) return this.applyEditor(file, views[0], prepared, candidate);
    if (typeof this.app.vault.process !== 'function') writerError('VAULT_PROCESS_UNAVAILABLE', 'This Obsidian version does not expose guarded vault writes');
    let compared = false;
    await this.app.vault.process(file, current => {
      if (this.sources.editors(file.path).length) writerError('SOURCE_OPENED_DURING_APPLY', 'The note opened while the reviewed change was being committed; inspect it and request a fresh preview');
      if (sourceHash(current) !== prepared.sourceHash) writerError('STALE_PREVIEW', 'The Markdown note changed after preparation; request a fresh preview');
      compared = true;
      return candidate;
    });
    if (!compared) writerError('VAULT_WRITE_UNCONFIRMED', 'The vault did not compare the saved note before writing it');
    if (this.sources.editors(file.path).length) writerError('SOURCE_OPENED_DURING_APPLY', 'The note opened during the saved-file write; linked TeX was not acknowledged');
    const bytes = await this.app.vault.readBinary(file);
    if (sourceHash(bytes) !== prepared.candidateHash) writerError('APPLY_READBACK_CHANGED', 'The saved note does not match the reviewed candidate; linked TeX was not acknowledged');
    return Object.freeze({ status: 'success', origin: 'vault', source: prepared.canonicalPath, sourceHash: prepared.candidateHash, permit: prepared.permit });
  }

  /** Apply one whole-note editor transaction with no await between compare and edit. */
  async applyEditor(file, view, prepared, candidate) {
    const editor = view.editor;
    if (typeof editor?.getValue !== 'function' || typeof editor.offsetToPos !== 'function' || typeof editor.transaction !== 'function' || typeof view.requestSave !== 'function') writerError('EDITOR_TRANSACTION_UNAVAILABLE', 'This Obsidian editor does not expose the required transaction and save-request interfaces');
    const current = editor.getValue();
    if (file.path !== view.file?.path || this.sources.canonical(file) !== prepared.canonicalPath || sourceHash(current) !== prepared.sourceHash) writerError('STALE_PREVIEW', 'The open Markdown editor changed after preparation; request a fresh preview');
    const to = editor.offsetToPos(current.length);
    editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to, text: candidate }] }, 'md2tex-workshop');
    if (sourceHash(editor.getValue()) !== prepared.candidateHash) writerError('EDITOR_TRANSACTION_FAILED', 'The editor did not accept the complete reviewed candidate; linked TeX was not acknowledged', true);
    try { view.requestSave(); }
    catch (error) { writerError('EDITOR_SAVE_REQUEST_FAILED', `The editor contains the reviewed candidate, but Obsidian refused the save request: ${error.message}`, true); }
    const deadline = Date.now() + this.saveTimeoutMs;
    while (true) {
      if (file.path !== view.file?.path || this.sources.canonical(file) !== prepared.canonicalPath) writerError('SOURCE_MOVED_DURING_APPLY', 'The editor changed note identity before disk persistence was verified; linked TeX was not acknowledged', true);
      if (sourceHash(editor.getValue()) !== prepared.candidateHash) writerError('EDITOR_CHANGED_AFTER_APPLY', 'The editor changed after the reviewed transaction; linked TeX was not acknowledged', true);
      let bytes;
      try { bytes = await this.app.vault.readBinary(file); }
      catch (error) { writerError('APPLY_READBACK_FAILED', `The editor contains the reviewed candidate, but disk readback failed: ${error.message}`, true); }
      const diskHash = sourceHash(bytes);
      if (diskHash === prepared.candidateHash) {
        if (file.path !== view.file?.path || this.sources.canonical(file) !== prepared.canonicalPath || sourceHash(editor.getValue()) !== prepared.candidateHash) writerError('EDITOR_CHANGED_AFTER_APPLY', 'The editor changed while disk persistence was being verified; linked TeX was not acknowledged', true);
        break;
      }
      if (diskHash !== prepared.sourceHash) writerError('APPLY_READBACK_CHANGED', 'Disk content changed to neither the reviewed source nor candidate; linked TeX was not acknowledged', true);
      if (Date.now() >= deadline) writerError('EDITOR_SAVE_TIMEOUT', 'The editor contains the reviewed candidate, but Obsidian did not persist it before the verification deadline; linked TeX was not acknowledged', true);
      await new Promise(resolve => setTimeout(resolve, this.pollDelayMs));
    }
    return Object.freeze({ status: 'success', origin: 'editor', source: prepared.canonicalPath, sourceHash: prepared.candidateHash, permit: prepared.permit });
  }
}

module.exports = { SourceWriter };
