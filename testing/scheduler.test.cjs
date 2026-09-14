/**
 * Verify M2 timing and queue policy through its public scheduling interface.
 * Usage from root: node --test --test-isolation=none testing/scheduler.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { BuildScheduler } = require('../src/obsidian/scheduler.cjs');

test('default timers preserve the browser global receiver during load, edits and unload', () => {
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(`
    var timerCalls = [];
    /** Model the browser timer receiver requirement. */
    function setTimeout(callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerCalls.push('set'); return 1;
    }
    /** Reject a scheduler object used as the browser timer receiver. */
    function clearTimeout(id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerCalls.push('clear');
    }
  `, context);
  vm.runInContext(fs.readFileSync(require.resolve('../src/obsidian/scheduler.cjs'), 'utf8'), context);
  const { controller, file } = fixture();
  const scheduler = new context.module.exports.BuildScheduler(controller);
  scheduler.configure({ enabled: false });
  scheduler.configure({ enabled: true }); scheduler.changed(file);
  scheduler.configure({ enabled: false }); scheduler.dispose();
  assert.equal(context.timerCalls.filter(value => value === 'set').length, 1);
  assert.equal(scheduler.automatic, null);
});

/** Advance promise continuations without relying on elapsed wall-clock time. */
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

/** Supply deterministic time and a deferred compiler with the controller's public interface. */
function fixture() {
  let time = 0; let timerId = 0; const timers = new Map(); const calls = [];
  const file = { path: 'a.md' };
  const controller = { target: file, sources: { canonical: file => file.path }, notify() {},
    /** Retain each compiler operation until the test resolves it. */
    compile(file, options) { return new Promise((resolve, reject) => calls.push({ file, options, resolve, reject })); },
    /** Count cancellation requests independently of completion. */
    cancel() { this.cancels = (this.cancels || 0) + 1; },
  };
  const scheduler = new BuildScheduler(controller, { now: () => time,
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, due: time + delay }); return timerId; },
    clearTimer: id => timers.delete(id) });
  /** Run each due timer once in chronological test time. */
  function advance(ms) { time += ms; for (const [id, timer] of timers) if (timer.due <= time) { timers.delete(id); timer.callback(); } }
  return { scheduler, controller, calls, file, advance, timers };
}

test('manual requests queue FIFO while busy and survive automatic mode being off', async () => {
  const value = fixture(); const other = { path: 'b.md' };
  const a = value.scheduler.request(value.file);
  const b = value.scheduler.request(other);
  const c = value.scheduler.request(value.file);
  assert.equal(value.calls.length, 1); assert.equal(value.controller.scheduling.queuedBuilds, 2);
  value.calls[0].resolve('a'); assert.equal(await a, 'a'); await settle();
  assert.equal(value.calls[1].file, other);
  value.calls[1].resolve('b'); assert.equal(await b, 'b'); await settle();
  value.calls[2].resolve('c'); assert.equal(await c, 'c'); await settle();
  assert.equal(value.scheduler.running, null); assert.equal(value.controller.scheduling.queuedBuilds, 0);
});

test('rapid editor and saved events coalesce after a quiet interval and keep the newest follow-up', async () => {
  const value = fixture(); value.scheduler.configure({ enabled: true, delayMs: 600 });
  value.scheduler.changed(value.file); value.advance(400); value.scheduler.changed(value.file);
  value.advance(599); assert.equal(value.calls.length, 0);
  value.advance(1); assert.equal(value.calls.length, 1); assert.equal(value.calls[0].options.skipUnchanged, true);
  value.scheduler.changed(value.file); value.advance(600); assert.equal(value.calls.length, 1);
  value.scheduler.changed(value.file); value.advance(200);
  value.calls[0].resolve('first'); await settle(); assert.equal(value.calls.length, 1);
  value.advance(400); assert.equal(value.calls.length, 2);
  value.calls[1].resolve('latest'); await settle();
});

test('manual work precedes a due automatic follow-up and is never discarded on target switch', async () => {
  const value = fixture(); value.scheduler.configure({ enabled: true, delayMs: 100 });
  value.scheduler.changed(value.file); value.advance(100);
  value.scheduler.changed(value.file); value.advance(100);
  const other = { path: 'b.md' }; const explicit = value.scheduler.request(other);
  value.controller.target = other; value.scheduler.selected();
  value.calls[0].resolve('auto'); await settle();
  assert.equal(value.calls[1].file, other);
  value.calls[1].resolve('manual'); assert.equal(await explicit, 'manual'); await settle();
  assert.equal(value.calls.length, 2);
});

test('disabled mode, unrelated notes and obsolete timers cannot dispatch work', async () => {
  const value = fixture(); value.scheduler.changed(value.file); value.advance(1000); assert.equal(value.calls.length, 0);
  value.scheduler.configure({ enabled: true }); value.scheduler.changed({ path: 'unrelated.md' }); value.advance(1000); assert.equal(value.calls.length, 0);
  value.scheduler.changed(value.file); value.scheduler.configure({ enabled: false }); value.advance(1000); assert.equal(value.calls.length, 0);
  assert.equal(value.timers.size, 0);
});

test('cancel rejects queued requests and removes automatic restarts until a new edit', async () => {
  const value = fixture(); value.scheduler.configure({ enabled: true });
  const active = value.scheduler.request(value.file); const queued = value.scheduler.request(value.file);
  const rejected = assert.rejects(queued, { code: 'BUILD_CANCELLED' });
  value.scheduler.changed(value.file); value.scheduler.cancel(); await rejected;
  assert.equal(value.controller.cancels, 1);
  value.calls[0].resolve('stopped'); await active; await settle(); value.advance(10000);
  assert.equal(value.calls.length, 1);
});

test('rename/deletion rejects stale queued identities, and unload prevents late scheduling', async () => {
  const value = fixture(); const active = value.scheduler.request(value.file); const queued = value.scheduler.request(value.file);
  const rejected = assert.rejects(queued, { code: 'SOURCE_MOVED' });
  value.file.path = 'renamed.md'; value.scheduler.forget(value.file, 'a.md'); await rejected;
  assert.equal(value.controller.cancels, 1);
  value.scheduler.dispose(); value.calls[0].resolve('late'); await active; await settle();
  value.scheduler.changed(value.file); value.advance(10000); assert.equal(value.calls.length, 1);
  await assert.rejects(() => value.scheduler.request(value.file), { code: 'HOST_UNLOADED' });
});

test('reverse review holds new builds until review ends, including a due automatic revision', async () => {
  const value = fixture(); value.scheduler.configure({ enabled: true, delayMs: 100 });
  value.scheduler.held = true; value.scheduler.changed(value.file); value.advance(100);
  const manual = value.scheduler.request(value.file); assert.equal(value.calls.length, 0);
  value.scheduler.held = false; value.scheduler.drain(); assert.equal(value.calls[0].options.skipUnchanged, false);
  value.calls[0].resolve('manual'); await manual; await settle(); assert.equal(value.calls[1].options.skipUnchanged, true);
  value.calls[1].resolve(null); await settle();
});
