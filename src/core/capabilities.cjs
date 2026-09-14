/**
 * Discover the companion's implemented operations without probing tools or providers.
 * Usage: await capabilities(); or node scripts/workshop.cjs capabilities
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { protocolVersion, sourceHash } = require('./protocol.cjs');

/** Fingerprint shipped code/assets using relative paths so relocation keeps identity stable. */
async function capabilities() {
  const root = path.resolve(__dirname, '../..');
  const files = [];
  /** Collect regular files deterministically without following toolchain symlinks. */
  async function collect(relative) {
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`Symlink in toolchain: ${relative}`), { code: 'UNSAFE_TOOLCHAIN' });
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filename)).sort()) await collect(`${relative}/${name}`);
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(filename);
      files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Non-regular toolchain entry: ${relative}`);
  }
  await collect('scripts/workshop.cjs');
  await collect('src/core');
  await collect('assets');
  return { schemaVersion: 'workshop-capabilities.v1', command: 'capabilities', status: 'success', protocolVersion,
    toolchainFingerprint: sourceHash(JSON.stringify(files)), runtime: { node: process.versions.node, platform: process.platform },
    commands: ['build', 'doctor', 'status', 'tex-checkout', 'tex-sync', 'tex-apply', 'tex-import', 'capabilities', 'worker', 'tex-target', 'tex-target-status', 'tex-target-unlink', 'tex-target-sync', 'tex-target-apply'],
    contracts: ['build-request', 'build-event', 'build-result', 'repair-context', 'repair-proposal'],
    features: { linkedTexTarget: true, editorSnapshotBuild: true, progressEvents: true, cancellation: true, managedWorkerGroup: process.platform === 'linux', editorApply: false, managedRepair: false },
  };
}

module.exports = { capabilities };
