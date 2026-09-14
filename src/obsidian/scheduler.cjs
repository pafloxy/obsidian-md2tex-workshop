/**
 * Serialize manual work and debounce automatic builds of the selected/pinned note.
 * Usage: const scheduler = new BuildScheduler(controller); scheduler.configure({ enabled: true });
 * Usage: await scheduler.request(file); scheduler.changed(file); scheduler.dispose();
 */

/** Keep scheduling policy separate from source capture, worker transport and presentation. */
class BuildScheduler {
  /** Inject time for deterministic race tests; timers never own compiler processes. */
  constructor(controller, { now = Date.now, setTimer = (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    this.controller = controller; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.enabled = false; this.delayMs = 600; this.queue = []; this.automatic = null;
    this.running = null; this.timer = null; this.disposed = false; this.held = false;
  }

  /** Publish queue state through the controller's existing observation interface. */
  notify() {
    this.controller.scheduling = { autoBuild: this.enabled, queuedBuilds: this.queue.length, pendingAutoBuild: Boolean(this.automatic), reviewing: this.held };
    this.controller.notify();
  }

  /** Opt in only through the new setting; disabling removes pending automatic work. */
  configure({ enabled = this.enabled, delayMs = this.delayMs } = {}) {
    if (!Number.isInteger(delayMs) || delayMs < 100 || delayMs > 5000) throw new Error('Build debounce must be 100–5000 ms');
    this.enabled = Boolean(enabled); this.delayMs = delayMs;
    if (!this.enabled) { this.automatic = null; this.clearTimer(this.timer); this.timer = null; }
    this.notify(); this.drain();
  }

  /** Preserve each explicit manual request, even while another job is running. */
  request(file) {
    if (this.disposed) return Promise.reject(Object.assign(new Error('Workshop is unloaded'), { code: 'HOST_UNLOADED' }));
    if (this.queue.length >= 32) return Promise.reject(Object.assign(new Error('The manual build queue is full'), { code: 'BUILD_QUEUE_FULL' }));
    const canonical = this.controller.sources.canonical(file);
    const pending = new Promise((resolve, reject) => this.queue.push({ file, canonical, resolve, reject }));
    this.notify(); this.drain();
    return pending;
  }

  /** Coalesce editor/save events only for the current selected or pinned note. */
  changed(file) {
    if (this.disposed || !this.enabled || !this.controller.target) return;
    const canonical = this.controller.sources.canonical(file);
    if (canonical !== this.controller.sources.canonical(this.controller.target)) return;
    this.automatic = { file, canonical, due: this.now() + this.delayMs };
    this.clearTimer(this.timer); this.timer = this.setTimer(() => { this.timer = null; this.drain(); }, this.delayMs);
    this.notify();
  }

  /** A target switch may discard obsolete automatic work, never an explicit request. */
  selected() {
    if (this.automatic && this.automatic.canonical !== this.controller.sources.canonical(this.controller.target)) {
      this.automatic = null; this.clearTimer(this.timer); this.timer = null; this.notify();
    }
  }

  /** Reject queued work whose file was deleted or renamed and stop its active worker. */
  forget(file, oldPath = file.path) {
    const canonical = this.controller.sources.canonical({ path: oldPath });
    for (const job of this.queue.filter(item => item.canonical === canonical)) job.reject(Object.assign(new Error('The queued note moved or was deleted'), { code: 'SOURCE_MOVED' }));
    this.queue = this.queue.filter(item => item.canonical !== canonical);
    if (this.automatic?.canonical === canonical) this.automatic = null;
    if (this.running?.canonical === canonical) this.controller.cancel();
    this.notify();
  }

  /** Run manual FIFO requests before the newest due automatic revision. */
  drain() {
    if (this.disposed || this.running || this.held) return;
    let job = this.queue.shift();
    if (!job && this.automatic) {
      const remaining = this.automatic.due - this.now();
      if (remaining > 0) {
        // Timer arrival and the deadline clock may disagree; retain a wakeup for pending work.
        this.clearTimer(this.timer);
        this.timer = this.setTimer(() => { this.timer = null; this.drain(); }, remaining);
        return;
      }
      job = { ...this.automatic, auto: true }; this.automatic = null;
    }
    if (!job) return;
    this.running = job; this.notify();
    // compile starts capture synchronously before a caller can reveal another leaf.
    void this.controller.compile(job.file, { skipUnchanged: Boolean(job.auto) }).then(job.resolve, job.reject || (() => {})).finally(() => {
      this.running = null; this.notify(); this.drain();
    });
  }

  /** Cancel all requested work explicitly, without allowing an old timer to restart it. */
  cancel() {
    this.clearTimer(this.timer); this.timer = null; this.automatic = null;
    for (const job of this.queue) job.reject(Object.assign(new Error('Queued build cancelled'), { code: 'BUILD_CANCELLED' }));
    this.queue = []; this.controller.cancel(); this.notify();
  }

  /** End scheduling and suppress all future dispatch; controller owns worker cleanup. */
  dispose() { this.disposed = true; this.cancel(); }
}

module.exports = { BuildScheduler };
