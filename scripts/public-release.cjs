#!/usr/bin/env node
/**
 * Stage or verify a fresh public source artifact; never initialize Git or publish.
 * Usage from root: node scripts/public-release.cjs export --out-dir tmp/public-candidate
 * Usage from root: node scripts/public-release.cjs verify --out-dir tmp/public-candidate
 */
const path = require('node:path');
const { parseArgs } = require('node:util');
const { exportPublic, verifyPublic } = require('./lib/public-release.cjs');

/** Parse the small release interface and print one result. */
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'out-dir': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('From repository root: node scripts/public-release.cjs export|verify --out-dir FRESH_DIRECTORY\nExport uses release/public-files.json. Verify requires the exact fresh artifact, before tests or git init. No repository is overwritten and nothing is published.'); return; }
  if (positionals.length !== 1 || !['export', 'verify'].includes(positionals[0]) || !values['out-dir']) throw new Error('Expected export|verify --out-dir DIRECTORY; see --help');
  const output = values['out-dir'];
  const result = positionals[0] === 'export' ? await exportPublic({ sourceRoot: path.resolve(__dirname, '..'), output }) : await verifyPublic(output);
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.log(JSON.stringify({ status: 'error', code: error.code || 'PUBLIC_RELEASE_FAILED', message: error.message })); process.exitCode = 1; });
module.exports = { main };
