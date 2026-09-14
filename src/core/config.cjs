/**
 * Resolve explicit workshop inputs without reading or changing Obsidian settings.
 * Example: await resolveConfiguration({ preamble: './preamble.tex' });
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const engines = ['pdflatex', 'xelatex', 'lualatex'];
const basicPreamble = path.join(projectRoot, 'assets/preambles/basic-preamble.tex');
const eptcsPreamble = path.join(projectRoot, 'assets/preambles/default-preamble.tex');

/** A configuration failure with a stable diagnostic code and optional path. */
class ConfigurationError extends Error {
  /** Describe a user-correctable configuration error. */
  constructor(code, message, filename) {
    super(message);
    this.code = code;
    this.path = filename;
  }
}

/** Read a required regular file while retaining a useful diagnostic path. */
async function readRequired(filename, kind) {
  try {
    if (!(await fs.stat(filename)).isFile()) throw new Error('Not a regular file');
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`MISSING_${kind}`, `${kind.toLowerCase()} is unavailable: ${filename} (${error.code || error.message})`, filename);
  }
}

/** Resolve a build recipe; only named local files are read. */
async function resolveConfiguration(options, metadata = {}) {
  const vaultRoot = path.resolve(options.vaultRoot || process.cwd());
  const origins = {};
  /** Resolve a document value by presence: YAML, control fallback, then bundled default. */
  function setting(name, key, control, fallback) {
    const origin = Object.hasOwn(metadata, key) ? 'yaml' : control !== undefined ? 'controls' : 'default';
    origins[name] = origin;
    return origin === 'yaml' ? metadata[key] : origin === 'controls' ? control : fallback;
  }
  const selectedPreamble = setting('preamble', 'tex-workshop-preamble', options.preamble, basicPreamble);
  if (typeof selectedPreamble !== 'string' || !selectedPreamble.trim()) throw new ConfigurationError('INVALID_PREAMBLE_PATH', 'The preamble must name a nonempty local file; omit the key to inherit the default');
  const preamblePath = path.resolve(origins.preamble === 'yaml' ? vaultRoot : process.cwd(), selectedPreamble);
  const preamble = await readRequired(preamblePath, 'PREAMBLE');
  const visiblePreamble = preamble.replace(/(?<!\\)%.*$/gm, '');
  if (!/\\documentclass\b/.test(visiblePreamble)) throw new ConfigurationError('PREAMBLE_CLASS_REQUIRED', 'Provide a preamble containing an explicit documentclass; manuscript-only fragments need a standalone wrapper', preamblePath);
  if (/\\(?:begin|end)\{document\}/.test(visiblePreamble)) throw new ConfigurationError('PREAMBLE_DOCUMENT_MARKER', 'The preamble must not contain document begin/end markers', preamblePath);
  const converterMode = options.converter ? 'external' : 'structural';
  const converter = path.resolve(options.converter || path.join(projectRoot, 'src/core/markdown.cjs'));
  const converterSource = await readRequired(converter, 'CONVERTER');
  const engine = setting('engine', 'tex-workshop-engine', options.engine, 'pdflatex');
  if (!engines.includes(engine)) throw new ConfigurationError('INVALID_ENGINE', `Unknown engine: ${engine}; choose ${engines.join(', ')}`);
  const supportDir = path.join(projectRoot, 'assets/support/eptcs');
  const profile = preamblePath === basicPreamble ? 'basic-article' : preamblePath === eptcsPreamble ? 'legacy-eptcs' : 'custom';
  const supportPaths = [...(profile === 'legacy-eptcs' ? (await fs.readdir(supportDir)).sort().map((name) => path.join(supportDir, name)) : []), ...(options.support || []).map((name) => path.resolve(name))];
  const bibFiles = setting('bibs', 'tex-workshop-bibs', options.noBib ? [] : options.bib, []);
  if (!Array.isArray(bibFiles) || bibFiles.some(name => typeof name !== 'string' || !name.trim())) throw new ConfigurationError('INVALID_BIBLIOGRAPHY_PATH', 'Bibliography resources must be nonempty local file paths; use [] for no resources');
  const bibPaths = bibFiles.map(name => path.resolve(origins.bibs === 'yaml' ? vaultRoot : process.cwd(), name));
  const bibliographyMode = setting('bibliography', 'tex-workshop-bibliography', options.bibliography, profile === 'custom' ? 'none' : 'bibtex');
  if (!['none', 'bibtex', 'biblatex'].includes(bibliographyMode)) throw new ConfigurationError('INVALID_BIBLIOGRAPHY_MODE', 'Bibliography mode must be none, bibtex, or biblatex');
  if (bibPaths.length && bibliographyMode === 'none') throw new ConfigurationError('BIBLIOGRAPHY_MODE_REQUIRED', 'Bibliography files require bibtex or biblatex via YAML or --bibliography; use tex-workshop-bibs: [] to disable YAML resources');
  if (/\\(?:bibliography|addbibresource|printbibliography)(?![a-zA-Z])/.test(visiblePreamble)) throw new ConfigurationError('PREAMBLE_OWNS_BIBLIOGRAPHY', 'Declare bibliography files via --bib or note metadata; the CLI owns resource insertion', preamblePath);
  const usesBiblatex = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bbiblatex\b[^}]*\}/.test(visiblePreamble);
  if (bibPaths.length && bibliographyMode === 'biblatex' && !usesBiblatex) throw new ConfigurationError('BIBLATEX_PACKAGE_REQUIRED', 'The biblatex mode requires a preamble that explicitly loads biblatex', preamblePath);
  if (bibPaths.length && bibliographyMode === 'bibtex' && usesBiblatex) throw new ConfigurationError('BIBLIOGRAPHY_MODE_CONFLICT', 'The preamble loads biblatex but the selected mode is bibtex', preamblePath);
  const dependencies = [];
  const names = new Set(['source.md', 'conversion-input.md', 'body.tex', 'document.json', 'source-map.json', 'result.json', 'resolved-config.json', 'conversion.json', 'compilation.json']);
  for (const [kind, files] of [['bibliography', bibPaths], ['support', supportPaths]]) {
    for (const [index, filename] of files.entries()) {
      const name = kind === 'bibliography' ? `bibliography-${String(index + 1).padStart(2, '0')}.bib` : path.basename(filename);
      if (names.has(name) || /^main\./i.test(name) || /[%#{}\\]/.test(name)) throw new ConfigurationError('DEPENDENCY_NAME_COLLISION', `Unsupported or reserved staged filename: ${name}`, filename);
      names.add(name);
      let bytes;
      try { bytes = await fs.readFile(filename); }
      catch (error) { throw new ConfigurationError('MISSING_DEPENDENCY', `Cannot read ${kind}: ${filename} (${error.code})`, filename); }
      dependencies.push({ kind, source: filename, name, bytes });
    }
  }
  return { vaultRoot, preamblePath, preamble, converter, converterMode, converterSource, engine, dependencies, bibliographyMode, visiblePreamble,
    profile, origins,
    python: options.python || 'python3', latexmk: options.latexmk || 'latexmk', timeoutMs: options.timeoutMs || 30000 };
}

module.exports = { ConfigurationError, readRequired, resolveConfiguration };
