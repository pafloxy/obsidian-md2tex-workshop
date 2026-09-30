/**
 * Stable manual-build presentation using injected public Obsidian view classes.
 * Usage: const View = createViewClass(api, runtime); plugin.registerView(type, leaf => new View(leaf));
 */
const { OutputTabs } = require('./output-tabs.cjs');
const { explanationReview } = require('./explanation-review.cjs');

const patchContextLines = 3;
const patchChangedLineLimit = 400;
const patchChangedByteLimit = 128 * 1024;

/** Split exact text into patch lines while retaining whether its final line is terminated. Usage: splitPatchText('one\n') -> { lines: ['one'], finalNewline: true }. */
function splitPatchText(text) {
  const value = String(text);
  const finalNewline = value.endsWith('\n');
  const lines = value ? value.split('\n') : [];
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

/** Reconstruct one shortest line edit script from a Myers trace. Usage: backtrackLineEdits(trace, ['a'], ['b']) returns delete/add edits. */
function backtrackLineEdits(trace, before, after) {
  let x = before.length;
  let y = after.length;
  const edits = [];
  for (let depth = trace.length - 1; depth >= 0; depth--) {
    const frontier = trace[depth];
    const diagonal = x - y;
    const left = frontier.get(diagonal - 1);
    const right = frontier.get(diagonal + 1);
    const previousDiagonal = diagonal === -depth || (diagonal !== depth && (left ?? -Infinity) < (right ?? -Infinity)) ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      edits.push({ kind: 'context', text: before[x - 1] });
      x--; y--;
    }
    if (depth === 0) break;
    if (x === previousX) {
      edits.push({ kind: 'add', text: after[y - 1] });
      y--;
    } else {
      edits.push({ kind: 'delete', text: before[x - 1] });
      x--;
    }
  }
  return edits.reverse();
}

/** Produce a shortest line edit script with bounded work. Usage: lineEdits(['old'], ['new']) returns one deletion and one addition. */
function lineEdits(before, after) {
  if (!before.length) return after.map(text => ({ kind: 'add', text }));
  if (!after.length) return before.map(text => ({ kind: 'delete', text }));
  const frontier = new Map([[1, 0]]);
  const trace = [];
  const maximum = before.length + after.length;
  for (let depth = 0; depth <= maximum; depth++) {
    trace.push(new Map(frontier));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const left = frontier.get(diagonal - 1);
      const right = frontier.get(diagonal + 1);
      let x = diagonal === -depth || (diagonal !== depth && (left ?? -Infinity) < (right ?? -Infinity)) ? right ?? 0 : (left ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrackLineEdits(trace, before, after);
    }
  }
  throw new Error('Unable to construct the Markdown review diff');
}

/** Format one unified-diff range. Usage: patchRange(4, 1) -> '4'; patchRange(4, 3) -> '4,3'. */
function patchRange(start, count) { return count === 1 ? String(start) : `${start},${count}`; }

/** Create display-only unified patch lines without changing either sealed source. Usage: createUnifiedDiff('old\n', 'new\n').lines renders a standard one-hunk patch. */
function createUnifiedDiff(current, candidate, { context = patchContextLines } = {}) {
  const oldText = splitPatchText(current);
  const newText = splitPatchText(candidate);
  const lines = [
    { kind: 'diff-header', text: 'diff --git a/current.md b/proposed.md' },
    { kind: 'header-delete', text: '--- a/current.md' },
    { kind: 'header-add', text: '+++ b/proposed.md' },
  ];
  let prefix = 0;
  while (prefix < oldText.lines.length && prefix < newText.lines.length && oldText.lines[prefix] === newText.lines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldText.lines.length - prefix && suffix < newText.lines.length - prefix && oldText.lines[oldText.lines.length - suffix - 1] === newText.lines[newText.lines.length - suffix - 1]) suffix++;
  const beforeChanged = oldText.lines.slice(prefix, oldText.lines.length - suffix);
  const afterChanged = newText.lines.slice(prefix, newText.lines.length - suffix);
  const newlineOnly = !beforeChanged.length && !afterChanged.length && oldText.finalNewline !== newText.finalNewline && oldText.lines.length > 0;
  const changedLines = beforeChanged.length + afterChanged.length;
  const changedBytes = Buffer.byteLength(beforeChanged.join('\n'), 'utf8') + Buffer.byteLength(afterChanged.join('\n'), 'utf8');
  if (!newlineOnly && (changedLines > patchChangedLineLimit || changedBytes > patchChangedByteLimit)) {
    lines.push({ kind: 'meta', text: ` Patch too large to display safely (${beforeChanged.length} removed, ${afterChanged.length} added lines).` });
    return { changed: true, tooLarge: true, summary: { removedLines: beforeChanged.length, addedLines: afterChanged.length, changedBytes }, lines };
  }
  let edits;
  if (newlineOnly) {
    const last = oldText.lines.length - 1;
    edits = [
      ...oldText.lines.slice(0, last).map(text => ({ kind: 'context', text })),
      { kind: 'delete', text: oldText.lines[last] },
      { kind: 'add', text: newText.lines[last] },
    ];
  } else {
    edits = [
      ...oldText.lines.slice(0, prefix).map(text => ({ kind: 'context', text })),
      ...lineEdits(beforeChanged, afterChanged),
      ...oldText.lines.slice(oldText.lines.length - suffix).map(text => ({ kind: 'context', text })),
    ];
  }
  let oldLine = 1;
  let newLine = 1;
  for (const edit of edits) {
    edit.oldLine = oldLine;
    edit.newLine = newLine;
    if (edit.kind !== 'add') oldLine++;
    if (edit.kind !== 'delete') newLine++;
  }
  const changed = edits.some(edit => edit.kind !== 'context') || oldText.finalNewline !== newText.finalNewline;
  if (!changed) {
    lines.push({ kind: 'meta', text: ' No Markdown changes.' });
    return { changed, tooLarge: false, lines };
  }
  const changedIndexes = edits.map((edit, index) => edit.kind === 'context' ? -1 : index).filter(index => index >= 0);
  if (!changedIndexes.length) changedIndexes.push(Math.max(0, edits.length - 1));
  const ranges = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(edits.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  for (const range of ranges) {
    const hunk = edits.slice(range.start, range.end);
    const oldCount = hunk.filter(edit => edit.kind !== 'add').length;
    const newCount = hunk.filter(edit => edit.kind !== 'delete').length;
    const first = hunk[0] || { oldLine: 1, newLine: 1 };
    const oldStart = oldCount ? first.oldLine : Math.max(0, first.oldLine - 1);
    const newStart = newCount ? first.newLine : Math.max(0, first.newLine - 1);
    lines.push({ kind: 'hunk', text: `@@ -${patchRange(oldStart, oldCount)} +${patchRange(newStart, newCount)} @@` });
    for (const edit of hunk) {
      const prefixCharacter = edit.kind === 'add' ? '+' : edit.kind === 'delete' ? '-' : ' ';
      lines.push({ kind: edit.kind, text: prefixCharacter + edit.text });
      const oldMissing = edit.kind !== 'add' && edit.oldLine === oldText.lines.length && !oldText.finalNewline;
      const newMissing = edit.kind !== 'delete' && edit.newLine === newText.lines.length && !newText.finalNewline;
      if (oldMissing || newMissing) lines.push({ kind: 'meta', text: '\\ No newline at end of file' });
    }
  }
  return { changed, tooLarge: false, lines };
}

/** Render patch lines as inert text spans whose prefixes remain meaningful without color. Usage: renderUnifiedDiff(pre, createUnifiedDiff(old, next)). */
function renderUnifiedDiff(parent, diff) {
  parent.empty();
  for (const line of diff.lines) parent.createEl('span', { cls: `md2tex-workshop-patch-line md2tex-workshop-patch-${line.kind}`, text: line.text + '\n' });
}

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
      const bibliography = this.controlsEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      bibliography.createEl('span', { text: 'Bibliography:' });
      this.bibInput = bibliography.createEl('textarea', { placeholder: 'references.bib (one vault-relative path per line)' });
      this.bibInput.setAttribute('aria-label', 'Bibliography files, one vault-relative .bib path per line');
      this.bibInput.value = runtime.settings?.bibliographyFiles || '';
      this.bibMode = bibliography.createEl('select');
      this.bibMode.setAttribute('aria-label', 'Bibliography processor');
      for (const [value, label] of [['bibtex', 'BibTeX'], ['biblatex', 'biblatex']]) this.bibMode.createEl('option', { text: label, attr: { value } });
      this.bibMode.value = runtime.settings?.bibliographyMode || 'bibtex';
      this.saveBibButton = this.button(bibliography, 'Use bibliography', () => runtime.setBibliography(this.bibInput.value, this.bibMode.value));
      this.bibStatusEl = this.controlsEl.createDiv({ cls: 'md2tex-workshop-note' });
      this.output = new OutputTabs(api, runtime, this, root);
      this.agentEl = this.output.agentPanel;
      this.agentInfoEl = this.agentEl.createDiv({ cls: 'md2tex-workshop-agent-info' });
      if (runtime.configureExplanation) this.mountAgentConfiguration();
      const agentActions = this.agentEl.createDiv({ cls: 'md2tex-workshop-toolbar' });
      this.agentGuardButton = this.button(agentActions, 'Check consent guard', () => this.requestExplanation(false));
      this.agentRunButton = this.button(agentActions, runtime.explanationActionLabel || 'Run explanation', () => this.requestExplanation(true));
      this.agentCancelButton = this.button(agentActions, 'Cancel explanation', () => runtime.explanations?.cancel());
      this.agentCopyButton = this.button(agentActions, 'Copy agent response', () => runtime.copyExplanation(this.agentDisplayedAnswer, this.agentDisplayedPacket));
      this.agentCopyButton.disabled = true;
      this.agentGuardButton.hidden = Boolean(runtime.explanations);
      this.agentStatusEl = this.agentEl.createDiv({ cls: 'md2tex-workshop-agent-status' });
      this.agentStatusEl.setAttribute('role', 'status');
      this.agentResultEl = this.agentEl.createEl('pre', { cls: 'md2tex-workshop-agent-result' });
      this.agentPatchEl = this.agentEl.createDiv({ cls: 'md2tex-workshop-agent-patches' });
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
    /** Show explicit provider/automatic opt-in inside the Agent tab. Usage: this.mountAgentConfiguration() during view mount. */
    mountAgentConfiguration() {
      const settings = runtime.settings || {};
      const configuration = this.disclosure(this.agentEl, 'Configure assistance');
      this.agentProviderInput = configuration.createEl('select');
      this.agentProviderInput.setAttribute('aria-label', 'Explanation provider');
      for (const [value, label] of [['local-api', 'Local HTTP API'], ['codex', 'Local Codex CLI']]) this.agentProviderInput.createEl('option', { text: label, attr: { value } });
      this.agentProviderInput.value = settings.explanationProvider || 'local-api';
      this.agentFields = {};
      for (const [key, label, fallback] of [
        ['explanationEndpoint', 'Local chat-completions URL', 'http://127.0.0.1:1234/v1/chat/completions'],
        ['explanationModel', 'Local model name', 'local'],
        ['explanationExecutable', 'Codex absolute executable path', ''],
      ]) {
        const field = configuration.createEl('label', { text: label });
        const input = field.createEl('input', { type: 'text' }); input.value = settings[key] ?? fallback; input.setAttribute('aria-label', label);
        this.agentFields[key] = input;
      }
      const automatic = configuration.createEl('label', { text: 'Explain new failed builds automatically' });
      this.agentAutoInput = automatic.createEl('input', { type: 'checkbox' }); this.agentAutoInput.checked = settings.explanationAutomatic !== false;
      configuration.createEl('p', { text: 'Enabling sends captured diagnostic/log excerpts and any mapped syntax lines to the selected provider. Local Codex may contact its cloud provider. Suggested patches are for you to edit manually.' });
      this.button(configuration, 'Enable assistance', async () => {
        await runtime.configureExplanation({ explanationEnabled: true, explanationAutomatic: this.agentAutoInput.checked, explanationProvider: this.agentProviderInput.value,
          ...Object.fromEntries(Object.entries(this.agentFields).map(([key, input]) => [key, input.value])) });
      });
      this.button(configuration, 'Disable assistance', () => runtime.configureExplanation({ explanationEnabled: false }));
    }
    /** Render validated advice as text and evidence-bound red/green display patches, never an Apply action. */
    renderExplanation(answer, packet) {
      this.agentResultEl.setText(''); this.agentPatchEl.empty();
      this.agentDisplayedAnswer = null; this.agentDisplayedPacket = null; this.agentCopyButton.disabled = true;
      if (!answer?.explanation) return;
      const review = explanationReview(answer, packet);
      this.agentDisplayedAnswer = answer; this.agentDisplayedPacket = packet;
      this.agentCopyButton.disabled = typeof runtime.copyExplanation !== 'function';
      this.agentResultEl.setText(review.summary);
      for (const [index, finding] of review.findings.entries()) {
        const card = this.agentPatchEl.createDiv({ cls: 'md2tex-workshop-agent-finding' });
        card.createEl('h4', { text: `Finding ${index + 1} — ${finding.label}` });
        card.createEl('p', { text: finding.reason });
        const context = card.createEl('pre', { cls: 'md2tex-workshop-agent-context' });
        context.setAttribute('aria-label', 'Captured context. Highlighted lines are affected; numbers are absolute source or log lines.');
        for (const line of finding.context.lines) context.createEl('span', { cls: line.affected ? 'md2tex-workshop-agent-fault' : '', text: `${line.affected ? '>' : ' '} ${line.number ?? '…'} | ${line.text}\n` });
        if (finding.context.note) card.createEl('p', { cls: 'md2tex-workshop-agent-manual', text: finding.context.note });
        const edit = finding.edit;
        if (!edit) { card.createEl('p', { text: 'No verified patch for this location. Follow the diagnosis and check manually.' }); continue; }
        card.createEl('p', { text: 'Suggested change — please edit your note:' });
        const pre = card.createEl('pre', { cls: 'md2tex-workshop-patch' });
        pre.setAttribute('aria-label', 'Suggested manual patch. Removed lines start with minus; added lines start with plus.');
        const diff = createUnifiedDiff(edit.before + '\n', edit.after ? edit.after + '\n' : '');
        for (const line of diff.lines) if (line.kind === 'hunk') line.text = line.text.replace(/@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/, (_match, old, oldCount = '', next, nextCount = '') => `@@ -${Number(old) + edit.startLine - 1}${oldCount} +${Number(next) + edit.startLine - 1}${nextCount} @@`);
        renderUnifiedDiff(pre, diff);
      }
      for (const suggestion of review.suggestions) this.agentPatchEl.createEl('p', { text: `Next action: ${suggestion}` });
      this.agentPatchEl.createEl('p', { cls: 'md2tex-workshop-agent-manual', text: review.manual });
    }
    /** Request one read-only explanation; discard replies if the build or editor revision changes. */
    async requestExplanation(allowTrusted) {
      if (runtime.explanations) { this.output.select('agent'); return runtime.explanations.request(); }
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
      const panelBibs = String(runtime.settings?.bibliographyFiles || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
      this.bibStatusEl.setText(panelBibs.length ? `Panel fallback: ${panelBibs.length} .bib file(s), ${runtime.settings.bibliographyMode}. Note YAML takes priority.` : 'No panel bibliography fallback. Note YAML can still select .bib files.');
      this.linkButton.disabled = !state.target || state.busy || state.reviewing;
      this.saveTargetButton.disabled = this.linkButton.disabled;
      this.saveBibButton.disabled = state.busy || state.reviewing;
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
        this.agentPatchEl.empty();
        let agentMessage = 'Build a failing revision to explain it.';
        if (!state.latestCurrent && latest) agentMessage = 'Draft changed; rebuild before explaining it.';
        else if (latest?.status === 'success') agentMessage = 'Build succeeded; no explanation needed.';
        else if (latest?.status === 'error' && !runtime.explainFailure) agentMessage = 'Agent assistance is not configured.';
        else if (explainable) agentMessage = 'Current build failed. Request an explanation.';
        this.agentStatusEl.setText(agentMessage);
      }
      const assistance = state.assistance;
      this.agentCancelButton.disabled = assistance?.status !== 'running';
      if (assistance && runtime.explanations) {
        this.agentInfoEl.setText(assistance.enabled ? `${runtime.settings?.explanationProvider === 'codex' ? 'Codex CLI' : 'Local API'} assistance enabled; automatic explanations ${assistance.automatic ? 'on' : 'off'}.` : 'Agent assistance is not configured. Enable it in Configure assistance.');
        this.agentRunButton.disabled = !assistance.enabled || !runtime.explanations.eligible(state) || assistance.status === 'running';
        this.agentRunButton.setText(assistance.status === 'error' || assistance.status === 'cancelled' ? 'Retry explanation' : assistance.status === 'running' ? 'Explaining…' : 'Explain failed build');
        this.agentStatusEl.setText(assistance.message);
        this.renderExplanation(assistance.answer, assistance.packet);
        this.output.agentButton.setText(assistance.status === 'running' ? 'Agent · working' : assistance.status === 'success' ? 'Agent · suggestion' : assistance.status === 'error' ? 'Agent · retry' : 'Agent');
        if (assistance.status === 'running' && this.agentAutoOpened !== latest) { this.agentAutoOpened = latest; this.output.select('agent'); }
      }
      const location = diagnostic?.path || diagnostic?.texFile;
      this.diagnosticEl.setText(diagnostic ? `${!state.diagnostic && !state.latestCurrent ? 'From an earlier or unchecked revision; rebuild for current locations.\n' : ''}${diagnostic.code}: ${diagnostic.message}${location ? `\n${location}${diagnostic.line || diagnostic.texLine ? `:${diagnostic.line || diagnostic.texLine}` : ''}` : ''}` : 'No diagnostics.');
      this.sourceButton.disabled = !state.latestCurrent || !diagnostic?.path || !diagnostic?.line;
      this.output.update(state);
    }
  };
}

/** Display sealed preview text with one explicit guarded apply action. */
function createReviewClass(api, runtime) {
  /** Keep one immutable review snapshot per native tab; applying remains a separate gesture. */
  return class WorkshopReview extends api.ItemView {
    /** Capture the exact displayed source and candidate, independently of later previews. */
    constructor(leaf, review) { super(leaf); this.review = review; }
    /** Identify a native review view that cannot become a Markdown build source. */
    getViewType() { return 'md2tex-workshop-review'; }
    /** Mark this tab explicitly as a review surface. */
    getDisplayText() { return 'TeX changes (review)'; }
    /** Use the native text comparison icon. */
    getIcon() { return 'file-diff'; }
    /** Replace a stale native review with the exact newly sealed snapshot. */
    setReview(review) { this.review = review; this.render(); }
    /** Show plain source text, never interpret candidate content as executable HTML. */
    async onOpen() { this.render(); }
    /** Render the currently bound immutable review and its matching Apply closure. */
    render() {
      this.contentEl.empty();
      this.contentEl.addClass('md2tex-workshop-review');
      this.contentEl.createEl('h3', { text: 'TeX changes — review before applying' });
      if (!this.review) { this.contentEl.createEl('p', { text: 'Create a fresh preview from the Workshop to restore this review.' }); return; }
      this.contentEl.createEl('p', { text: `Source: ${this.review.source}` });
      this.contentEl.createEl('p', { text: 'The source is unchanged. Applying will recheck the note, TeX, checkpoint, candidate and preview before saving.' });
      this.contentEl.createEl('p', { text: `Preview report: ${this.review.report}` });
      this.contentEl.createEl('h4', { text: 'Markdown patch' });
      this.patchEl = this.contentEl.createEl('pre', { cls: 'md2tex-workshop-patch' });
      this.patchEl.setAttribute('aria-label', 'Unified Markdown patch. Deleted lines start with minus; added lines start with plus.');
      const diff = createUnifiedDiff(this.review.current, this.review.candidate);
      renderUnifiedDiff(this.patchEl, diff);
      if (diff.tooLarge) {
        this.largeChangeEl = this.contentEl.createEl('p', { cls: 'md2tex-workshop-large-change', text: 'This TeX rewrite changes too much Markdown for a responsive patch preview. The full documents are not rendered here. Overwrite remains guarded by the sealed preview, freshness checks, backup, save readback, and linked-state finalization.' });
      } else {
        this.fullEl = this.contentEl.createEl('details', { cls: 'md2tex-workshop-review-full' });
        this.fullEl.createEl('summary', { text: 'Full current and proposed Markdown' });
        this.fullEl.createEl('h4', { text: 'Current Markdown' });
        this.currentEl = this.fullEl.createEl('pre', { cls: 'md2tex-workshop-diagnostics', text: this.review.current });
        this.fullEl.createEl('h4', { text: 'Proposed Markdown' });
        this.candidateEl = this.fullEl.createEl('pre', { cls: 'md2tex-workshop-diagnostics', text: this.review.candidate });
      }
      this.applyButton = this.contentEl.createEl('button', { cls: diff.tooLarge ? 'md2tex-workshop-danger-action' : '', text: diff.tooLarge ? 'Overwrite Markdown with proposed version' : 'Apply to Markdown' });
      if (diff.tooLarge) this.applyButton.setAttribute('aria-label', 'Overwrite Markdown with the sealed proposed version after guarded safety checks');
      this.applyStatusEl = this.contentEl.createDiv({ cls: 'md2tex-workshop-status' });
      this.applyStatusEl.setAttribute('role', 'status');
      this.applyButton.addEventListener('click', async () => {
        if (this.applyButton.disabled) return;
        this.applyButton.disabled = true;
        this.applyStatusEl.setText('Rechecking and applying the reviewed change…');
        try {
          await runtime.applyLinked(this.review);
          this.applyStatusEl.setText('Applied and saved. Linked TeX and Markdown now agree.');
        } catch (error) {
          this.applyStatusEl.setText(`Not applied: ${error.message}`);
          new api.Notice(error.message);
        }
      });
    }
  };
}

module.exports = { createViewClass, createReviewClass, createUnifiedDiff };
