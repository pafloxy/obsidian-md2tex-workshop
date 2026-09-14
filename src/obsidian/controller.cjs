/**
 * Manual build state independent of Obsidian views, compiler internals and providers.
 * Usage: const controller = new BuildController({ sourceStore, createClient, configuration });
 * Usage: controller.select(file); await controller.compile(file); controller.dispose();
 */
const { randomUUID } = require('node:crypto');
const { protocolVersion, documentId, validateBuildRequest } = require('../core/protocol.cjs');

/** Keep note ownership, currentness and job lifetime behind a small manual-build interface. */
class BuildController {
  /** Inject source and worker adapters so host behavior can be verified without Obsidian. */
  constructor({ sourceStore, createClient, configuration }) {
    this.sources = sourceStore;
    this.createClient = createClient;
    this.configuration = configuration;
    this.records = new Map();
    this.listeners = new Set();
    this.target = null;
    this.pinned = false;
    this.active = null;
    this.disposed = false;
    this.background = new Set();
  }

  /** Get one note's state; canonical identity remains independent of active focus. */
  record(file) {
    const canonical = this.sources.canonical(file);
    if (!this.records.has(canonical)) this.records.set(canonical, { canonical, file, revision: 0, publication: 0, currentHash: null, latest: null, lastSuccess: null, diagnostic: null, loaded: false });
    return this.records.get(canonical);
  }

  /** Subscribe a view; closing that view removes only its subscription. */
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  /** Publish only while the host owns this controller. */
  notify() { if (!this.disposed) for (const listener of this.listeners) listener(this.state()); }

  /** Expose stable display data without handing the view a compiler or mutable record. */
  state() {
    const record = this.target ? this.record(this.target) : null;
    return { target: this.target, pinned: this.pinned, busy: Boolean(this.active), runningTarget: this.active?.targetPath || null,
      stage: this.active?.stage || null, latest: record?.latest || null, lastSuccess: record?.lastSuccess || null,
      current: Boolean(record?.lastSuccess && record.currentHash === record.lastSuccess.source.sha256),
      latestCurrent: Boolean(record?.latest?.source && record.currentHash === record.latest.source.sha256),
      diagnostic: record?.diagnostic || null, linkedTarget: record?.linkedTarget || null, ...this.scheduling };
  }

  /** Follow a selected Markdown note unless explicitly pinned; opening a PDF changes nothing. */
  select(file, { force = false } = {}) {
    if (this.disposed || !file || (this.pinned && !force)) return;
    this.record(file);
    this.target = file;
    this.notify();
  }

  /** Pin/unpin the current target without starting a build. */
  togglePin() { if (this.target) { this.pinned = !this.pinned; this.notify(); } }

  /** Mark edits, saves and renames as potentially newer; M1 deliberately schedules no builds. */
  invalidate(file) {
    if (this.disposed || !file) return;
    const record = this.record(file);
    record.revision++;
    record.currentHash = null;
    this.notify();
  }

  /** Refresh source currentness without allowing an older asynchronous read to erase an edit. */
  async freshness(record) {
    const revision = record.revision;
    try {
      const source = await this.sources.capture(record.file);
      if (record.revision === revision && source.canonicalPath === record.canonical) record.currentHash = source.sha256;
    } catch { record.currentHash = null; }
  }

  /** Load persisted history on demand, without replacing a newer in-memory build result. */
  async inspect(file = this.target) {
    if (!file || this.disposed) return;
    const record = this.record(file);
    if (record.loaded) return;
    const publication = record.publication;
    const abort = new AbortController();
    this.background.add(abort);
    try {
      const history = await this.createClient(this.configuration()).history(record.canonical, { signal: abort.signal });
      if (this.disposed || publication !== record.publication) return;
      record.latest = history.latestAttempt;
      record.lastSuccess = history.lastSuccess;
      record.loaded = true;
      await this.freshness(record);
    } catch (error) {
      if (!this.disposed && publication === record.publication) record.diagnostic = { code: error.code || 'HISTORY_UNAVAILABLE', message: error.message };
    } finally { this.background.delete(abort); this.notify(); }
  }

  /** Refresh sidecar discovery independently of cached build history or UI focus. */
  async refreshTarget(file = this.target) {
    if (!file || this.disposed) return;
    const record = this.record(file);
    const epoch = record.targetEpoch = (record.targetEpoch || 0) + 1;
    const abort = new AbortController(); this.background.add(abort);
    try {
      const client = this.createClient(this.configuration());
      if (!client.targetCommand) return;
      const value = await client.targetCommand('tex-target-status', record.canonical, { signal: abort.signal });
      if (!this.disposed && record.targetEpoch === epoch) record.linkedTarget = value;
    } catch (error) {
      if (!this.disposed && record.targetEpoch === epoch) record.linkedTarget = { status: 'error', message: error.message };
    } finally { this.background.delete(abort); this.notify(); }
  }

  /** Compile exactly one captured revision; another manual request gets an explicit busy result. */
  async compile(file = this.target, { skipUnchanged = false } = {}) {
    if (this.disposed) throw Object.assign(new Error('Workshop is unloaded'), { code: 'HOST_UNLOADED' });
    if (this.active) throw Object.assign(new Error(`A build of ${this.active.file.path} is running; cancel it or wait before rebuilding`), { code: 'BUILD_BUSY' });
    const record = this.record(file);
    if (!this.target) this.target = file;
    const abort = new AbortController();
    const active = { file, targetPath: file.path, abort, stage: 'capturing' };
    this.active = active;
    record.publication++;
    record.diagnostic = null;
    this.notify();
    try {
      // Capture starts before any UI open/await can move the note out of focus.
      const snapshot = await this.sources.capture(file);
      if (abort.signal.aborted) throw Object.assign(new Error('Build cancelled'), { code: 'BUILD_CANCELLED' });
      const config = this.configuration();
      const requestKey = JSON.stringify([snapshot.sha256, config]);
      if (skipUnchanged && record.requestKey === requestKey) { await this.freshness(record); return null; }
      record.requestKey = requestKey;
      const request = validateBuildRequest({ protocolVersion, kind: 'build', jobId: randomUUID(), documentId: documentId(snapshot.canonicalPath), source: snapshot,
        vaultRoot: this.sources.vaultRoot, outputRoot: config.outputRoot, recipeOverrides: config.recipeOverrides, execution: config.execution });
      const result = await this.createClient(config).invoke(request, { signal: abort.signal,
        /** Keep progress associated with this job even if the visible target changes. */
        onEvent: event => { if (this.active === active && !this.disposed) { active.stage = event.stage; this.notify(); } },
      });
      if (this.disposed || this.active !== active) return result;
      record.publication++;
      record.latest = result.result;
      if (result.result.status === 'success') record.lastSuccess = result.result;
      else if (result.lastSuccessfulResult) record.lastSuccess = result.lastSuccessfulResult;
      record.loaded = true;
      await this.freshness(record);
      await this.refreshTarget(file);
      return result;
    } catch (error) {
      if (!this.disposed) { record.publication++; record.diagnostic = { code: error.code || 'BUILD_FAILED', message: error.message, ...(error.directory ? { directory: error.directory } : {}) }; }
      throw error;
    } finally {
      if (this.active === active) this.active = null;
      this.notify();
    }
  }

  /** Request bounded worker cancellation; the controller remains busy until it actually finishes. */
  cancel() { this.active?.abort.abort(); }

  /** Stop new work and detach observers immediately; in-flight clients perform bounded cleanup. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort.abort();
    for (const abort of this.background) abort.abort();
    this.listeners.clear();
  }
}

module.exports = { BuildController };
