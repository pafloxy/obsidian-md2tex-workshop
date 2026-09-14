/**
 * Assemble bibliography resources and placement without rewriting converted blocks.
 * Usage: const { head, tail } = bibliography(config, body, document);
 * Pure policy shared by builds and frozen round-trip preview builds.
 */
const { envelope } = require('./tex-envelope.cjs');

/** Return wrapper insertions while keeping one backend-independent body command. */
function bibliography(config, body, document) {
  const block = document?.children.find(node => node.type === 'bibliography');
  const names = config.dependencies.filter(entry => entry.kind === 'bibliography').map(entry => entry.name);
  const command = /(?<!\\)\\(printbibliography|bibliography|addbibresource)(?![a-zA-Z])/g;
  if (command.test(body)) {
    const visible = envelope(`\\begin{document}\n${body}\n\\end{document}\n`).visibleTex;
    const commands = [...visible.matchAll(new RegExp(command.source, 'g'))];
    if (commands.some(match => match[1] !== 'printbibliography') || commands.length !== (block ? 1 : 0)) {
      throw Object.assign(new Error('Declare bibliography files in YAML or controls and use one [printbibliography] block; raw bibliography commands would compete with Workshop placement.'), { code: 'BIBLIOGRAPHY_OWNERSHIP' });
    }
  }
  if (block && (!names.length || config.bibliographyMode === 'none')) {
    throw Object.assign(new Error('[printbibliography] requires bibliography resources and an enabled bibliography mode.'), { code: 'BIBLIOGRAPHY_RESOURCES_REQUIRED', line: block.line });
  }
  if (!names.length) return { head: '', tail: '', placement: 'none' };
  let head;
  if (config.bibliographyMode === 'biblatex') head = names.map(name => `\\addbibresource{${name}}`).join('\n');
  else {
    const style = /\\bibliographystyle\b/.test(config.visiblePreamble) ? '' : '\\bibliographystyle{plain}\n';
    // Define the same body command for BibTeX. The resource list stays in the frozen wrapper.
    head = `${style}\\newcommand{\\printbibliography}{\\bibliography{${names.map(name => name.replace(/\.bib$/, '')).join(',')}}}`;
  }
  return { head, tail: block ? '' : '\\printbibliography', placement: block ? 'explicit' : 'automatic' };
}

module.exports = { bibliography };
