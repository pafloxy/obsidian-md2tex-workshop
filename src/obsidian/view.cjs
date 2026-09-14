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
    constructor(leaf) { super(leaf); this.unsubscribe = null; this.output = null; }
    /** Preserve the existing workspace view identifier. */
    getViewType() { return 'md2tex-workshop-view'; }
    /** Return the native tab title. */
    getDisplayText() { return 'md2tex Workshop'; }
    /** Return the native tab icon. */
    getIcon() { return 'file-code'; }
    /** Mount controls once and subscribe this view to the manual controller. */
    async onOpen() {
      const root = this.contentEl;
      root.empty();
      root.addClass('md2tex-workshop-view', 'md2tex-workshop-manual');
      const toolbar = root.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.buildButton = this.button(toolbar, 'Build', () => runtime.build());
      this.cancelButton = this.button(toolbar, 'Cancel', () => runtime.scheduler.cancel());
      this.pinButton = this.button(toolbar, 'Pin note', () => runtime.controller.togglePin());
      this.pdfButton = this.button(toolbar, 'Open PDF', () => runtime.openArtifact('pdf'));
      this.texButton = this.button(toolbar, 'Open generated TeX', () => runtime.openArtifact('tex'));
      const linking = root.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.targetInput = linking.createEl('input', { type: 'text', placeholder: 'New .tex path, relative to this note' });
      this.linkButton = this.button(linking, 'Set TeX target', () => runtime.setLinkedTarget(this.targetInput.value));
      this.linkedButton = this.button(linking, 'Open linked TeX', () => runtime.openLinked());
      this.reverseButton = this.button(linking, 'Preview TeX changes', () => runtime.previewLinked());
      const summary = root.createDiv({ cls: 'md2tex-workshop-summary' });
      this.targetEl = summary.createDiv();
      this.statusEl = summary.createDiv({ cls: 'md2tex-workshop-status' });
      this.revisionEl = summary.createDiv();
      this.linkEl = summary.createDiv();
      this.queueEl = summary.createDiv();
      this.diagnosticEl = root.createEl('pre', { cls: 'md2tex-workshop-diagnostics' });
      const actions = root.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.sourceButton = this.button(actions, 'Go to source', () => runtime.openDiagnostic());
      this.output = new OutputTabs(api, runtime, this, root);
      this.unsubscribe = runtime.controller.subscribe(state => this.render(state));
      await runtime.controller.inspect();
      await runtime.controller.refreshTarget();
    }
    /** Release view subscriptions without cancelling a separately owned build or detaching leaves. */
    async onClose() { this.unsubscribe?.(); this.unsubscribe = null; this.output?.dispose(); }
    /** Add a guarded user action whose asynchronous errors become a concise notice. */
    button(parent, text, action) {
      const element = parent.createEl('button', { text });
      element.addEventListener('click', () => runtime.perform(action));
      return element;
    }
    /** Update labels and controls without recreating PDF tabs or the whole view. */
    render(state) {
      this.targetEl.setText(`Note: ${state.target?.path || 'Select a Markdown note'}`);
      const latest = state.latest;
      const status = state.busy ? `Building ${state.runningTarget} (${state.stage})`
        : state.diagnostic ? state.diagnostic.message : latest ? latest.status === 'success' ? 'Build succeeded' : 'Build needs attention' : 'Ready for a manual build';
      this.statusEl.setText(status);
      this.statusEl.dataset.state = state.diagnostic ? 'error' : state.busy ? 'running' : latest?.status || 'idle';
      this.revisionEl.setText(state.lastSuccess ? state.current ? 'PDF matches the current note.' : 'The last successful PDF is available; the note has changed or has not been checked.' : 'No successful PDF for this note yet.');
      this.buildButton.disabled = !state.target;
      this.buildButton.setText(state.busy || state.reviewing ? 'Queue build' : 'Build');
      this.cancelButton.disabled = !state.busy && !state.queuedBuilds && !state.pendingAutoBuild;
      const link = state.linkedTarget;
      this.linkEl.setText(link?.status === 'error' ? `TeX link: ${link.message}` : link?.linked ? `TeX target: ${link.target}${link.externallyEdited ? ' — external edits; reverse preview required' : link.published ? '' : ' — build to create'}` : 'No fixed TeX target.');
      this.queueEl.setText(`Automatic builds: ${state.autoBuild ? 'on' : 'off'}; queued: ${state.queuedBuilds || 0}${state.pendingAutoBuild ? '; latest edit pending' : ''}${state.reviewing ? '; reverse preview running' : ''}`);
      this.linkButton.disabled = !state.target || state.busy || state.reviewing;
      this.linkedButton.disabled = !link?.published;
      this.reverseButton.disabled = !link?.published || state.busy || state.reviewing;
      this.pinButton.disabled = !state.target;
      this.pinButton.setText(state.pinned ? 'Unpin note' : 'Pin note');
      this.pdfButton.disabled = !state.lastSuccess;
      this.texButton.disabled = !latest?.artifacts?.tex && !state.lastSuccess;
      const diagnostic = state.diagnostic || latest?.diagnostics?.find(item => item.severity === 'error') || latest?.diagnostics?.[0];
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
