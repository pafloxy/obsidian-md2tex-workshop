/**
 * Keep native PDF rendering and bounded compiler logs inside one Workshop view.
 * Usage: const output = new OutputTabs(api, runtime, view, container);
 * output.update(controller.state()); output.select('log'); output.dispose();
 */
let nextId = 0;

/** Own output identity, asynchronous loading and renderer cleanup behind update/select/dispose. */
class OutputTabs {
  /** Mount stable tab panels; the parent view owns each native renderer component. */
  constructor(api, runtime, owner, container) {
    this.api = api; this.runtime = runtime; this.owner = owner; this.mode = 'pdf';
    this.disposed = false; this.pdfKey = null; this.logKey = null; this.pdfEpoch = 0; this.logEpoch = 0;
    this.pdfStatus = 'empty'; this.logStatus = 'empty'; this.component = null;
    this.window = container.ownerDocument?.defaultView; this.restoreFrame = null; this.pdfPosition = null;
    const id = `md2tex-output-${++nextId}`;
    this.root = container.createDiv({ cls: 'md2tex-workshop-output' });
    const tabs = this.root.createDiv({ cls: 'md2tex-workshop-toolbar md2tex-workshop-output-tabs' });
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Build output');
    this.pdfButton = tabs.createEl('button', { text: 'PDF' });
    this.logButton = tabs.createEl('button', { text: 'Compiler log' });
    this.pdfPanel = this.root.createDiv({ cls: 'md2tex-workshop-output-pdf' });
    this.logPanel = this.root.createEl('pre', { cls: 'md2tex-workshop-log-text' });
    for (const [mode, button, panel] of [['pdf', this.pdfButton, this.pdfPanel], ['log', this.logButton, this.logPanel]]) {
      button.id = `${id}-${mode}-tab`; panel.id = `${id}-${mode}-panel`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      button.addEventListener('click', () => this.select(mode));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'pdf' : event.key === 'End' ? 'log' : mode === 'pdf' ? 'log' : 'pdf';
        this.select(next); (next === 'pdf' ? this.pdfButton : this.logButton).focus();
      });
    }
    this.select('pdf');
  }

  /** Switch visibility without recreating an already-rendered PDF or losing its scroll/zoom. */
  select(mode) {
    if (this.disposed || !['pdf', 'log'].includes(mode)) return;
    const previous = this.mode;
    if (previous === 'pdf' && mode === 'log') {
      const node = this.pdfPanel.querySelector?.('.pdf-viewer-container');
      this.pdfPosition = node ? { node, top: node.scrollTop, left: node.scrollLeft } : null;
    }
    this.mode = mode;
    for (const [name, button, panel] of [['pdf', this.pdfButton, this.pdfPanel], ['log', this.logButton, this.logPanel]]) {
      const selected = mode === name;
      panel.hidden = !selected; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    if (mode === 'pdf') void this.loadPdf(this.pdfStatus === 'error');
    else void this.loadLog(this.logStatus === 'error');
    if (mode === 'pdf' && previous === 'log') this.restorePdfPosition();
  }

  /** Restore viewport offsets after the native viewer responds to becoming visible again. */
  restorePdfPosition() {
    const saved = this.pdfPosition;
    if (!saved) return;
    const epoch = this.pdfEpoch;
    /** Apply only to the same visible artifact, never to a newly mounted PDF. */
    const restore = () => {
      if (this.disposed || this.mode !== 'pdf' || epoch !== this.pdfEpoch || saved.node !== this.pdfPanel.querySelector?.('.pdf-viewer-container')) return;
      saved.node.scrollTop = saved.top; saved.node.scrollLeft = saved.left;
    };
    restore();
    if (this.window?.requestAnimationFrame) {
      this.window.cancelAnimationFrame(this.restoreFrame);
      this.restoreFrame = this.window.requestAnimationFrame(() => {
        restore(); this.restoreFrame = this.window.requestAnimationFrame(() => { this.restoreFrame = null; restore(); });
      });
    }
  }

  /** Follow the selected note's last successful PDF and latest attempt's compiler log. */
  update(state) {
    if (this.disposed) return;
    const source = state.target?.path || '';
    const pdf = source && state.lastSuccess?.artifacts?.pdf;
    const log = source && state.latest?.artifacts?.compilationLog;
    const pdfKey = pdf ? `${source}:${pdf}` : null;
    const logKey = log ? `${source}:${log}` : null;
    if (pdfKey !== this.pdfKey) {
      this.pdfEpoch++; this.releasePdf(); this.pdfKey = pdfKey; this.pdfStatus = 'empty'; this.pdfPanel.empty();
    }
    if (logKey !== this.logKey) { this.logEpoch++; this.logKey = logKey; this.logStatus = 'empty'; this.logPanel.setText(''); }
    if (!pdfKey) this.pdfPanel.setText('Build this note to see its PDF here.');
    if (!logKey) this.logPanel.setText(state.latest?.diagnostics?.length
      ? 'No compiler log for this attempt. See the diagnostics above.' : 'No compiler log for this note yet.');
    if (this.mode === 'pdf') void this.loadPdf(); else void this.loadLog();
  }

  /** Render only the captured successful artifact; obsolete async work can only touch detached DOM. */
  async loadPdf(retry = false) {
    if (this.disposed || !this.pdfKey || (this.pdfStatus !== 'empty' && !(retry && this.pdfStatus === 'error'))) return;
    const epoch = ++this.pdfEpoch; this.pdfStatus = 'loading';
    this.releasePdf(); this.pdfPanel.empty(); this.pdfPanel.setText('Loading PDF…');
    let component;
    try {
      const source = await this.runtime.pdfSource();
      if (this.disposed || epoch !== this.pdfEpoch) return;
      this.pdfPanel.empty();
      const surface = this.pdfPanel.createDiv({ cls: 'md2tex-workshop-pdf-surface' });
      component = this.owner.addChild(new this.api.Component()); this.component = component;
      await this.runtime.renderPdf(source, surface, component);
      if (this.disposed || epoch !== this.pdfEpoch) { component.unload(); return; }
      this.pdfStatus = 'ready';
    } catch (error) {
      if (this.disposed || epoch !== this.pdfEpoch) { component?.unload(); return; }
      this.releasePdf(); this.pdfStatus = 'error';
      this.pdfPanel.setText(`PDF preview unavailable: ${error.message}. Click PDF to retry, or use Open PDF.`);
    }
  }

  /** Read one bounded log per artifact, suppressing late results after note switches or closure. */
  async loadLog(retry = false) {
    if (this.disposed || !this.logKey || (this.logStatus !== 'empty' && !(retry && this.logStatus === 'error'))) return;
    const epoch = ++this.logEpoch; this.logStatus = 'loading'; this.logPanel.setText('Loading compiler log…');
    try {
      const text = await this.runtime.readLog();
      if (this.disposed || epoch !== this.logEpoch) return;
      this.logPanel.setText(text); this.logStatus = 'ready';
    } catch (error) {
      if (this.disposed || epoch !== this.logEpoch) return;
      this.logPanel.setText(`Compiler log unavailable: ${error.message}. Click Compiler log to retry.`); this.logStatus = 'error';
    }
  }

  /** Remove only this output's native renderer, leaving other views and build workers alone. */
  releasePdf() {
    this.window?.cancelAnimationFrame(this.restoreFrame); this.restoreFrame = null; this.pdfPosition = null;
    if (this.component) this.owner.removeChild(this.component); this.component = null;
  }

  /** Invalidate late reads/rendering and release the PDF when the Workshop closes. */
  dispose() { this.disposed = true; this.pdfEpoch++; this.logEpoch++; this.releasePdf(); }
}

module.exports = { OutputTabs };
