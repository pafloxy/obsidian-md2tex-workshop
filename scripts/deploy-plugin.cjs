#!/usr/bin/env node
/**
 * Review or explicitly install a staged local package. There is no default target.
 * Usage: node scripts/deploy-plugin.cjs --package tmp/candidate --target tmp/vault/.obsidian/plugins/md2tex-workshop
 * Apply the reviewed plan with --apply --expect-plan SHA256 --backup-dir tmp/fresh-backup.
 * Keep Obsidian/plugin code quiescent during a real installation; this CLI does not reload it.
 */
const { parseArgs } = require('node:util');
const { planInstall, installPackage } = require('./lib/plugin-package.cjs');

/** Parse an explicit destination and review token; default to read-only planning. */
async function main() {
  const { values } = parseArgs({ options: {
    package: { type: 'string' }, target: { type: 'string' }, apply: { type: 'boolean' },
    'expect-plan': { type: 'string' }, 'backup-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return console.log('Usage: node scripts/deploy-plugin.cjs --package DIR --target DIR\nPrints a read-only plan. To install exactly that plan, repeat with:\n  --apply --expect-plan SHA256 --backup-dir NEW_DIRECTORY\nNo target defaults, settings migration, file deletion or plugin reload.');
  if (!values.package || !values.target) throw new Error('--package and --target are required');
  if (!values.apply && (values['expect-plan'] || values['backup-dir'])) throw new Error('--expect-plan/--backup-dir require --apply');
  const options = { packageDir: values.package, target: values.target, expectedPlan: values['expect-plan'], backupDir: values['backup-dir'] };
  console.log(JSON.stringify(values.apply ? await installPackage(options) : await planInstall(options), null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'error', code: error.code || 'INSTALL_FAILED', message: error.message, ...(error.reportPath ? { reportPath: error.reportPath } : {}) }));
  process.exitCode = 1;
});
module.exports = { main };
