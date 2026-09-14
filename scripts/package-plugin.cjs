#!/usr/bin/env node
/**
 * Package the local plugin without deploying it. Existing destinations are refused.
 * Usage from the project root: node scripts/package-plugin.cjs --out-dir tmp/plugin-candidate
 */
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { stagePackage } = require('./lib/plugin-package.cjs');

/** Parse packaging arguments and print one JSON result. */
async function main() {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return console.log('Usage: node scripts/package-plugin.cjs [--out-dir NEW_DIRECTORY]\nDefault: a fresh directory under project tmp/plugin-packages/. No deployment or cleanup.');
  const sourceRoot = path.resolve(__dirname, '..');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const stamp = ['day', 'month', 'year', 'hour', 'minute'].map(type => parts.find(part => part.type === type).value).join('');
  const output = values['out-dir'] || path.join(sourceRoot, 'tmp/plugin-packages', `${stamp}-${randomUUID()}`);
  console.log(JSON.stringify(await stagePackage({ sourceRoot, output }), null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'error', code: error.code || 'PACKAGE_FAILED', message: error.message }));
  process.exitCode = 1;
});
module.exports = { main };
