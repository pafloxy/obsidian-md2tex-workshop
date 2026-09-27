#!/usr/bin/env node
/** Experimental scoped embed build; never publishes a linked target or writes Markdown. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createHash } = require('node:crypto');
const { build } = require('../src/core/workshop.cjs');

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function directory(filename) {
  const actual = await fs.realpath(path.resolve(filename));
  if (!(await fs.stat(actual)).isDirectory()) fail('INVALID_SCOPE', `Not a directory: ${filename}`);
  return actual;
}

/** Only path-qualified, standalone embeds participate in this narrow experiment. */
async function prepare({ input, vaultRoot, projectRoot, target }) {
  const vault = await directory(vaultRoot);
  const scope = await directory(projectRoot);
  if (!inside(vault, scope)) fail('SCOPE_OUTSIDE_VAULT', 'Project root must be inside the vault');
  const source = await fs.realpath(path.resolve(input));
  if (!inside(vault, source)) fail('SOURCE_OUTSIDE_VAULT', 'Markdown source must be inside the vault');
  if (!(await fs.stat(source)).isFile()) fail('INVALID_SOURCE', 'Markdown source must be a regular file');
  const parent = await directory(path.dirname(path.resolve(target)));
  const linked = path.join(parent, path.basename(target));
  if (!inside(scope, linked) || path.extname(linked) !== '.tex') fail('TARGET_OUTSIDE_SCOPE', 'Chosen linked TeX must be a .tex file inside the project root');
  const oldTarget = await fs.realpath(linked).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (oldTarget && !inside(scope, oldTarget)) fail('TARGET_OUTSIDE_SCOPE', 'Linked TeX resolves outside the project root');
  const original = await fs.readFile(source, 'utf8');
  const support = new Map();
  const links = [];
  const transformed = [];
  for (const [offset, line] of original.split('\n').entries()) {
    const match = line.match(/^!\[\[([^\]\r\n]+)\]\]$/);
    if (!match) {
      if (line.includes('![[')) fail('UNSUPPORTED_EMBED', `Only standalone path-qualified embeds are supported (line ${offset + 1})`);
      transformed.push(line);
      continue;
    }
    const name = match[1];
    if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..') || !name.includes('/')) {
      fail('UNSUPPORTED_EMBED', `Use an explicit project-relative path without alias, anchor or traversal (line ${offset + 1})`);
    }
    const extension = path.extname(name).toLowerCase();
    if (!['.tex', '.png', '.jpg', '.jpeg', '.pdf'].includes(extension)) fail('UNSUPPORTED_EMBED', `Unsupported scoped embed extension: ${name}`);
    const candidate = path.resolve(scope, name);
    if (!inside(scope, candidate)) fail('RESOURCE_OUTSIDE_SCOPE', `Resource escapes project root: ${name}`);
    let resolved;
    try { resolved = await fs.realpath(candidate); }
    catch (error) { if (error.code === 'ENOENT') fail('RESOURCE_MISSING', `Resource missing in project root: ${name}`); throw error; }
    if (!inside(scope, resolved)) fail('RESOURCE_OUTSIDE_SCOPE', `Resource resolves outside project root: ${name}`);
    if (resolved !== candidate) fail('RESOURCE_SYMLINK', `Resource uses a symlink: ${name}`);
    if (!(await fs.stat(resolved)).isFile()) fail('INVALID_RESOURCE', `Resource is not a file: ${name}`);
    const basename = path.basename(name);
    if (support.has(basename) && support.get(basename) !== resolved) fail('RESOURCE_NAME_COLLISION', `Staged resources share the name ${basename}`);
    support.set(basename, resolved);
    const command = extension === '.tex' ? 'input' : 'includegraphics';
    transformed.push('```{=latex}', `\\${command}{${basename}}`, '```');
    links.push({ line: offset + 1, target: name, source: resolved, stagedAs: basename, command });
  }
  return { source, vault, scope, linked, originalSha256: createHash('sha256').update(original).digest('hex'),
    transformed: transformed.join('\n'), links, support: [...support.values()] };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'vault-root': { type: 'string' }, 'project-root': { type: 'string' }, 'linked-tex': { type: 'string' },
    'out-dir': { type: 'string' }, preamble: { type: 'string' }, latexmk: { type: 'string' }
  } });
  if (positionals.length !== 1 || !values['vault-root'] || !values['project-root'] || !values['linked-tex'] || !values['out-dir']) {
    fail('USAGE', 'Usage: node scripts/scope-experiment.cjs NOTE.md --vault-root DIR --project-root DIR --linked-tex PAPER.tex --out-dir DIR [--preamble FILE]');
  }
  const prepared = await prepare({ input: positionals[0], vaultRoot: values['vault-root'],
    projectRoot: values['project-root'], target: values['linked-tex'] });
  const result = await build({ input: prepared.source, sourceText: prepared.transformed, vaultRoot: prepared.vault,
    outDir: values['out-dir'], support: prepared.support, preamble: values.preamble, latexmk: values.latexmk });
  console.log(JSON.stringify({ experiment: 'scoped-wikilink-resources.v0', status: result.status,
    scope: prepared.scope, linkedTexChecked: prepared.linked, originalSha256: prepared.originalSha256,
    links: prepared.links, build: result }, null, 2));
  if (result.status !== 'success') process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.log(JSON.stringify({ experiment: 'scoped-wikilink-resources.v0', status: 'error',
    diagnostics: [{ code: error.code || 'SCOPE_EXPERIMENT_FAILED', message: error.message }] }, null, 2));
  process.exitCode = 1;
});
module.exports = { prepare };
