/**
 * Read exact editor/saved snapshots using public Obsidian interfaces, without saving notes.
 * Usage: const snapshot = await new SourceStore({ app, MarkdownView }).capture(file);
 */
const path = require('node:path');
const { sourceHash, limits } = require('../core/protocol.cjs');

/** Reject a source ambiguity with a user-facing diagnostic. */
function sourceError(code, message) { throw Object.assign(new Error(message), { code }); }

/** Own the distinction between open editors and saved UTF-8 files. */
class SourceStore {
  /** Bind the host interfaces; the source store never receives a write or AI capability. */
  constructor({ app, MarkdownView }) {
    this.app = app;
    this.MarkdownView = MarkdownView;
    if (typeof app.vault.adapter.getBasePath !== 'function') sourceError('DESKTOP_REQUIRED', 'The workshop requires a local desktop vault');
    this.vaultRoot = path.resolve(app.vault.adapter.getBasePath());
  }

  /** Resolve a Markdown file's logical canonical path inside this vault. */
  canonical(file) {
    if (!file || typeof file.path !== 'string' || !/\.md$/i.test(file.path)) sourceError('MARKDOWN_REQUIRED', 'Select a Markdown note');
    const canonical = path.resolve(this.vaultRoot, file.path);
    const relative = path.relative(this.vaultRoot, canonical);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) sourceError('SOURCE_OUTSIDE_VAULT', 'The selected note is outside this vault');
    return canonical;
  }

  /** Inspect every editing view of a note, including inactive and pinned views. */
  editors(filePath) {
    return this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
      .filter(view => view instanceof this.MarkdownView && view.file?.path === filePath && view.editor);
  }

  /** Create an exact immutable UTF-8 snapshot after checking size and text fidelity. */
  snapshot(canonicalPath, text, origin) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > limits.sourceBytes) sourceError('SOURCE_LIMIT', 'The note exceeds the supported snapshot size');
    if (text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text) sourceError('INVALID_UNICODE', 'The note contains text that cannot be preserved as UTF-8');
    const sha256 = sourceHash(text);
    return Object.freeze({ canonicalPath, text, origin, sha256, editorRevision: origin === 'editor' ? sha256 : null });
  }

  /** Capture agreeing editors synchronously; differing buffers require a human choice. */
  editorSnapshot(canonicalPath, views) {
    const texts = views.map(view => view.editor.getValue());
    if (texts.some(text => text !== texts[0])) sourceError('CONFLICTING_EDITORS', 'Open views of this note contain different text; resolve them before compiling');
    return this.snapshot(canonicalPath, texts[0], 'editor');
  }

  /** Capture once before focus changes; a note opened during a disk read uses its editor. */
  async capture(file) {
    const canonicalPath = this.canonical(file);
    const filePath = file.path;
    const views = this.editors(filePath);
    if (views.length) return this.editorSnapshot(canonicalPath, views);
    let text;
    try {
      const bytes = await this.app.vault.readBinary(file);
      if (bytes.byteLength > limits.sourceBytes) sourceError('SOURCE_LIMIT', 'The note exceeds the supported snapshot size');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) sourceError('INVALID_UTF8', 'The saved note is not valid UTF-8');
      throw error;
    }
    if (file.path !== filePath) sourceError('SOURCE_MOVED', 'The note moved while its source was being captured');
    const opened = this.editors(filePath);
    return opened.length ? this.editorSnapshot(canonicalPath, opened) : this.snapshot(canonicalPath, text, 'disk');
  }
}

module.exports = { SourceStore };
