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
const { stageBratPackage } = require('../scripts/lib/brat-package.cjs');
const { execute } = require('./execute.cjs');
const { createRuntime } = require('../src/obsidian/plugin.cjs');
const { createViewClass } = require('../src/obsidian/view.cjs');
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
  createEl(tag, options = {}) { const child = new Element(); child.tag = tag; child.text = options.text || ''; child.className = options.cls || ''; this.children.push(child); return child; }
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
  const notices = []; const opened = []; const external = []; const leaves = []; const embeds = []; const copied = [];
  let saveSequence = 0;
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
  class MarkdownView {
    /** Bind exact editor text and one public transaction/save-request history. */
    constructor(file, text) {
      this.file = file; this.text = text; this.transactions = []; this.undo = []; this.cursor = { line: 0, ch: 0 };
      const positionToOffset = position => {
        const lines = this.text.split('\n');
        return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.ch;
      };
      this.editor = {
        getValue: () => this.text,
        offsetToPos: offset => { const before = this.text.slice(0, offset); const lines = before.split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; },
        getCursor: () => ({ ...this.cursor }),
        replaceRange: (inserted, from, to = from) => {
          const start = positionToOffset(from); const end = positionToOffset(to);
          this.text = this.text.slice(0, start) + inserted + this.text.slice(end);
          this.cursor = this.editor.offsetToPos(start + inserted.length);
        },
        setCursor: position => { this.cursor = { ...position }; },
        transaction: (change, origin) => { this.undo.push(this.text); this.transactions.push({ change, origin }); this.text = change.changes[0].text; },
      };
    }
    /** Schedule one atomic persistence result through the public TextFileView save-request interface. */
    requestSave() {
      const target = path.join(vaultRoot, this.file.path);
      const temporary = `${target}.test-save-${process.pid}-${++saveSequence}`;
      const text = this.text;
      void fs.writeFile(temporary, text).then(() => fs.rename(temporary, target)).then(() => vault.emit('modify', this.file));
    }
  }
  /** Supply the public ItemView content element. */
  class ItemView extends Component { /** Bind a leaf and stable content. */ constructor(leaf) { super(); this.leaf = leaf; this.contentEl = new Element(); } }
  /** Capture notices for assertions instead of showing native UI. */
  class Notice { /** Record the visible message. */ constructor(message) { notices.push(message); } }
  /** Supply the settings tab base without writing settings. */
  class PluginSettingTab { /** Keep the public container. */ constructor() { this.containerEl = new Element(); } }
  const vault = new Events();
  vault.adapter = { getBasePath: () => vaultRoot };
  vault.readBinary = file => fs.readFile(path.join(vaultRoot, file.path));
  vault.process = async (file, change) => {
    const filename = path.join(vaultRoot, file.path);
    const next = await change(await fs.readFile(filename, 'utf8'));
    await fs.writeFile(filename, next);
    vault.emit('modify', file);
    return next;
  };
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
  return { app, api: { Plugin, TFile, MarkdownView, ItemView, Notice, PluginSettingTab, Component }, notices, opened, external, leaves, embeds, copied };
}

/** Wait for an asynchronous view to finish mounting without arbitrary long sleeps. */
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Host fixture did not reach its expected state');
}

test('editor label command inserts the supported comment and targets its identifier', async () => {
  const vaultRoot = await fs.mkdtemp(path.join(root, 'tmp/editor-label-command-'));
  const value = host(vaultRoot, {});
  const file = new value.api.TFile('draft.md');
  const editor = new value.api.MarkdownView(file, '# A note\n\n');
  editor.cursor = { line: 1, ch: 0 };
  value.leaves.push({ view: editor });
  value.app.workspace.active = value.leaves[0];
  const plugin = new value.api.Plugin();
  const runtime = createRuntime(plugin, value.api);
  try {
    await runtime.start();
    const command = plugin.commands.get('insert-label-metadata');
    assert.deepEqual(command.hotkeys, [{ modifiers: ['Mod', 'Shift'], key: 'L' }]);
    command.editorCallback(editor.editor, editor);
    assert.equal(editor.text, '# A note\n<!-- [label{}] -->\n');
    assert.deepEqual(editor.cursor, { line: 1, ch: 12 });
  } finally { runtime.dispose(); }
});

test('shared explanation pane requires a current failure and discards stale replies', async () => {
  const value = host(path.join(root, 'tmp/explanation-pane-vault'), {});
  const first = { status: 'error', diagnostics: [{ severity: 'error', message: 'Unsupported image' }] };
  let state = { target: { path: 'draft.md' }, latest: first, latestCurrent: true };
  let subscriber; let resolveReply; const calls = [];
  const runtime = {
    explanationDescription: 'Bundled fake helper only.',
    controller: { state: () => state, subscribe(callback) { subscriber = callback; callback(state); return () => {}; }, async inspect() {}, async refreshTarget() {} },
    async explainFailure(options) { calls.push(options); if (calls.length === 1) return { status: 'refused', code: 'AGENT_CONSENT_REQUIRED' }; if (calls.length === 2) return new Promise(resolve => { resolveReply = resolve; }); return { status: 'success', packetId: '1234567890123456', explanation: { verdict: 'explained', summary: '<plain text>', suggestions: [{ text: 'Replace the image line.' }] } }; },
    async perform(action) { return action(); },
  };
  const View = createViewClass(value.api, runtime);
  const view = new View({});
  await view.onOpen();
  assert.equal(view.agentEl.open, false);
  assert.ok(view.contentEl.children.indexOf(view.output.root) < view.contentEl.children.indexOf(view.agentEl));
  assert.ok(view.contentEl.children.indexOf(view.agentEl) < view.contentEl.children.indexOf(view.detailsEl));
  assert.equal(view.agentRunButton.disabled, false);
  await view.agentGuardButton.events.click();
  assert.deepEqual(calls, [{ allowTrusted: false }]);
  assert.match(view.agentStatusEl.text, /AGENT_CONSENT_REQUIRED/);
  const pending = view.agentRunButton.events.click();
  assert.equal(view.agentRunButton.disabled, true);
  await view.requestExplanation(true);
  assert.equal(calls.length, 2, 'a second click cannot dispatch concurrently');
  state = { ...state, latestCurrent: false };
  subscriber(state);
  resolveReply({ status: 'explained', packetId: '1234567890123456', explanation: { verdict: 'fixable', summary: 'Old reply', suggestions: [{ text: 'Old suggestion' }] } });
  await pending;
  assert.match(view.agentStatusEl.text, /changed/);
  assert.equal(view.agentResultEl.text, '');
  assert.equal(view.agentRunButton.disabled, true);
  state = { ...state, latest: { ...first }, latestCurrent: true };
  subscriber(state);
  await view.agentRunButton.events.click();
  assert.match(view.agentStatusEl.text, /Validated explained reply/);
  assert.match(view.agentResultEl.text, /<plain text>/);
  assert.match(view.agentResultEl.text, /Replace the image line/);
  state = { ...state, latest: { status: 'success' } };
  subscriber(state);
  assert.equal(view.agentResultEl.text, '');
  assert.match(view.agentStatusEl.text, /Build succeeded/);
  await view.onClose();
});

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

for (const [format, stage] of [['directory', stagePackage], ['brat', stageBratPackage]]) test(`relocated ${format} entry builds the pinned editor snapshot with AI off and stable view ownership`, async t => {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/manual host-'));
  const initialVault = path.join(dir, 'vault');
  const installed = path.join(initialVault, '.obsidian/plugins/md2tex-workshop');
  await stage({ sourceRoot: root, output: installed });
  if (format === 'brat') assert.deepEqual((await fs.readdir(installed)).sort(), ['main.js', 'manifest.json', 'styles.css']);
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
    require(name) { if (name === 'obsidian') return value.api; if (name === 'electron') return {
      shell: { openPath: async filename => { value.external.push(filename); return ''; } },
      clipboard: { writeText: text => { if (value.clipboardError) throw new Error(value.clipboardError); value.copied.push(text); } },
    }; return require(name); },
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
  assert.deepEqual(view.contentEl.children[0].children.map(child => child.text), ['Build', 'Set TeX target']);
  assert.equal(view.controlsEl.open, false);
  assert.equal(view.agentEl.open, false);
  assert.equal(view.agentRunButton.disabled, true);
  assert.match(view.agentInfoEl.text, /not configured/);
  assert.equal(view.detailsEl.open, false);
  assert.equal(view.copyButton.disabled, true);
  await plugin.commands.get('copy-generated-tex').callback();
  assert.match(value.notices.pop(), /No tex output/);
  assert.equal(value.copied.length, 0);
  await view.linkButton.events.click();
  assert.equal(view.controlsEl.open, true);
  view.controlsEl.open = false;
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
  assert.match(view.recipeEl.text, /basic-preamble\.tex \(default\)/);
  assert.match(view.recipeEl.text, /pdflatex \(default\)/);
  assert.equal(view.recipeEl.title, frame.result.profile.preamblePath);
  assert.equal(plugin.runtime.controller.state().current, true);
  assert.equal(view.statusEl.hidden, true);
  assert.equal(view.revisionEl.hidden, true);
  assert.equal(view.copyButton.disabled, false);
  await view.copyButton.events.click();
  const generatedTex = await fs.readFile(frame.result.artifacts.tex, 'utf8');
  assert.equal(value.copied.at(-1), generatedTex, 'the button copies the exact complete generated document');
  assert.match(value.notices.at(-1), /Copied generated TeX for draft.md/);
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
  const packetRun = await execute(process.execPath, [plugin.runtime.configuration().cliPath, 'failure-packet', failed.result.artifacts.result], { cwd: vaultRoot });
  const packet = JSON.parse(packetRun.stdout);
  assert.equal(packetRun.code, 0);
  assert.equal(packet.schemaVersion, 'workshop-failure-packet.v2');
  assert.equal(packet.identity.sourceHash, failed.sourceHash);
  assert.equal(packet.evidence[0].code, 'UNRESOLVED_REFERENCE');
  assert.match(packet.evidence.find(item => item.kind === 'source').text, /missing/);
  assert.equal(plugin.runtime.artifact('pdf'), frame.result.artifacts.pdf);
  assert.match(view.diagnosticEl.text, /UNRESOLVED_REFERENCE/);
  assert.equal(view.statusEl.hidden, false);
  assert.equal(view.revisionEl.hidden, false);
  assert.equal(view.detailsEl.open, false, 'failure does not force expanded details');
  assert.equal(view.agentRunButton.disabled, true, 'a failed build does not enable an unconfigured provider');
  assert.match(view.agentStatusEl.text, /not configured/);
  await plugin.commands.get('copy-generated-tex').callback();
  assert.equal(value.copied.at(-1), generatedTex, 'a failed build keeps the last successful TeX copyable');
  assert.match(value.notices.at(-1), /last successful build; note has changed/);
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
  const beforeFailure = value.copied.length;
  value.clipboardError = 'Clipboard unavailable';
  await view.copyButton.events.click();
  assert.equal(value.copied.length, beforeFailure);
  assert.equal(value.notices.at(-1), 'Clipboard unavailable');
  value.clipboardError = null;
  const switchingCopy = plugin.runtime.copyGeneratedTex();
  plugin.runtime.controller.select(other.file, { force: true });
  await assert.rejects(switchingCopy, /selected note or successful build changed/);
  assert.equal(value.copied.length, beforeFailure);
  plugin.runtime.controller.select(file, { force: true });
  await fs.rename(frame.result.artifacts.tex, frame.result.artifacts.tex + '.retained');
  await assert.rejects(() => plugin.runtime.copyGeneratedTex(), { code: 'ENOENT' });
  assert.equal(value.copied.length, beforeFailure);
  await fs.rename(frame.result.artifacts.tex + '.retained', frame.result.artifacts.tex);
  await view.onClose();
  const previous = view.statusEl.text;
  plugin.onunload();
  value.app.workspace.emit('editor-change', editor.editor, editor);
  assert.equal(view.statusEl.text, previous);
  await fs.writeFile(path.join(dir, 'validation.json'), JSON.stringify({ package: path.dirname(entry), success: frame.result, failure: failed.result,
    checks: ['relocated entry', 'captured pinned editor', 'source unchanged', 'real PDF text and references', 'last-good PDF', 'native-open requests', 'stale diagnostics refused', 'stable DOM', 'collapsed controls', 'exact TeX clipboard', 'failed-build clipboard fallback', 'note-switch clipboard refusal', 'clipboard errors', 'missing artifact refusal', 'no settings writes', 'no provider discovery'] }, null, 2) + '\n');
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

for (const format of ['direct', 'brat']) test(`CLI target discovery, auto-build, manual queue and reverse preview cooperate in the ${format} host`, async t => {
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'tmp/linked host-'));
  const value = host(dir, { nodeCommand: process.execPath, buildDebounceMs: 100 });
  const plugin = new value.api.Plugin();
  const file = new value.api.TFile('note.md');
  const source = '# Fixed target\n\nThe first paragraph is from Markdown.\n\nAn unchanged control.\n';
  await fs.writeFile(path.join(dir, file.path), source);
  const editor = new value.api.MarkdownView(file, source);
  value.leaves.push({ view: editor }); value.app.workspace.active = value.leaves[0];
  let runtime;
  if (format === 'brat') {
    const output = path.join(dir, '.obsidian/plugins/md2tex-workshop');
    await stageBratPackage({ sourceRoot: root, output });
    const context = { module: { exports: {} },
      /** Preserve actual entry loading while recording explicit desktop actions. */
      require(name) {
        if (name === 'obsidian') return value.api;
        if (name === 'electron') return { shell: { openPath: async filename => { value.external.push(filename); return ''; } }, clipboard: { writeText: text => value.copied.push(text) } };
        return require(name);
      },
    };
    const entry = path.join(output, 'main.js');
    vm.runInNewContext(await fs.readFile(entry, 'utf8'), context, { filename: entry });
    const packaged = new context.module.exports();
    await packaged.onload(); runtime = packaged.runtime;
  } else {
    runtime = createRuntime(plugin, value.api, {
      openPath: async filename => { value.external.push(filename); return ''; },
      writeClipboard: text => value.copied.push(text),
    });
    await runtime.start();
  }
  t.after(() => runtime.dispose());
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
  const conflict = await runtime.build();
  assert.equal(conflict.result.status, 'success');
  assert.equal(conflict.result.target.code, 'TARGET_EDITED');
  assert.equal(view.statusEl.hidden, false, 'successful PDF with failed target publication still has a visible failure');
  assert.match(view.statusEl.text, /external edits/);
  await runtime.copyGeneratedTex();
  assert.match(value.copied.at(-1), /from the editor/);
  assert.doesNotMatch(value.copied.at(-1), /from TeX review/, 'copy never chooses the independently edited linked target');
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
  await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('from TeX review', 'from refreshed TeX review'));
  const refreshed = await runtime.previewLinked();
  assert.equal(refreshed.status, 'success');
  assert.equal(value.app.workspace.getLeavesOfType('md2tex-workshop-review').length, 1, 'a fresh preview refreshes rather than duplicates the review tab');
  assert.match(candidateView.candidateEl.text, /from refreshed TeX review/, 'the visible candidate must be the exact review used by Apply');
  assert.doesNotMatch(candidateView.currentEl.text, /from refreshed TeX review/);
  await candidateView.applyButton.events.click();
  assert.match(candidateView.applyStatusEl.text, /Applied and saved/);
  assert.equal(editor.transactions.length, 1);
  assert.equal(editor.transactions[0].origin, 'md2tex-workshop');
  assert.equal(editor.undo.at(-1), source.replace('from Markdown', 'from the editor'));
  assert.match(editor.text, /from refreshed TeX review/);
  assert.match(await fs.readFile(path.join(dir, file.path), 'utf8'), /from refreshed TeX review/);
  assert.equal(runtime.controller.state().linkedTarget.externallyEdited, false);
  value.app.workspace.active = { view: candidateView };
  value.app.workspace.emit('active-leaf-change', value.app.workspace.active);
  assert.equal(runtime.currentFile(), file, 'opening generated review Markdown must keep the original build target');
  assert.equal(runtime.scheduler.held, false);
  assert.equal(view.contentEl.emptyCount, 1);
});
