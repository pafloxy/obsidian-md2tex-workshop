/**
 * Load the packaged entry against a public-API host double and run a real manual build.
 * Usage from root: node --test --test-isolation=none testing/obsidian-host.test.cjs
 * This does not run Obsidian, simulate native rendering, or contact a provider.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stagePackage } = require('../scripts/lib/plugin-package.cjs');
const { execute } = require('./execute.cjs');
const { createRuntime } = require('../src/obsidian/plugin.cjs');
const { sourceHash } = require('../src/core/protocol.cjs');
const root = path.resolve(__dirname, '..');

/** Store only the DOM operations used by the presentation module. */
class Element {
  /** Track element identity and mounting so rebuilds cannot silently recreate the pane. */
  constructor() { this.children = []; this.dataset = {}; this.emptyCount = 0; this.events = {}; this.text = ''; }
  /** Remove only this test element's child list. */
  empty() { this.children = []; this.emptyCount++; }
  /** Accept host styling without making a renderer claim. */
  addClass() {}
  /** Create and retain a test child. */
  createEl(tag, options = {}) { const child = new Element(); child.tag = tag; child.text = options.text || ''; this.children.push(child); return child; }
  /** Create a div using the same host signature. */
  createDiv(options) { return this.createEl('div', options); }
  /** Update text as text, without executing Markdown or HTML. */
  setText(text) { this.text = text; }
  /** Keep user actions available to an explicit test invocation. */
  addEventListener(name, callback) { this.events[name] = callback; }
  /** Record native accessibility attributes. */
  setAttribute(name, value) { this[name] = value; }
}

/** Model public event registration without starting any background activity. */
class Events {
  /** Keep listeners by the public event name. */
  constructor() { this.events = new Map(); }
  /** Return a removable event reference as Obsidian registerEvent expects. */
  on(name, callback) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(callback); return { remove: () => this.events.get(name).delete(callback) }; }
  /** Deliver a controlled editor/vault event. */
  emit(name, ...args) { for (const callback of this.events.get(name) || []) callback(...args); }
}

/** Build inert host interfaces around an isolated real vault directory. */
function host(vaultRoot, saved) {
  const notices = []; const opened = []; const external = []; const leaves = []; const embeds = [];
  /** Model the native renderer's parent-owned lifecycle. */
  class Component {
    /** Keep independently owned children. */
    constructor() { this.children = new Set(); }
    /** Attach a renderer owned by this view. */
    addChild(child) { this.children.add(child); return child; }
    /** Release only the replaced renderer. */
    removeChild(child) { this.children.delete(child); child.unload(); }
    /** Release all render children when the view closes. */
    unload() { for (const child of this.children) child.unload(); this.children.clear(); }
  }
  /** Represent the host's file type. */
  class TFile { /** Bind a vault-relative path. */ constructor(filename) { this.path = filename; } }
  /** Represent a public Markdown view with a mutable editor. */
  class MarkdownView { /** Bind exact editor text independently of disk. */ constructor(file, text) { this.file = file; this.text = text; this.editor = { getValue: () => this.text }; } }
  /** Supply the public ItemView content element. */
  class ItemView extends Component { /** Bind a leaf and stable content. */ constructor(leaf) { super(); this.leaf = leaf; this.contentEl = new Element(); } }
  /** Capture notices for assertions instead of showing native UI. */
  class Notice { /** Record the visible message. */ constructor(message) { notices.push(message); } }
  /** Supply the settings tab base without writing settings. */
  class PluginSettingTab { /** Keep the public container. */ constructor() { this.containerEl = new Element(); } }
  const vault = new Events();
  vault.adapter = { getBasePath: () => vaultRoot };
  vault.readBinary = file => fs.readFile(path.join(vaultRoot, file.path));
  vault.getAbstractFileByPath = filename => fsSync.existsSync(path.join(vaultRoot, filename)) ? new TFile(filename) : null;
  const workspace = new Events();
  workspace.getLeavesOfType = type => leaves.filter(leaf => type === 'markdown' ? leaf.view instanceof MarkdownView : leaf.view?.getViewType?.() === type);
  workspace.getActiveViewOfType = Type => workspace.active?.view instanceof Type ? workspace.active.view : null;
  workspace.revealLeaf = leaf => { workspace.active = leaf; };
  workspace.getLeaf = type => ({
    /** Record explicit native file-opening requests. */
    async openFile(file, options) { opened.push({ type, file, options }); workspace.active = null; },
    /** Mount a registered read-only view through the same native leaf interface. */
    async setViewState(state) { this.view = plugin.views.get(state.type)(this); leaves.push(this); workspace.active = this; await this.view.onOpen(); },
  });
  let plugin;
  workspace.getRightLeaf = () => {
    const leaf = {
      /** Instantiate the registered view through the public factory. */
      async setViewState(state) { this.view = plugin.views.get(state.type)(this); leaves.push(this); await this.view.onOpen(); },
    };
    return leaf;
  };
  const app = { vault, workspace, embedRegistry: {
    /** Model the native factory while keeping actual PDF rendering a separate live check. */
    getEmbedCreator() {
      return (context, file, subpath) => {
        const component = new Component();
        /** Record the native interactive-file request. */
        component.loadFile = async () => { embeds.push({ context, file, subpath, element: context.containerEl, component }); };
        return component;
      };
    },
  } };
  Object.defineProperty(app, 'plugins', { get() { throw new Error('Provider/plugin discovery must remain unreachable'); } });
  /** Store host registrations while delegating unload cleanup to public lifecycle behavior. */
  class Plugin {
    /** Keep only injected host state and recorded registrations. */
    constructor() { plugin = this; this.app = app; this.manifest = { dir: '.obsidian/plugins/md2tex-workshop' }; this.commands = new Map(); this.views = new Map(); this.events = []; this.saves = 0; }
    /** Read the fixture's legacy settings once. */
    async loadData() { return saved; }
    /** Count writes; the manual runtime must not migrate settings during load. */
    async saveData() { this.saves++; }
    /** Preserve registered view factories. */
    registerView(type, factory) { this.views.set(type, factory); }
    /** Preserve existing command identifiers for explicit invocation. */
    addCommand(command) { this.commands.set(command.id, command); }
    /** Capture a ribbon registration without clicking it. */
    addRibbonIcon() {}
    /** Retain event references for host-managed unload cleanup. */
    registerEvent(reference) { this.events.push(reference); }
    /** Keep the settings tab available without opening it. */
    addSettingTab(tab) { this.tab = tab; }
  }
  return { app, api: { Plugin, TFile, MarkdownView, ItemView, Notice, PluginSettingTab, Component }, notices, opened, external, leaves, embeds };
}

/** Wait for an asynchronous view to finish mounting without arbitrary long sleeps. */
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Host fixture did not reach its expected state');
}

test('reloading the packaged entry refreshes only its companion module cache', async () => {
  const vaultRoot = await fs.mkdtemp(path.join(root, 'tmp/reload host-'));
  const packageRoot = path.join(vaultRoot, '.obsidian/plugins/md2tex-workshop');
  await stagePackage({ sourceRoot: root, output: packageRoot });
  const value = host(vaultRoot, {});
  const entry = path.join(packageRoot, 'main.js');
  const context = { module: { exports: {} },
    /** Route host types while retaining Node's actual shared module cache. */
    require(name) { return name === 'obsidian' ? value.api : require(name); },
  };
  const unrelated = require.cache[require.resolve('../src/obsidian/plugin.cjs')];
  vm.runInNewContext(await fs.readFile(entry, 'utf8'), context, { filename: entry });
  const first = new context.module.exports(); await first.onload(); first.onunload();
  await fs.appendFile(path.join(packageRoot, 'toolchain/src/obsidian/scheduler.cjs'), `
    /** Mark the replacement package's scheduler for the reload regression. */
    module.exports.BuildScheduler = class extends module.exports.BuildScheduler {
      /** Preserve scheduler behavior and identify this updated fixture module. */
      constructor(...args) { super(...args); this.reloadedFixture = true; }
    };
  `);
  const second = new context.module.exports();
  try {
    await second.onload();
    assert.equal(second.runtime.scheduler.reloadedFixture, true);
    assert.equal(require.cache[require.resolve('../src/obsidian/plugin.cjs')], unrelated);
    assert.equal(second.saves, 0);
  } finally { second.onunload(); }
});

test('relocated packaged entry builds the pinned editor snapshot with AI off and stable view ownership', async t => {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/manual host-'));
  const initialVault = path.join(dir, 'vault');
  await stagePackage({ sourceRoot: root, output: path.join(initialVault, '.obsidian/plugins/md2tex-workshop') });
  const vaultRoot = path.join(dir, 'relocated vault');
  await fs.rename(initialVault, vaultRoot);
  const legacy = { nodeCommand: process.execPath, autoCompile: true, autoAskAgent: true, unrelated: { keep: 'exactly' } };
  const value = host(vaultRoot, legacy);
  const file = new value.api.TFile('draft.md');
  const source = '# Editor draft\n\n> [!lemma] Editor title\n> <!-- [label{lem:editor}] -->\n>\n> The editor contains a nonnegative square.\n\nSee [ref{lem:editor}].\n';
  await fs.writeFile(path.join(vaultRoot, file.path), '# Earlier saved draft\n');
  const editor = new value.api.MarkdownView(file, source);
  value.leaves.push({ view: editor });
  value.app.workspace.active = value.leaves[0];
  const entry = path.join(vaultRoot, '.obsidian/plugins/md2tex-workshop/main.js');
  const context = { module: { exports: {} },
    /** Inject only Obsidian and explicit external-open behavior; companion modules load normally. */
    require(name) { if (name === 'obsidian') return value.api; if (name === 'electron') return { shell: { openPath: async filename => { value.external.push(filename); return ''; } } }; return require(name); },
  };
  vm.runInNewContext(await fs.readFile(entry, 'utf8'), context, { filename: entry });
  const plugin = new context.module.exports();
  t.after(() => { plugin.onunload(); for (const event of plugin.events) event.remove(); });
  await plugin.onload();
  assert.equal(plugin.saves, 0);
  assert.deepEqual(plugin.runtime.settings.unrelated, legacy.unrelated);
  assert.equal(plugin.runtime.controller.state().busy, false);
  await assert.rejects(() => fs.access(path.join(vaultRoot, 'md2tex-workshop-output')), { code: 'ENOENT' });
  await plugin.commands.get('ask-agent-to-fix-compile-error').callback();
  assert.match(value.notices.pop(), /AI assistance is off/);
  await plugin.commands.get('open-md2tex-workshop').callback();
  const view = value.app.workspace.getLeavesOfType('md2tex-workshop-view')[0].view;
  await until(() => view.unsubscribe);
  plugin.runtime.controller.togglePin();
  const other = new value.api.MarkdownView(new value.api.TFile('other.md'), '# Other note');
  value.app.workspace.active = { view: other };
  value.app.workspace.emit('active-leaf-change', value.app.workspace.active);
  const pending = plugin.commands.get('compile-current-note-to-pdf').callback();
  assert.equal(plugin.runtime.controller.state().runningTarget, 'draft.md');
  const frame = await pending;
  assert.equal(frame?.result.status, 'success', JSON.stringify(value.notices));
  assert.deepEqual(frame.result.diagnostics, []);
  assert.equal(await fs.readFile(frame.result.artifacts.source, 'utf8'), source);
  assert.equal(await fs.readFile(path.join(vaultRoot, file.path), 'utf8'), '# Earlier saved draft\n');
  assert.equal(view.contentEl.emptyCount, 1);
  assert.equal(plugin.runtime.controller.state().current, true);
  await until(() => view.output.pdfStatus === 'ready');
  assert.match(value.embeds[0].file.path, /main\.pdf$/);
  assert.equal(value.embeds[0].context.sourcePath, 'draft.md');
  assert.equal(value.embeds[0].context.displayMode, false);
  const renderedPdf = value.embeds[0].element;
  view.output.select('log'); await until(() => view.output.logStatus === 'ready');
  assert.match(view.output.logPanel.text, /Latexmk/);
  view.output.select('pdf'); assert.equal(value.embeds[0].element, renderedPdf);
  assert.equal(value.embeds.length, 1);
  const body = await fs.readFile(frame.result.artifacts.body, 'utf8');
  assert.match(body, /\\label\{lem:editor\}/);
  assert.match(body, /\\cref\{lem:editor\}/);
  const text = await execute('pdftotext', [frame.result.artifacts.pdf, '-'], { cwd: root });
  assert.match(text.stdout, /Editor title/);
  assert.match(text.stdout, /See Lemma 1\.1/);
  assert.equal(value.external.length, 0);
  await plugin.commands.get('reveal-compiled-pdf').callback();
  assert.equal(value.opened.at(-1).type, 'tab');
  assert.equal(path.join(vaultRoot, value.opened.at(-1).file.path), frame.result.artifacts.pdf);
  await plugin.commands.get('open-generated-tex').callback();
  assert.deepEqual(value.external, [frame.result.artifacts.tex]);
  // Changing settings cannot reassign already-published artifacts to a different namespace.
  plugin.runtime.settings.outputFolder = 'new-output';
  assert.equal(plugin.runtime.artifact('pdf'), frame.result.artifacts.pdf);
  plugin.runtime.settings.outputFolder = 'md2tex-workshop-output';
  editor.text += '\nSee [ref{missing}].\n';
  value.app.workspace.emit('editor-change', editor.editor, editor);
  assert.equal(plugin.runtime.controller.state().busy, false);
  assert.equal(plugin.runtime.controller.state().current, false);
  const failed = await plugin.commands.get('clean-rebuild-current-note-to-pdf').callback();
  assert.equal(failed.result.status, 'error');
  assert.equal(plugin.runtime.artifact('pdf'), frame.result.artifacts.pdf);
  assert.match(view.diagnosticEl.text, /UNRESOLVED_REFERENCE/);
  await plugin.commands.get('open-generated-tex').callback();
  assert.equal(value.external.at(-1), frame.result.artifacts.tex, 'a preflight failure has no generated TeX, so retain access to the last good TeX');
  assert.equal(view.sourceButton.disabled, false);
  await plugin.runtime.openDiagnostic();
  assert.equal(value.opened.at(-1).file.path, 'draft.md');
  assert.equal(value.opened.at(-1).options.eState.line, 9);
  editor.text = '# Changed again\n';
  value.app.workspace.emit('editor-change', editor.editor, editor);
  assert.match(view.diagnosticEl.text, /earlier or unchecked revision/);
  await assert.rejects(() => plugin.runtime.openDiagnostic(), /Rebuild/);
  assert.equal(view.contentEl.emptyCount, 1);
  assert.equal(plugin.saves, 0);
  assert.deepEqual(legacy.unrelated, { keep: 'exactly' });
  await view.onClose();
  const previous = view.statusEl.text;
  plugin.onunload();
  value.app.workspace.emit('editor-change', editor.editor, editor);
  assert.equal(view.statusEl.text, previous);
  await fs.writeFile(path.join(dir, 'validation.json'), JSON.stringify({ package: path.dirname(entry), success: frame.result, failure: failed.result,
    checks: ['relocated entry', 'captured pinned editor', 'source unchanged', 'real PDF text and references', 'last-good PDF', 'native-open requests', 'stale diagnostics refused', 'stable DOM', 'no settings writes', 'no provider discovery'] }, null, 2) + '\n');
});

test('pane reveal awaits the public asynchronous host operation and surfaces its failure', async () => {
  const value = host(path.join(root, 'tmp/headless-reveal-vault'), {});
  const plugin = new value.api.Plugin();
  const runtime = createRuntime(plugin, value.api);
  const leaf = { view: { getViewType: () => 'md2tex-workshop-view' } };
  value.leaves.push(leaf);
  let reject;
  value.app.workspace.revealLeaf = () => new Promise((_resolve, failure) => { reject = failure; });
  const pending = runtime.openView();
  reject(new Error('Synthetic reveal failure'));
  await assert.rejects(() => pending, /Synthetic reveal failure/);
  runtime.dispose();
});

test('CLI target discovery, auto-build, manual queue and reverse preview cooperate in the host', async t => {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/linked host-'));
  const value = host(dir, { nodeCommand: process.execPath, buildDebounceMs: 100 });
  const plugin = new value.api.Plugin();
  const file = new value.api.TFile('note.md');
  const source = '# Fixed target\n\nThe first paragraph is from Markdown.\n\nAn unchanged control.\n';
  await fs.writeFile(path.join(dir, file.path), source);
  const editor = new value.api.MarkdownView(file, source);
  value.leaves.push({ view: editor }); value.app.workspace.active = value.leaves[0];
  const runtime = createRuntime(plugin, value.api, { openPath: async filename => { value.external.push(filename); return ''; } });
  t.after(() => runtime.dispose()); await runtime.start();
  const target = path.join(dir, 'stable.tex');
  const command = await execute(process.execPath, [path.join(root, 'scripts/workshop.cjs'), 'tex-target', path.join(dir, file.path), '--target', target], { cwd: root });
  assert.equal(command.code, 0);
  value.app.vault.emit('create', new value.api.TFile('note.md.workshop.json'));
  await until(() => runtime.controller.state().linkedTarget?.linked);
  assert.equal(runtime.controller.state().linkedTarget.target, target);
  await runtime.openView(); const view = value.app.workspace.getLeavesOfType('md2tex-workshop-view')[0].view;
  const first = await runtime.build(); assert.equal(first.target, undefined); assert.equal(first.result.target.status, 'success');
  await until(() => !runtime.scheduler.running);
  assert.match(view.linkEl.text, /stable.tex/);
  await runtime.openLinked(); assert.deepEqual(value.external, [target]);
  await runtime.setAutoBuild(true);
  const generation = runtime.controller.state().linkedTarget.generation;
  editor.text = source.replace('from Markdown', 'from the editor');
  value.app.workspace.emit('editor-change', editor.editor, editor);
  await until(() => runtime.controller.state().busy);
  const explicit = runtime.build(); assert.equal(runtime.controller.state().queuedBuilds, 1);
  const manual = await explicit; assert.equal(manual.result.status, 'success');
  await until(() => !runtime.scheduler.running);
  assert.equal(runtime.controller.state().linkedTarget.generation, generation + 1, 'duplicate manual build must not rewrite an unchanged target');
  assert.match(await fs.readFile(target, 'utf8'), /from the editor/);
  await fs.writeFile(path.join(dir, file.path), editor.text);
  await runtime.setAutoBuild(false);
  await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('from the editor', 'from TeX review'));
  const getLeaf = value.app.workspace.getLeaf;
  value.app.workspace.getLeaf = type => {
    const leaf = getLeaf(type); const open = leaf.openFile;
    /** Model an unrelated metadata plugin rewriting every opened Markdown file. */
    leaf.openFile = async (file, options) => {
      if (file.path.endsWith('.md')) await fs.appendFile(path.join(dir, file.path), '\nMetadata plugin changed this opened note.\n');
      return open(file, options);
    };
    return leaf;
  };
  const preview = await runtime.previewLinked();
  assert.equal(preview.status, 'success');
  assert.match(await fs.readFile(preview.artifacts.candidate, 'utf8'), /from TeX review/);
  assert.doesNotMatch(await fs.readFile(path.join(dir, file.path), 'utf8'), /from TeX review/);
  assert.equal(sourceHash(await fs.readFile(preview.artifacts.candidate)), preview.candidateHash, 'opening a review must preserve the sealed candidate even with metadata-on-open plugins');
  assert.equal(value.opened.length, 0);
  const candidateView = value.app.workspace.getLeavesOfType('md2tex-workshop-review')[0].view;
  assert.match(candidateView.candidateEl.text, /from TeX review/);
  assert.doesNotMatch(candidateView.currentEl.text, /from TeX review/);
  value.app.workspace.active = { view: candidateView };
  value.app.workspace.emit('active-leaf-change', value.app.workspace.active);
  assert.equal(runtime.currentFile(), file, 'opening generated review Markdown must keep the original build target');
  assert.equal(runtime.scheduler.held, false);
  assert.equal(view.contentEl.emptyCount, 1);
});
