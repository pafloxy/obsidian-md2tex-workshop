/**
 * Stable manual-build presentation using injected public Obsidian view classes.
 * Usage: const View = createViewClass(api, runtime); plugin.registerView(type, leaf => new View(leaf));
 */
const { OutputTabs } = require('./output-tabs.cjs');

/** Create a view class without importing Obsidian into the compiler or Node worker. */
function createViewClass(api, runtime) {
  /** Present controller state; compilation and source ownership remain in their modules. */
  return class WorkshopView extends api.ItemView {
    /** Bind a workspace leaf; retain DOM elements across status updates. */
    constructor(leaf) { super(leaf); this.unsubscribe = null; this.output = null; this.agentShownBuild = null; this.agentShownCurrent = null; this.agentShownTarget = null; this.agentBusy = false; this.closed = false; }
    /** Preserve the existing workspace view identifier. */
    getViewType() { return 'md2tex-workshop-view'; }
    /** Return the native tab title. */
    getDisplayText() { return 'md2tex Workshop'; }
    /** Return the native tab icon. */
    getIcon() { return 'file-code'; }
    /** Mount controls once and subscribe this view to the manual controller. */
    async onOpen() {
      this.closed = false;
      const root = this.contentEl;
      root.empty();
      root.addClass('md2tex-workshop-view', 'md2tex-workshop-manual');
      const toolbar = root.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.buildButton = this.button(toolbar, 'Build', () => runtime.build());
      this.linkButton = this.button(toolbar, 'Set TeX target', () => {
        this.controlsEl.open = true;
        this.targetInput.focus?.();
      });
      this.targetEl = root.createDiv({ cls: 'md2tex-workshop-note' });
      this.statusEl = root.createDiv({ cls: 'md2tex-workshop-status' });
      this.statusEl.setAttribute('role', 'status');
      this.revisionEl = root.createDiv({ cls: 'md2tex-workshop-freshness' });
      this.controlsEl = this.disclosure(root, 'Build and TeX controls');
      const controls = this.controlsEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.cancelButton = this.button(controls, 'Cancel', () => runtime.scheduler.cancel());
      this.pinButton = this.button(controls, 'Pin note', () => runtime.controller.togglePin());
      this.pdfButton = this.button(controls, 'Open PDF', () => runtime.openArtifact('pdf'));
      this.texButton = this.button(controls, 'Open generated TeX', () => runtime.openArtifact('tex'));
      this.copyButton = this.button(controls, 'Copy generated TeX', () => runtime.copyGeneratedTex());
      const linking = this.controlsEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.targetInput = linking.createEl('input', { type: 'text', placeholder: 'New .tex path, relative to this note' });
      this.targetInput.setAttribute('aria-label', 'New TeX target path, relative to this note');
      this.saveTargetButton = this.button(linking, 'Use this target', () => runtime.setLinkedTarget(this.targetInput.value));
      this.linkedButton = this.button(linking, 'Open linked TeX', () => runtime.openLinked());
      this.reverseButton = this.button(linking, 'Preview TeX changes', () => runtime.previewLinked());
      this.output = new OutputTabs(api, runtime, this, root);
      this.agentEl = this.disclosure(root, 'Agent explanation');
      this.agentInfoEl = this.agentEl.createDiv({ cls: 'md2tex-workshop-agent-info' });
      const agentActions = this.agentEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.agentGuardButton = this.button(agentActions, 'Check consent guard', () => this.requestExplanation(false));
      this.agentRunButton = this.button(agentActions, runtime.explanationActionLabel || 'Run explanation', () => this.requestExplanation(true));
      this.agentStatusEl = this.agentEl.createDiv({ cls: 'md2tex-workshop-agent-status' });
      this.agentStatusEl.setAttribute('role', 'status');
      this.agentResultEl = this.agentEl.createEl('pre', { cls: 'md2tex-workshop-agent-result' });
      this.detailsEl = this.disclosure(root, 'Details and diagnostics');
      const summary = this.detailsEl.createDiv({ cls: 'md2tex-workshop-summary' });
      this.recipeEl = summary.createDiv();
      this.linkEl = summary.createDiv();
      this.queueEl = summary.createDiv();
      this.diagnosticEl = this.detailsEl.createEl('pre', { cls: 'md2tex-workshop-diagnostics' });
      const actions = this.detailsEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.sourceButton = this.button(actions, 'Go to source', () => runtime.openDiagnostic());
      this.unsubscribe = runtime.controller.subscribe(state => this.render(state));
      await runtime.controller.inspect();
      await runtime.controller.refreshTarget();
    }
    /** Release view subscriptions without cancelling a separately owned build or detaching leaves. */
    async onClose() { this.closed = true; this.unsubscribe?.(); this.unsubscribe = null; this.output?.dispose(); }
    /** Create a native keyboard-accessible disclosure, collapsed by default. */
    disclosure(parent, label) {
      const details = parent.createEl('details', { cls: 'md2tex-workshop-disclosure' });
      details.open = false;
      details.createEl('summary', { text: label });
      return details;
    }
    /** Add a guarded user action whose asynchronous errors become a concise notice. */
    button(parent, text, action) {
      const element = parent.createEl('button', { text });
      element.addEventListener('click', () => runtime.perform(action));
      return element;
    }
    /** Request one read-only explanation; discard replies if the build or editor revision changes. */
    async requestExplanation(allowTrusted) {
      const before = runtime.controller.state();
      const build = before.latest;
      if (this.agentBusy || !runtime.explainFailure || !before.latestCurrent || build?.status !== 'error') return;
      this.agentBusy = true;
      this.agentGuardButton.disabled = this.agentRunButton.disabled = true;
      this.agentStatusEl.setText(allowTrusted ? 'Requesting explanation…' : 'Checking consent guard…');
      this.agentResultEl.setText('');
      try {
        const answer = await runtime.explainFailure({ allowTrusted });
        const after = runtime.controller.state();
        if (this.closed || after.latest !== build || !after.latestCurrent || after.target?.path !== before.target?.path) {
          if (this.closed) return;
          this.agentStatusEl.setText('The note changed; rebuild before explaining it.');
          return;
        }
        if (answer.status === 'refused') this.agentStatusEl.setText(`Refused before agent launch: ${answer.code}`);
        else {
          this.agentStatusEl.setText(`Validated ${answer.explanation.verdict} reply; packet ${answer.packetId.slice(0, 12)}`);
          this.agentResultEl.setText(`${answer.explanation.summary}\n\nSuggestion: ${answer.explanation.suggestions.map(item => item.text).join(' ')}`);
        }
      } catch (error) {
        if (!this.closed) this.agentStatusEl.setText(`Explanation unavailable: ${error.message}`);
      } finally {
        this.agentBusy = false;
        if (!this.closed) this.render(runtime.controller.state());
      }
    }
    /** Update labels and controls without recreating PDF tabs or the whole view. */
    render(state) {
      this.targetEl.setText(`Note: ${state.target?.path || 'Select a Markdown note'}`);
      const latest = state.latest;
      const diagnostic = state.diagnostic || latest?.diagnostics?.find(item => item.severity === 'error') || latest?.diagnostics?.[0];
      const failed = Boolean(state.diagnostic || latest?.status === 'error' || latest?.target?.status === 'error' || state.linkedTarget?.status === 'error');
      const status = state.diagnostic?.message || (latest?.status === 'error' ? diagnostic?.message || 'Build failed; open Details and diagnostics.' : latest?.target?.status === 'error' ? latest.target.message : state.linkedTarget?.message);
      this.statusEl.setText(failed ? String(status || 'Build needs attention.').replace(/\s+/g, ' ') : '');
      this.statusEl.hidden = !failed;
      this.statusEl.title = failed ? String(status || 'Build needs attention.') : '';
      this.statusEl.dataset.state = failed ? 'error' : 'idle';
      this.revisionEl.setText('Showing the last successful PDF; rebuild to check the current note.');
      this.revisionEl.hidden = !state.lastSuccess || state.current;
      const profile = latest?.profile;
      const origin = profile?.origins || {};
      this.recipeEl.setText(profile ? `Last build settings: ${profile.preamblePath.split(/[\\/]/).pop()} (${origin.preamble || 'recorded'}); ${profile.engine} (${origin.engine || 'recorded'}); bibliography ${profile.bibliographyMode} (${origin.bibliography || 'recorded'}), ${(latest.dependencies || []).filter(item => item.kind === 'bibliography').length} file(s) (${origin.bibs || 'recorded'}).` : 'Build to resolve document settings.');
      this.recipeEl.title = profile?.preamblePath || '';
      this.buildButton.disabled = !state.target;
      this.buildButton.setText(state.busy || state.reviewing ? 'Queue build' : 'Build');
      this.cancelButton.disabled = !state.busy && !state.queuedBuilds && !state.pendingAutoBuild;
      const link = state.linkedTarget;
      this.linkEl.setText(link?.status === 'error' ? `TeX link: ${link.message}` : link?.linked ? `TeX target: ${link.target}${link.externallyEdited ? ' — external edits; reverse preview required' : link.published ? '' : ' — build to create'}` : 'No fixed TeX target.');
      this.queueEl.setText(`Automatic builds: ${state.autoBuild ? 'on' : 'off'}; queued: ${state.queuedBuilds || 0}${state.pendingAutoBuild ? '; latest edit pending' : ''}${state.reviewing ? '; reverse preview running' : ''}`);
      this.linkButton.disabled = !state.target || state.busy || state.reviewing;
      this.saveTargetButton.disabled = this.linkButton.disabled;
      this.linkedButton.disabled = !link?.published;
      this.reverseButton.disabled = !link?.published || state.busy || state.reviewing;
      this.pinButton.disabled = !state.target;
      this.pinButton.setText(state.pinned ? 'Unpin note' : 'Pin note');
      this.pdfButton.disabled = !state.lastSuccess;
      this.texButton.disabled = !latest?.artifacts?.tex && !state.lastSuccess;
      this.copyButton.disabled = !state.lastSuccess?.artifacts?.tex;
      this.copyButton.title = state.lastSuccess ? `Copy ${state.target?.path}: ${state.current ? 'current successful build' : 'last successful build; note has changed'}` : 'Build successfully before copying generated TeX';
      const explainable = Boolean(runtime.explainFailure && state.latestCurrent && latest?.status === 'error' && !state.busy && !this.agentBusy);
      this.agentGuardButton.disabled = this.agentRunButton.disabled = !explainable;
      this.agentInfoEl.setText(runtime.explanationDescription || 'Agent assistance is not configured in this plugin build.');
      if (this.agentShownBuild !== latest || this.agentShownCurrent !== state.latestCurrent || this.agentShownTarget !== state.target?.path) {
        this.agentShownBuild = latest;
        this.agentShownCurrent = state.latestCurrent;
        this.agentShownTarget = state.target?.path;
        this.agentResultEl.setText('');
        this.agentStatusEl.setText(!state.latestCurrent && latest ? 'Draft changed; rebuild before explaining it.' : latest?.status === 'success' ? 'Build succeeded; no explanation needed.' : explainable ? 'Current build failed. Request an explanation.' : 'Build a failing revision to explain it.');
      }
      const location = diagnostic?.path || diagnostic?.texFile;
      this.diagnosticEl.setText(diagnostic ? `${!state.diagnostic && !state.latestCurrent ? 'From an earlier or unchecked revision; rebuild for current locations.\n' : ''}${diagnostic.code}: ${diagnostic.message}${location ? `\n${location}${diagnostic.line || diagnostic.texLine ? `:${diagnostic.line || diagnostic.texLine}` : ''}` : ''}` : 'No diagnostics.');
      this.sourceButton.disabled = !state.latestCurrent || !diagnostic?.path || !diagnostic?.line;
      this.output.update(state);
    }
  };
}

/** Display sealed preview text without giving note-mutating plugins a Markdown editor. */
function createReviewClass(api) {
  /** Keep one immutable review snapshot per native tab; applying remains a separate operation. */
  return class WorkshopReview extends api.ItemView {
    /** Capture the exact displayed source and candidate, independently of later previews. */
    constructor(leaf, review) { super(leaf); this.review = review; }
    /** Identify a native review view that cannot become a Markdown build source. */
    getViewType() { return 'md2tex-workshop-review'; }
    /** Mark this tab explicitly as read-only. */
    getDisplayText() { return 'TeX changes (read-only)'; }
    /** Use the native text comparison icon. */
    getIcon() { return 'file-diff'; }
    /** Show plain source text, never interpret candidate content as executable HTML. */
    async onOpen() {
      this.contentEl.empty();
      this.contentEl.createEl('h3', { text: 'TeX changes — review only' });
      if (!this.review) { this.contentEl.createEl('p', { text: 'Create a fresh preview from the Workshop to restore this review.' }); return; }
      this.contentEl.createEl('p', { text: `Source: ${this.review.source}` });
      this.contentEl.createEl('p', { text: 'The source is unchanged. Review this proposal before applying through the guarded CLI.' });
      this.contentEl.createEl('p', { text: `Preview report: ${this.review.report}` });
      this.contentEl.createEl('h4', { text: 'Current Markdown' });
      this.currentEl = this.contentEl.createEl('pre', { cls: 'md2tex-workshop-diagnostics', text: this.review.current });
      this.contentEl.createEl('h4', { text: 'Proposed Markdown' });
      this.candidateEl = this.contentEl.createEl('pre', { cls: 'md2tex-workshop-diagnostics', text: this.review.candidate });
    }
  };
}

module.exports = { createViewClass, createReviewClass };
