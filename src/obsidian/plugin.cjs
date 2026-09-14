/**
 * Manual Obsidian integration with injected host types and separate source/job/view modules.
 * Usage: const runtime = createRuntime(plugin, obsidianApi, { openPath }); await runtime.start();
 * No automatic compilation, AI initialization, settings migration or source apply occurs.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { SourceStore } = require('./source-store.cjs');
const { BuildController } = require('./controller.cjs');
const { BuildScheduler } = require('./scheduler.cjs');
const { sourceHash } = require('../core/protocol.cjs');
const { ToolchainClient } = require('./client.cjs');
const { createViewClass, createReviewClass } = require('./view.cjs');
const { documentDirectory } = require('../core/artifacts.cjs');
const { renderPdf } = require('./pdf-embed.cjs');

const defaults = Object.freeze({ nodeCommand: 'node', latexmkCommand: 'latexmk', outputFolder: 'md2tex-workshop-output', buildTimeoutMs: 30000, engineOverride: '', preambleOverride: '', autoBuildEnabled: false, buildDebounceMs: 600 });

/** Bind public Obsidian interfaces to the deterministic manual-build modules. */
function createRuntime(plugin, api, { openPath } = {}) {
  const sources = new SourceStore({ app: plugin.app, MarkdownView: api.MarkdownView });
  const runtime = {
    plugin, api, sources, settings: { ...defaults }, disposed: false, review: null,
    /** Resolve explicit worker/recipe settings without consulting cached note frontmatter. */
    configuration() {
      const folder = this.settings.outputFolder;
      if (typeof folder !== 'string' || !folder.trim() || path.isAbsolute(folder) || folder.split(/[\\/]/).some(part => !part || part === '..' || part === '.' || part === '.obsidian')) throw new Error('Choose a normal vault-relative output folder');
      const timeoutMs = Number(this.settings.buildTimeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('Build timeout must be between 100 and 300000 ms');
      const recipeOverrides = {};
      if (this.settings.engineOverride) recipeOverrides.engine = this.settings.engineOverride;
      if (this.settings.preambleOverride) recipeOverrides.preamble = path.resolve(sources.vaultRoot, this.settings.preambleOverride);
      return { outputRoot: path.join(sources.vaultRoot, folder), recipeOverrides,
        execution: { latexmk: this.settings.latexmkCommand, timeoutMs },
        nodeCommand: this.settings.nodeCommand, cliPath: path.resolve(__dirname, '../../scripts/workshop.cjs') };
    },
    /** Convert action errors to a notice; diagnostics remain in controller state and retained logs. */
    async perform(action) {
      try { return await action(); }
      catch (error) { if (!this.disposed) new api.Notice(error.message); return null; }
    },
    /** Choose a pinned note or the active Markdown editor before opening a workshop/PDF leaf. */
    currentFile() {
      const file = plugin.app.workspace.getActiveViewOfType(api.MarkdownView)?.file;
      return this.controller.pinned || !this.isSource(file) ? this.controller.target : file;
    },
    /** Generated snapshots/reverse candidates cannot become automatic compilation sources. */
    isSource(file) {
      return Boolean(file?.path && /\.md$/i.test(file.path) && !file.path.includes('.tex.workshop/') && !file.path.startsWith(this.settings.outputFolder + '/'));
    },
    /** Start source capture before revealing the panel; every rebuild creates a fresh core attempt. */
    async build() {
      const file = this.currentFile();
      this.controller.select(file);
      const pending = this.scheduler.request(file);
      void this.perform(() => this.openView());
      return pending;
    },
    /** Reveal a registered view without treating that view as the selected source note. */
    async openView() {
      const file = this.currentFile();
      if (file) this.controller.select(file);
      let leaf = plugin.app.workspace.getLeavesOfType('md2tex-workshop-view')[0];
      if (!leaf) {
        leaf = plugin.app.workspace.getRightLeaf(false);
        if (!leaf) throw new Error('Cannot open the workshop pane');
        await leaf.setViewState({ type: 'md2tex-workshop-view', active: true });
      }
      if (!this.disposed) await plugin.app.workspace.revealLeaf(leaf);
    },
    /** Resolve only artifacts inside the selected note's canonical output namespace. */
    artifact(kind, { successful = kind === 'pdf' } = {}) {
      const state = this.controller.state();
      const result = successful ? state.lastSuccess : kind === 'tex' && !state.latest?.artifacts?.tex ? state.lastSuccess : state.latest;
      const filename = result?.artifacts?.[kind];
      if (!filename || !state.target) throw new Error(`No ${kind} output is available`);
      const attempt = result.artifacts.attempt;
      if (!attempt) throw new Error('The output has no build-attempt provenance');
      const outputRoot = path.dirname(path.dirname(path.dirname(attempt)));
      const expected = documentDirectory(sources.canonical(state.target), outputRoot);
      const vaultRelative = path.relative(sources.vaultRoot, filename);
      if (path.dirname(path.dirname(attempt)) !== expected || vaultRelative.startsWith(`..${path.sep}`) || path.isAbsolute(vaultRelative)) throw new Error('Output provenance does not match the selected note and vault');
      const relative = path.relative(expected, filename);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Output does not belong to this note');
      return filename;
    },
    /** Open PDFs natively after indexing; open generated TeX in the user's associated editor. */
    async openArtifact(kind) {
      let filename = this.artifact(kind);
      let fallback;
      if (kind === 'tex') {
        try { fallback = this.artifact(kind, { successful: true }); }
        catch { /* A first failed attempt may have no successful predecessor. */ }
      }
      try { await fs.access(filename); }
      catch (error) {
        if (error.code !== 'ENOENT' || !fallback) throw error;
        filename = fallback;
        await fs.access(filename);
      }
      if (kind === 'tex') {
        if (!openPath) throw new Error(`Generated TeX: ${filename}`);
        const error = await openPath(filename);
        if (error) throw new Error(error);
        return;
      }
      const relative = path.relative(sources.vaultRoot, filename).split(path.sep).join('/');
      for (let attempt = 0; attempt < 20; attempt++) {
        if (this.disposed) return;
        const file = plugin.app.vault.getAbstractFileByPath(relative);
        if (file instanceof api.TFile) { await plugin.app.workspace.getLeaf('tab').openFile(file); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('The PDF exists but Obsidian has not indexed it yet. Try Open PDF again.');
    },
    /** Resolve a native PDF file only after artifact ownership and indexing checks. */
    async pdfSource() {
      const filename = this.artifact('pdf');
      const sourcePath = this.controller.target.path;
      await fs.access(filename);
      const relative = path.relative(sources.vaultRoot, filename).split(path.sep).join('/');
      for (let attempt = 0; attempt < 20 && !this.disposed; attempt++) {
        const file = plugin.app.vault.getAbstractFileByPath(relative);
        if (file instanceof api.TFile) return { sourcePath, file };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('The PDF has not been indexed by Obsidian yet');
    },
    /** Keep the version-sensitive PDF factory separate from output identity and tab policy. */
    renderPdf(source, container, owner) { return renderPdf(plugin.app, source, container, owner); },
    /** Read a bounded full compiler record on demand; never refresh it by rewriting vault files. */
    async readLog() {
      const filename = this.artifact('compilationLog');
      const handle = await fs.open(filename, 'r');
      try {
        const size = (await handle.stat()).size;
        if (size > 1024 * 1024) return `The full log is larger than 1 MiB. Open ${filename} to inspect it.`;
        const record = JSON.parse(await handle.readFile('utf8'));
        return [record.stdout, record.stderr].filter(Boolean).join('\n') || 'No process output.';
      } finally { await handle.close(); }
    },
    /** Jump only to an actual mapped Markdown source location, never an invented TeX-to-MD line. */
    async openDiagnostic() {
      const before = this.controller.state();
      if (before.target) await this.controller.freshness(this.controller.record(before.target));
      const state = this.controller.state();
      if (state.target !== before.target || state.latest !== before.latest) throw new Error('The selected build changed. Choose the diagnostic again.');
      if (!state.latestCurrent) throw new Error('The note changed or could not be checked. Rebuild before jumping to a diagnostic.');
      const item = state.latest?.diagnostics?.find(diagnostic => diagnostic.severity === 'error' && diagnostic.path && diagnostic.line);
      if (!item) throw new Error('This diagnostic has no mapped Markdown location');
      const relative = path.relative(sources.vaultRoot, item.path);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Diagnostic source: ${item.path}:${item.line}`);
      const file = plugin.app.vault.getAbstractFileByPath(relative.split(path.sep).join('/'));
      if (!(file instanceof api.TFile)) throw new Error('The diagnostic source is no longer in this vault');
      const leaf = plugin.app.workspace.getLeaf('tab');
      await leaf.openFile(file, { eState: { line: item.line - 1 } });
    },
    /** Persist an explicit automatic-build choice without rewriting unrelated settings. */
    async setAutoBuild(value) {
      this.settings.autoBuildEnabled = Boolean(value);
      this.scheduler.configure({ enabled: value });
      await this.perform(() => plugin.saveData(this.settings));
    },
    /** Set the shared sidecar through the CLI; a blank or existing unmanaged path is refused. */
    async setLinkedTarget(value) {
      const file = this.currentFile();
      if (!file || !value.trim()) throw new Error('Select a note and enter a new .tex path relative to the note');
      if (this.scheduler.running || this.scheduler.held) throw new Error('Wait for the running operation before linking TeX');
      const config = this.configuration(); const abort = new AbortController();
      this.scheduler.held = true; this.scheduler.notify();
      this.controller.background.add(abort);
      try {
        const input = sources.canonical(file);
        await new ToolchainClient(config).targetCommand('tex-target', input, { target: path.resolve(path.dirname(input), value.trim()), signal: abort.signal });
        await this.controller.refreshTarget(file);
      } finally { this.controller.background.delete(abort); this.scheduler.held = false; this.scheduler.notify(); this.scheduler.drain(); }
    },
    /** Open the named editable TeX, leaving immutable build artifacts separate. */
    async openLinked() {
      await this.controller.refreshTarget();
      const link = this.controller.state().linkedTarget;
      if (!link?.published) throw new Error('Link and build the selected note first');
      const error = await openPath(link.target); if (error) throw new Error(error);
    },
    /** Preview a saved-note round trip while queued compilation waits; this action never applies. */
    async previewLinked() {
      if (this.scheduler.running || this.scheduler.held) throw new Error('Wait for the running operation before reverse preview');
      const file = this.controller.target;
      this.scheduler.held = true; this.scheduler.notify();
      const abort = new AbortController(); this.controller.background.add(abort);
      try {
        const snapshot = await sources.capture(file);
        if (sourceHash(await fs.readFile(snapshot.canonicalPath)) !== snapshot.sha256) throw new Error('Save this note before previewing linked TeX changes');
        const config = this.configuration();
        const preview = await new ToolchainClient(config).targetCommand('tex-target-sync', snapshot.canonicalPath, { signal: abort.signal, ...config.execution });
        if ((await sources.capture(file)).sha256 !== snapshot.sha256) throw new Error('The note changed during preview; request a fresh preview');
        const relative = path.relative(sources.vaultRoot, preview.artifacts.candidate).split(path.sep).join('/');
        if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`Preview prepared outside the vault: ${preview.artifacts.candidate}`);
        const candidate = await fs.readFile(preview.artifacts.candidate);
        if (sourceHash(candidate) !== preview.candidateHash) throw new Error('The candidate changed before review; request a fresh preview');
        if (candidate.length > 2 * 1024 * 1024) throw new Error(`Preview exceeds the native review limit; inspect the CLI report: ${preview.artifacts.report}`);
        if (this.disposed) throw new Error('Workshop unloaded before review');
        this.review = Object.freeze({ source: file.path, report: preview.artifacts.report, current: snapshot.text, candidate: candidate.toString('utf8') });
        await plugin.app.workspace.getLeaf('tab').setViewState({ type: 'md2tex-workshop-review', active: true });
        return preview;
      } finally { this.controller.background.delete(abort); this.scheduler.held = false; this.scheduler.notify(); this.scheduler.drain(); }
    },
    /** Register manual commands and passive freshness tracking; load existing settings without saving. */
    async start() {
      const saved = await plugin.loadData();
      if (this.disposed) return;
      this.settings = { ...defaults, ...(saved || {}) };
      this.scheduler.configure({ enabled: this.settings.autoBuildEnabled === true, delayMs: Number(this.settings.buildDebounceMs) });
      const View = createViewClass(api, this);
      plugin.registerView('md2tex-workshop-view', leaf => new View(leaf));
      const Review = createReviewClass(api);
      plugin.registerView('md2tex-workshop-review', leaf => new Review(leaf, this.review));
      const actions = [
        ['open-md2tex-workshop', 'Open md2tex Workshop', () => this.openView()],
        ['compile-current-note-to-pdf', 'Compile Selected Note to PDF', () => this.build()],
        ['clean-rebuild-current-note-to-pdf', 'Rebuild Selected Note in a Fresh Attempt', () => this.build()],
        ['cancel-workshop-build', 'Cancel Workshop Build and Queue', () => this.scheduler.cancel()],
        ['open-linked-tex', 'Open Linked TeX Target', () => this.openLinked()],
        ['preview-linked-tex', 'Preview Linked TeX Changes as Markdown', () => this.previewLinked()],
        ['reveal-compiled-pdf', 'Open Rendered PDF Tab', () => this.openArtifact('pdf')],
        ['open-generated-tex', 'Open Generated TeX', () => this.openArtifact('tex')],
        ['ask-agent-to-fix-compile-error', 'Explain Compilation Assistance Availability', () => { new api.Notice('AI assistance is off. Compilation diagnostics are available in the Workshop.'); }],
      ];
      for (const [id, name, action] of actions) plugin.addCommand({ id, name, callback: () => this.perform(action) });
      plugin.addRibbonIcon('file-code', 'Open md2tex Workshop', () => this.perform(() => this.openView()));
      plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', leaf => {
        if (leaf?.view instanceof api.MarkdownView && this.isSource(leaf.view.file)) {
          this.controller.select(leaf.view.file);
          this.scheduler.selected();
          void this.controller.refreshTarget();
          if (plugin.app.workspace.getLeavesOfType('md2tex-workshop-view').length) void this.perform(() => this.controller.inspect());
        }
      }));
      plugin.registerEvent(plugin.app.workspace.on('editor-change', (_editor, view) => { if (view?.file) { this.controller.invalidate(view.file); this.scheduler.changed(view.file); } }));
      for (const event of ['create', 'modify', 'rename', 'delete']) plugin.registerEvent(plugin.app.vault.on(event, (file, oldPath) => {
        if (/\.md$/i.test(file?.path || '')) {
          this.controller.invalidate(file);
          if (event === 'modify') this.scheduler.changed(file);
          if (event === 'rename' || event === 'delete') this.scheduler.forget(file, oldPath);
        }
        const selected = this.controller.target;
        if (selected && (file?.path === selected.path + '.workshop.json' || file?.path?.endsWith('.tex'))) void this.controller.refreshTarget(selected);
      }));
      const active = this.currentFile();
      if (active) this.controller.select(active);
      plugin.addSettingTab(new (settingsClass(api, this))(plugin.app, plugin));
    },
    /** Prevent new work and suppress late UI updates while clients finish bounded shutdown. */
    dispose() { this.disposed = true; this.controller.dispose(); this.scheduler.dispose(); },
  };
  runtime.controller = new BuildController({ sourceStore: sources, configuration: () => runtime.configuration(), createClient: config => new ToolchainClient(config) });
  runtime.scheduler = new BuildScheduler(runtime.controller);
  return runtime;
}

/** Build a settings view whose changes are explicit user actions and preserve unrelated keys. */
function settingsClass(api, runtime) {
  /** Show only settings supported by the manual integration. */
  return class WorkshopSettings extends api.PluginSettingTab {
    /** Render tool locations and document defaults; YAML takes priority over these defaults. */
    display() {
      this.containerEl.empty();
      new api.Setting(this.containerEl).setName('Build selected note automatically').setDesc('Debounce editor/saved changes; manual requests remain queued. AI stays off.').addToggle(toggle => toggle.setValue(runtime.settings.autoBuildEnabled === true).onChange(value => runtime.setAutoBuild(value)));
      for (const [key, name, description] of [
        ['nodeCommand', 'Node executable', 'Use node or an absolute path to standalone Node.'],
        ['latexmkCommand', 'latexmk executable', 'Use latexmk or an absolute executable path.'],
        ['outputFolder', 'Build output folder', 'A normal folder inside this vault.'],
        ['buildTimeoutMs', 'Compilation timeout (ms)', '100 to 300000 milliseconds.'],
        ['preambleOverride', 'Default preamble', 'Optional absolute or vault-relative path, used when YAML omits tex-workshop-preamble. Leave empty for the basic article default.'],
      ]) new api.Setting(this.containerEl).setName(name).setDesc(description).addText(text => text.setValue(String(runtime.settings[key])).onChange(value => {
        const prior = runtime.settings[key];
        runtime.settings[key] = key === 'buildTimeoutMs' ? Number(value) : value;
        try { runtime.configuration(); }
        catch (error) { runtime.settings[key] = prior; new api.Notice(error.message); return; }
        void runtime.perform(() => runtime.plugin.saveData(runtime.settings));
      }));
      new api.Setting(this.containerEl).setName('Default engine').setDesc('Used when YAML omits tex-workshop-engine. Note metadata always takes priority.').addDropdown(dropdown => {
        for (const [value, label] of [['', 'From note/default'], ['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX']]) dropdown.addOption(value, label);
        dropdown.setValue(runtime.settings.engineOverride).onChange(value => { runtime.settings.engineOverride = value; void runtime.perform(() => runtime.plugin.saveData(runtime.settings)); });
      });
    }
  };
}

module.exports = { createRuntime, defaults };
