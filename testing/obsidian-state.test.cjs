/**
 * Exercise exact source capture and manual note/job ownership without a live host.
 * Usage from root: node --test --test-isolation=none testing/obsidian-state.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SourceStore } = require('../src/obsidian/source-store.cjs');
const { BuildController } = require('../src/obsidian/controller.cjs');
const { sourceHash } = require('../src/core/protocol.cjs');
const root = path.resolve(__dirname, '../tmp/headless-state-vault');

/** Expose an explicitly controlled asynchronous boundary. */
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/** Represent public MarkdownView identity and its current buffer. */
class MarkdownView {
  /** Read buffer values dynamically, as an editor does. */
  constructor(file, text) { this.file = file; this.text = text; this.editor = { getValue: () => this.text }; }
}

/** Build a source adapter with only read capabilities and visible editor leaves. */
function sourceFixture() {
  const leaves = [];
  const reads = [];
  const disk = new Map();
  const app = { vault: { adapter: { getBasePath: () => root }, readBinary: async file => { reads.push(file.path); return Buffer.from(disk.get(file.path) || ''); } },
    workspace: { getLeavesOfType: () => leaves } };
  const sources = new SourceStore({ app, MarkdownView });
  return { app, leaves, reads, disk, sources };
}

/** Bind a real source store to controlled worker/history promises. */
function fixture() {
  const value = sourceFixture();
  const calls = [];
  const histories = [];
  const client = {
    /** Retain the immutable request and pending worker response. */
    invoke(request, options) { const pending = deferred(); calls.push({ request, options, ...pending }); return pending.promise; },
    /** Retain pending history to simulate a late disk response. */
    history() { const pending = deferred(); histories.push(pending); return pending.promise; },
  };
  const controller = new BuildController({ sourceStore: value.sources, createClient: () => client,
    configuration: () => ({ outputRoot: path.join(root, 'output'), recipeOverrides: {}, execution: { latexmk: 'latexmk', timeoutMs: 30000 } }) });
  return { ...value, calls, histories, controller };
}

/** Return a minimal owned core result for controller-only tests; worker schema has separate tests. */
function result(call, status = 'success') {
  return { result: { status, source: { path: call.request.source.canonicalPath, sha256: call.request.source.sha256 }, artifacts: { pdf: 'owned.pdf' }, diagnostics: [] } };
}

/** Let an already-started source capture reach the mocked worker. */
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

test('inactive editors are captured synchronously and conflicting views are refused', async () => {
  const value = sourceFixture();
  const file = { path: 'draft.md' };
  const editor = new MarkdownView(file, '\ufeff# Unsaved\r\n');
  value.leaves.push({ view: editor });
  const pending = value.sources.capture(file);
  editor.text = 'Later edit';
  const snapshot = await pending;
  assert.equal(snapshot.text, '\ufeff# Unsaved\r\n');
  assert.equal(snapshot.sha256, sourceHash(snapshot.text));
  assert.equal(snapshot.origin, 'editor');
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(value.reads.length, 0);
  value.leaves.push({ view: new MarkdownView(file, 'Other editor') });
  await assert.rejects(() => value.sources.capture(file), { code: 'CONFLICTING_EDITORS' });
  value.leaves[1].view.text = editor.text;
  assert.equal((await value.sources.capture(file)).text, 'Later edit');
});

test('saved UTF-8 preserves BOM and CRLF and rejects invalid bytes or unpaired surrogates', async () => {
  const value = sourceFixture();
  const file = { path: 'saved.md' };
  value.disk.set(file.path, '\ufeff# Saved\r\n');
  const snapshot = await value.sources.capture(file);
  assert.equal(snapshot.text, '\ufeff# Saved\r\n');
  assert.equal(snapshot.origin, 'disk');
  value.app.vault.readBinary = async () => Uint8Array.from([0xff]);
  await assert.rejects(() => value.sources.capture(file), { code: 'INVALID_UTF8' });
  value.leaves.push({ view: new MarkdownView(file, '\ud800') });
  await assert.rejects(() => value.sources.capture(file), { code: 'INVALID_UNICODE' });
  await assert.rejects(() => value.sources.capture({ path: '../outside.md' }), { code: 'SOURCE_OUTSIDE_VAULT' });
});

test('an editor opened during a disk read wins, while a moved note is refused', async () => {
  const value = sourceFixture();
  const file = { path: 'saved.md' };
  let pending = deferred();
  value.app.vault.readBinary = () => pending.promise;
  const capture = value.sources.capture(file);
  value.leaves.push({ view: new MarkdownView(file, 'New editor') });
  pending.resolve(Buffer.from('Earlier saved text'));
  assert.equal((await capture).text, 'New editor');
  value.leaves.length = 0;
  pending = deferred();
  const moved = value.sources.capture(file);
  file.path = 'renamed.md';
  pending.resolve(Buffer.from('Earlier saved text'));
  await assert.rejects(() => moved, { code: 'SOURCE_MOVED' });
});

test('switching notes cannot publish another note result, and intervening edits stay stale', async () => {
  const value = fixture();
  const a = { path: 'a.md' }; const b = { path: 'b.md' };
  const editor = new MarkdownView(a, 'A captured');
  value.leaves.push({ view: editor });
  value.disk.set(b.path, 'B saved');
  const pending = value.controller.compile(a);
  await tick();
  assert.ok(Object.isFrozen(value.calls[0].request));
  value.controller.select(b);
  editor.text = 'A newer';
  value.controller.invalidate(a);
  value.calls[0].options.onEvent({ stage: 'compilation' });
  assert.equal(value.controller.state().runningTarget, 'a.md');
  value.calls[0].resolve(result(value.calls[0]));
  await pending;
  assert.equal(value.controller.state().target, b);
  assert.equal(value.controller.state().latest, null);
  value.controller.select(a);
  assert.equal(value.controller.state().lastSuccess.source.sha256, sourceHash('A captured'));
  assert.equal(value.controller.state().current, false);
  assert.equal(value.controller.state().latestCurrent, false);
  value.controller.togglePin();
  value.controller.select(b);
  assert.equal(value.controller.state().target, a);
  assert.equal(value.calls.length, 1, 'passive changes must never schedule a build');
});

test('manual busy and cancellation keep the job owned until actual completion', async () => {
  const value = fixture();
  const file = { path: 'draft.md' };
  value.disk.set(file.path, 'Captured');
  const pending = value.controller.compile(file);
  await tick();
  await assert.rejects(() => value.controller.compile(file), { code: 'BUILD_BUSY' });
  value.controller.cancel();
  assert.equal(value.calls[0].options.signal.aborted, true);
  assert.equal(value.controller.state().busy, true);
  value.calls[0].reject(Object.assign(new Error('Cancelled fixture'), { code: 'BUILD_CANCELLED' }));
  await assert.rejects(() => pending, { code: 'BUILD_CANCELLED' });
  assert.equal(value.controller.state().busy, false);
  assert.equal(value.controller.state().diagnostic.code, 'BUILD_CANCELLED');
});

test('late history cannot overwrite a completed build, including history started mid-build', async () => {
  const value = fixture();
  const file = { path: 'draft.md' };
  value.disk.set(file.path, 'New revision');
  value.controller.select(file);
  const historyBefore = value.controller.inspect();
  const build = value.controller.compile(file);
  await tick();
  const historyDuring = value.controller.inspect();
  value.calls[0].resolve(result(value.calls[0]));
  await build;
  for (const history of value.histories) history.resolve({ latestAttempt: null, lastSuccess: null });
  await Promise.all([historyBefore, historyDuring]);
  assert.equal(value.controller.state().lastSuccess.source.sha256, sourceHash('New revision'));
  assert.equal(value.controller.state().current, true);
});

test('unsubscribing a view keeps work alive; unloading aborts and suppresses late callbacks', async () => {
  const value = fixture();
  const file = { path: 'draft.md' };
  let notices = 0;
  const unsubscribe = value.controller.subscribe(() => { notices++; });
  const build = value.controller.compile(file);
  await tick();
  unsubscribe();
  assert.equal(value.calls[0].options.signal.aborted, false);
  value.controller.dispose();
  const count = notices;
  assert.equal(value.calls[0].options.signal.aborted, true);
  value.calls[0].options.onEvent({ stage: 'late' });
  value.calls[0].resolve(result(value.calls[0]));
  await build;
  assert.equal(notices, count);
  assert.equal(value.controller.state().latest, null);
  await assert.rejects(() => value.controller.compile(file), { code: 'HOST_UNLOADED' });
});

test('renames preserve the running label and cannot label an old-path PDF as current', async () => {
  const value = fixture();
  const file = { path: 'draft.md' };
  value.leaves.push({ view: new MarkdownView(file, 'Captured') });
  const pending = value.controller.compile(file);
  await tick();
  file.path = 'renamed.md';
  value.controller.invalidate(file);
  assert.equal(value.controller.state().runningTarget, 'draft.md');
  value.calls[0].resolve(result(value.calls[0]));
  await pending;
  assert.equal(value.controller.state().target.path, 'renamed.md');
  assert.equal(value.controller.state().lastSuccess, null);
});

test('automatic duplicate editor/save revisions are skipped, while manual retries still run', async () => {
  const value = fixture(); const file = { path: 'draft.md' };
  value.disk.set(file.path, 'Same source');
  const first = value.controller.compile(file); await tick(); value.calls[0].resolve(result(value.calls[0])); await first;
  value.controller.invalidate(file);
  assert.equal(await value.controller.compile(file, { skipUnchanged: true }), null);
  assert.equal(value.calls.length, 1);
  const retry = value.controller.compile(file); await tick(); assert.equal(value.calls.length, 2);
  value.calls[1].resolve(result(value.calls[1])); await retry;
});
