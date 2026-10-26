/**
 * One explanation lifetime per selected failed build, independently of panel count.
 * Usage: const session = new ExplanationSession({ prepare, dispatch, onChange });
 * session.configure({ enabled: true, automatic: true }); session.observe(controller.state());
 * Providers never receive an editor or source-write callback.
 */
const { validateExplanation, validateFailurePacket } = require('../core/explanation-contract.cjs');

/** Own automatic deduplication, manual retry, cancellation and stale-result refusal. */
class ExplanationSession {
  /** Inject evidence preparation and untrusted provider dispatch. */
  constructor({ prepare, dispatch, onChange = () => {} }) {
    this.prepare = prepare; this.dispatch = dispatch; this.onChange = onChange;
    this.enabled = false; this.automatic = true; this.current = null; this.active = null;
    this.handled = new Set(); this.result = null; this.disposed = false; this.status = 'disabled'; this.message = 'Agent assistance is not configured.';
  }
  /** Expose inert display state without handing the view a provider or mutable packet. */
  state() { return { enabled: this.enabled, automatic: this.automatic, status: this.status, message: this.message, answer: this.result?.answer || null, packet: this.result?.packet || null }; }
  /** Publish only while the session is owned by its runtime. */
  notify() { if (!this.disposed) this.onChange(this.state()); }
  /** Enable configured assistance; changing provider policy revokes the old reply. */
  configure({ enabled = false, automatic = true } = {}) {
    this.cancel(false); this.enabled = enabled === true; this.automatic = automatic === true;
    this.result = null; this.status = this.enabled ? 'idle' : 'disabled';
    this.message = this.enabled ? 'Build a failing revision to explain it.' : 'Agent assistance is not configured.';
    this.notify();
  }
  /** Derive a note/build identity; persisted history has generation zero and cannot auto-launch. */
  identity(state) {
    const failure = state.diagnostic?.failureRecord || state.failureRecord || state.latest;
    return state.target && failure ? { path: state.target.path, generation: state.buildGeneration || 0, failure,
      key: `${state.target.path}:${state.buildGeneration || 0}:${typeof failure === 'string' ? failure : failure.attemptId || ''}` } : null;
  }
  /** Require fresh captured evidence and no running build before dispatch. */
  eligible(state) { return Boolean(state.target && !state.busy && ((state.diagnostic?.failureRecord && state.failureCurrent) || (state.latestCurrent && (state.latest?.status === 'error' || state.latest?.target?.status === 'error')))); }
  /** Observe selected-note changes and launch at most once for each new completed failed build. */
  observe(state) {
    if (this.disposed) return;
    const identity = this.identity(state);
    const changed = identity?.key !== this.current?.identity?.key || identity?.failure !== this.current?.identity?.failure || !this.eligible(state);
    this.current = { state, identity };
    if (changed && (this.active || this.result || ['error', 'cancelled'].includes(this.status))) {
      this.cancel(false); this.result = null; this.status = this.enabled ? 'idle' : 'disabled';
      this.message = state.busy ? 'Build running; waiting for its result.' : state.latest?.status === 'success' && state.latest?.target?.status !== 'error'
        ? 'Build succeeded; no explanation needed.' : 'Draft or build changed; rebuild before explaining it.';
      this.notify();
    }
    if (!identity || !identity.generation || !this.eligible(state) || this.handled.has(identity.key)) return;
    this.handled.add(identity.key);
    if (this.handled.size > 64) this.handled.delete(this.handled.values().next().value);
    const cancelled = state.diagnostic?.code === 'BUILD_CANCELLED' || state.latest?.diagnostics?.some(item => item.code === 'BUILD_CANCELLED');
    if (this.enabled && this.automatic && !cancelled) void this.request().catch(() => {});
  }
  /** Run or retry one current failure; duplicate gestures share the existing promise. */
  request() {
    if (this.active) return this.active.promise;
    if (this.disposed || !this.enabled || !this.current || !this.eligible(this.current.state)) return Promise.resolve(null);
    const identity = this.current.identity;
    const active = { identity, abort: new AbortController(), promise: null };
    this.active = active; this.result = null; this.status = 'running'; this.message = 'Explaining the failed build…';
    active.promise = this.run(active);
    this.notify();
    return active.promise;
  }
  /** Validate locally retained evidence and reply; cancelled or superseded work cannot publish. */
  async run(active) {
    try {
      const packet = validateFailurePacket(await this.prepare(this.current.state, active.abort.signal));
      if (this.active !== active || active.abort.signal.aborted) return null;
      const raw = await this.dispatch(packet, active.abort.signal);
      if (this.active !== active || active.abort.signal.aborted || this.current.identity?.key !== active.identity.key || !this.eligible(this.current.state)) return null;
      const checked = validateFailurePacket(await this.prepare(this.current.state, active.abort.signal));
      if (this.active !== active || active.abort.signal.aborted || checked.packetId !== packet.packetId || this.current.identity?.key !== active.identity.key || !this.eligible(this.current.state)) return null;
      const explanation = validateExplanation(raw?.explanation, packet);
      const answer = Object.freeze({ ...raw, explanation, packetId: packet.packetId });
      this.result = { packet, answer }; this.status = 'success'; this.message = 'Review this suggestion and make the change yourself, then Build again.';
      return answer;
    } catch (error) {
      if (this.active === active && !active.abort.signal.aborted) { this.status = 'error'; this.message = `${error.code || 'AGENT_FAILED'}: ${error.message}. You can retry.`; }
      return null;
    } finally {
      if (this.active === active) {
        this.active = null;
        if (this.status === 'running') { this.status = 'idle'; this.message = 'Draft or build changed; rebuild before explaining it.'; }
        this.notify();
      }
    }
  }
  /** Revoke current work immediately; slow providers cannot block builds or tab switching. */
  cancel(notify = true) {
    this.active?.abort.abort(); this.active = null;
    if (this.status === 'running') { this.status = 'cancelled'; this.message = 'Explanation cancelled. You can retry.'; }
    if (notify) this.notify();
  }
  /** Revoke work and suppress all later UI notifications on plugin unload. */
  dispose() { this.cancel(false); this.disposed = true; }
}

module.exports = { ExplanationSession };
