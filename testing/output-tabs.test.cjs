/**
 * Verify output ownership and asynchronous renderer/log lifecycles.
 * Usage from root: node --test --test-isolation=none testing/output-tabs.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { OutputTabs } = require('../src/obsidian/output-tabs.cjs');
const { renderPdf } = require('../src/obsidian/pdf-embed.cjs');

/** Supply only the DOM operations used by OutputTabs. */
class Element {
  /** Track visibility, text, children and handlers. */
  constructor() { this.children = []; this.events = {}; }
  /** Create a child element while retaining its identity. */
  createEl(tag, options = {}) { const child = new Element(); child.text = options.text || ''; this.children.push(child); return child; }
  /** Match Obsidian's createDiv helper. */
  createDiv(options) { return this.createEl('div', options); }
  /** Store accessibility state for assertions. */
  setAttribute(name, value) { this[name] = value; }
  /** Capture a user action. */
  addEventListener(name, callback) { this.events[name] = callback; }
  /** Clear detached content. */
  empty() { this.children = []; this.text = ''; }
  /** Replace text as native textContent does. */
  setText(text) { this.empty(); this.text = text; }
  /** Record keyboard focus. */
  focus() { this.focused = true; }
}

/** Let pending async continuations settle without wall-clock sleeps. */
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

/** Defer an actual dependency call to reproduce note-switch/closure races. */
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

/** Construct view state with distinct successful-PDF and latest-log identities. */
function state(note = 'a', pdf = 'one', log = 'one') {
  return { target: { path: `${note}.md` }, lastSuccess: pdf ? { artifacts: { pdf: `${note}/${pdf}.pdf` } } : null,
    latest: log ? { artifacts: { compilationLog: `${note}/${log}.json` } } : null };
}

/** Provide controllable renderer and log dependencies behind the production interface. */
function fixture() {
  const children = new Set(); const rendered = []; const reads = [];
  /** Mark native component cleanup independently from DOM removal. */
  class Component { /** Record native lifecycle completion. */ unload() { this.unloaded = true; } }
  const owner = {
    /** Retain a view-owned render lifecycle. */
    addChild(component) { children.add(component); return component; },
    /** Unload exactly the replaced lifecycle. */
    removeChild(component) { component.unload(); children.delete(component); },
  };
  const runtime = {
    /** Resolve an owned fixture PDF. */
    async pdfSource() { return { sourcePath: 'a.md', file: { path: 'a/one.pdf' } }; },
    /** Track bounded reads independently from renderer calls. */
    async readLog() { reads.push('read'); return 'current log'; },
    /** Record each native mount request. */
    async renderPdf(source, surface, component) { rendered.push({ source, surface, component }); },
  };
  const api = { Component };
  const output = new OutputTabs(api, runtime, owner, new Element());
  return { output, runtime, api, rendered, reads, children };
}

test('PDF/log toggles preserve renderer identity, cached log and keyboard tab state', async () => {
  const f = fixture(); f.output.update(state()); await settle(); const surface = f.rendered[0].surface;
  surface.scrollTop = 123; f.output.select('log'); await settle();
  assert.equal(f.output.pdfPanel.hidden, true); assert.equal(f.output.logPanel.text, 'current log');
  f.output.select('pdf'); f.output.update(state()); await settle();
  assert.equal(f.rendered.length, 1); assert.equal(f.rendered[0].surface, surface); assert.equal(surface.scrollTop, 123);
  f.output.select('log'); await settle(); assert.equal(f.reads.length, 1);
  f.output.logButton.events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(f.output.mode, 'pdf'); assert.equal(f.output.pdfButton['aria-selected'], 'true'); assert.equal(f.output.pdfButton.focused, true);
  f.output.dispose(); assert.equal(f.children.size, 0);
});

test('native resize adjustments after showing PDF cannot move the saved scroll position', async () => {
  const f = fixture(); f.output.update(state()); await settle();
  const node = { scrollTop: 120, scrollLeft: 12 }; const frames = [];
  f.output.pdfPanel.querySelector = () => node;
  f.output.window = { requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame() {} };
  f.output.select('log'); node.scrollTop = 0; f.output.select('pdf'); assert.equal(node.scrollTop, 120);
  node.scrollTop = 60; frames.shift()(); node.scrollTop = 60; frames.shift()();
  assert.equal(node.scrollTop, 120); assert.equal(node.scrollLeft, 12);
  f.output.select('log'); f.output.select('pdf'); f.output.dispose(); node.scrollTop = 7;
  while (frames.length) frames.shift()(); assert.equal(node.scrollTop, 7);
});

test('failed or running builds keep last-success PDF; new success replaces only its renderer', async () => {
  const f = fixture(); f.output.update(state()); await settle(); const before = f.rendered[0].component;
  f.output.update({ ...state('a', 'one', 'failed'), busy: true }); await settle();
  assert.equal(f.rendered.length, 1); assert.equal(before.unloaded, undefined);
  f.output.update(state('a', 'two', 'two')); await settle();
  assert.equal(before.unloaded, true); assert.equal(f.rendered.length, 2); assert.equal(f.children.size, 1);
  f.output.dispose();
});

test('late logs and PDF lookup cannot overwrite another note or a preflight-only attempt', async () => {
  const f = fixture(); const oldPdf = deferred(); const oldLog = deferred();
  f.runtime.pdfSource = () => oldPdf.promise; f.runtime.readLog = () => oldLog.promise;
  f.output.update(state()); f.output.select('log');
  f.output.update({ ...state('b', null, null), latest: { diagnostics: [{ code: 'PREFLIGHT' }] } });
  oldPdf.resolve({ sourcePath: 'a.md', markdown: '![[old.pdf]]' }); oldLog.resolve('old log'); await settle();
  assert.equal(f.rendered.length, 0); assert.match(f.output.pdfPanel.text, /Build this note/); assert.match(f.output.logPanel.text, /diagnostics above/);
  f.output.dispose();
});

test('closing or changing a note during native rendering unloads the obsolete component', async () => {
  const f = fixture(); const render = deferred();
  f.runtime.renderPdf = async (...args) => { f.rendered.push(args); await render.promise; };
  f.output.update(state()); await settle(); const component = [...f.children][0];
  f.output.update(state('b', null, null)); assert.equal(component.unloaded, true); assert.equal(f.children.size, 0);
  f.output.dispose(); render.resolve(); await settle(); assert.equal(f.children.size, 0);
});

test('native PDF adapter checks capability and selects interactive rather than static display', async () => {
  const source = { file: { path: 'test [#].pdf' }, sourcePath: 'draft.md' };
  let context; let loaded = false; const children = [];
  const embed = {
    /** Mark that the factory's actual file-loading operation ran. */
    async loadFile() { loaded = true; },
    /** Supply the native lifecycle interface. */
    unload() {},
  };
  const app = { embedRegistry: {
    /** Resolve by native file identity, avoiding Markdown link escaping. */
    getEmbedCreator(file) { assert.equal(file, source.file); return (value, target, subpath) => { context = value; assert.equal(target, file); assert.equal(subpath, ''); return embed; }; },
  } };
  await renderPdf(app, source, new Element(), { addChild(value) { children.push(value); } });
  assert.equal(context.displayMode, false); assert.equal(context.sourcePath, 'draft.md');
  assert.equal(context.containerEl.src, source.file.path); assert.equal(loaded, true); assert.deepEqual(children, [embed]);
  await assert.rejects(() => renderPdf({}, source, new Element(), {}), /no supported interactive PDF/);
  await assert.rejects(() => renderPdf({ embedRegistry: { getEmbedCreator: () => () => ({}) } }, source, new Element(), {}), /interface changed/);
});

test('an open log follows new attempt paths even without an attemptId field', async () => {
  const f = fixture(); f.output.select('log'); f.output.update(state()); await settle();
  f.runtime.readLog = async () => 'new failed attempt';
  f.output.update(state('a', 'one', 'new')); await settle(); assert.equal(f.output.logPanel.text, 'new failed attempt');
  f.output.dispose();
});

test('missing PDF/log failures are visible and an explicit tab click retries', async () => {
  const f = fixture(); f.runtime.pdfSource = async () => { throw new Error('not indexed'); };
  f.runtime.readLog = async () => { throw new Error('missing log'); };
  f.output.update(state()); await settle(); assert.match(f.output.pdfPanel.text, /not indexed/);
  f.runtime.pdfSource = async () => ({ sourcePath: 'a.md', markdown: '![[a.pdf]]' });
  f.output.select('pdf'); await settle(); assert.equal(f.output.pdfStatus, 'ready');
  f.output.select('log'); await settle(); assert.match(f.output.logPanel.text, /missing log/);
  f.runtime.readLog = async () => 'recovered'; f.output.select('log'); await settle(); assert.equal(f.output.logPanel.text, 'recovered');
  f.output.dispose();
});
