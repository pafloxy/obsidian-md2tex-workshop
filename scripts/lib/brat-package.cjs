/**
 * Produce the three files consumed by standard Obsidian/BRAT installation.
 * Usage: await stageBratPackage({ sourceRoot, output });
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectPackage, freshDirectory, separateDirectories, regularFile } = require('./plugin-package.cjs');

/** Embed the reviewed exact companion tree; never download code at runtime. */
async function stageBratPackage({ sourceRoot, output }) {
  sourceRoot = path.resolve(sourceRoot);
  output = path.resolve(output);
  const { files, record } = await collectPackage(sourceRoot);
  const bootstrap = await regularFile(path.join(sourceRoot, 'src/brat-runtime.cjs'));
  const payload = { schema: 'workshop-embedded.v1', sha256: record.contentSha256,
    files: record.files.map(member => ({ ...member, data: files.get(member.path).toString('base64') })) };
  const main = Buffer.from(`${bootstrap.toString('utf8')}\n${files.get('main.js').toString('utf8')}\nmodule.exports.resolveRuntimeEntry = entry => restoreRuntime(entry, ${JSON.stringify(payload)});\n`);
  const release = new Map([['main.js', main], ['manifest.json', files.get('manifest.json')], ['styles.css', files.get('styles.css')]]);
  for (const tree of ['src', 'assets', 'scripts']) separateDirectories(output, path.join(sourceRoot, tree));
  await freshDirectory(output);
  const members = [];
  for (const [name, bytes] of release) {
    const filename = path.join(output, name);
    await fs.writeFile(filename, bytes, { flag: 'wx' });
    if (!(await regularFile(filename)).equals(bytes)) throw new Error(`Package readback failed: ${name}`);
    members.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { status: 'success', command: 'package', format: 'brat', packageDir: output,
    runtimeSha256: record.contentSha256, files: members };
}

module.exports = { stageBratPackage };
