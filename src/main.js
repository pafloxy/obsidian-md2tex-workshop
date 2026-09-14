/**
 * Thin desktop plugin entry; install the complete staged directory including toolchain/.
 * Usage: load md2tex-workshop through Obsidian after the agreed installation window.
 */
const api = require('obsidian');
const path = require('node:path');
const { createRequire } = require('node:module');

/** Delegate host behavior to the packaged companion while keeping Obsidian imports at this entry. */
module.exports = class Md2TexWorkshopPlugin extends api.Plugin {
  /** Load the full-directory companion relative to this plugin, independent of process cwd. */
  async onload() {
    const base = this.app.vault.adapter.getBasePath();
    const entry = path.join(base, this.manifest.dir, 'main.js');
    const load = createRequire(entry);
    // Obsidian reloads this entry; Node retains companion modules across plugin lifecycles.
    const companion = path.join(path.dirname(entry), 'toolchain') + path.sep;
    for (const filename of Object.keys(load.cache)) {
      if (filename.startsWith(companion)) delete load.cache[filename];
    }
    const { createRuntime } = load('./toolchain/src/obsidian/plugin.cjs');
    this.runtime = createRuntime(this, api, {
      /** Open generated TeX only after an explicit user action. */
      openPath(filename) { return require('electron').shell.openPath(filename); },
    });
    await this.runtime.start();
  }
  /** Cancel owned work without detaching user workspace leaves. */
  onunload() { this.runtime?.dispose(); }
};
