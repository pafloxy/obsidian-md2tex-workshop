#!/usr/bin/env node
/**
 * Standalone workshop CLI; run from the project root.
 * Usage: node scripts/workshop.cjs build draft.md --out-dir ./tmp/builds
 * Usage: node scripts/workshop.cjs --help
 */
// Keep this guard parseable by older GUI Node installations, before loading the core.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.log(JSON.stringify({ schemaVersion: 'workshop-result.v1', status: 'error', stage: 'environment',
    diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_NODE', message: 'Use Node.js 24 or newer; this process is ' + process.versions.node }] }));
  process.exit(1);
}
const { parseArgs } = require('node:util');
const { doctor, status } = require('../src/core/workshop.cjs');
const { checkout, sync, apply, importTex } = require('../src/core/roundtrip.cjs');
const { capabilities } = require('../src/core/capabilities.cjs');
const { buildLinked: build, setTarget, targetStatus, unlinkTarget, previewTarget, applyTarget } = require('../src/core/targets.cjs');

/** Parse CLI options, call the core, and print one JSON result. */
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    prefer: { type: 'string' }, target: { type: 'string' },
    preview: { type: 'string' },
    'body-only': { type: 'boolean' }, 'managed-group': { type: 'boolean' },
    'out-dir': { type: 'string' }, converter: { type: 'string' },
    python: { type: 'string' }, latexmk: { type: 'string' }, 'timeout-ms': { type: 'string' },
    preamble: { type: 'string' }, engine: { type: 'string' }, 'vault-root': { type: 'string' },
    bib: { type: 'string', multiple: true }, bibliography: { type: 'string' }, support: { type: 'string', multiple: true }, 'no-bib': { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/workshop.cjs build INPUT --out-dir DIR\n       node scripts/workshop.cjs status INPUT --out-dir DIR\n       node scripts/workshop.cjs doctor [options]\n       node scripts/workshop.cjs capabilities\n       node scripts/workshop.cjs tex-target INPUT --target NEW_TEX\n       node scripts/workshop.cjs tex-target-status INPUT\n       node scripts/workshop.cjs tex-target-unlink INPUT\n       node scripts/workshop.cjs tex-target-sync INPUT [--latexmk EXE]\n       node scripts/workshop.cjs tex-target-apply INPUT --preview REPORT\n       node scripts/workshop.cjs worker REQUEST_JSON [--managed-group]\n       node scripts/workshop.cjs tex-checkout INPUT --out-dir DIR [build options]\n       node scripts/workshop.cjs tex-sync SESSION [--prefer md|tex] [--latexmk EXE] [--timeout-ms INTEGER]\n       node scripts/workshop.cjs tex-apply INPUT --preview REPORT\n       node scripts/workshop.cjs tex-import INPUT --out-dir DIR [--body-only]\nBuild options: --preamble FILE --engine pdflatex|xelatex|lualatex --vault-root DIR\n         --bib FILE (repeatable) --no-bib --bibliography none|bibtex|biblatex\n         --support FILE (repeatable)\n         --converter FILE --python EXE --latexmk EXE --timeout-ms INTEGER\nCheckpoints require the local structural converter. Sync previews never overwrite Markdown.\nApply requires a successful unchanged preview and creates a backup; pause editors first.\nImport creates review-only artifacts and does not execute TeX or authorize apply.\nPrints JSON; exit 0 on success, 1 on diagnostic/build failure, 2 on invalid arguments.');
    return;
  }
  const command = positionals[0];
  if (command === 'worker') {
    if (positionals.length !== 2 || Object.keys(values).some(key => key !== 'managed-group')) throw new Error('worker requires REQUEST_JSON and optionally --managed-group');
    const { runWorker } = require('../src/core/jobs.cjs');
    const result = await runWorker(positionals[1], { managedGroup: Boolean(values['managed-group']) });
    process.exitCode = result.result.status === 'success' ? 0 : 1;
    return;
  }
  if (values['managed-group'] && command !== 'tex-target-sync') throw new Error('--managed-group is only valid for worker or tex-target-sync');
  if (command === 'capabilities') {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error('capabilities takes no options');
    console.log(JSON.stringify(await capabilities(), null, 2));
    return;
  }
  const targetCommand = { 'tex-target': setTarget, 'tex-target-status': targetStatus, 'tex-target-unlink': unlinkTarget, 'tex-target-sync': previewTarget, 'tex-target-apply': applyTarget }[command];
  if (targetCommand) {
    const allowed = { 'tex-target': ['target'], 'tex-target-status': [], 'tex-target-unlink': [], 'tex-target-sync': ['latexmk', 'timeout-ms', 'prefer', 'managed-group'], 'tex-target-apply': ['preview'] }[command];
    if (positionals.length !== 2 || Object.keys(values).some(key => !allowed.includes(key)) || (command === 'tex-target' && !values.target) || (command === 'tex-target-apply' && !values.preview)) throw new Error('Invalid linked-target command; see --help');
    const timeoutMs = Number(values['timeout-ms'] || 30000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 || (values.prefer && !['md', 'tex'].includes(values.prefer))) throw new Error('Invalid timeout or reconciliation preference');
    let result;
    try {
      const targetOptions = { input: positionals[1], target: values.target, preview: values.preview, latexmk: values.latexmk, timeoutMs, prefer: values.prefer };
      result = values['managed-group'] ? await require('../src/core/jobs.cjs').managedOperation(processOptions => targetCommand({ ...targetOptions, ...processOptions })) : await targetCommand(targetOptions);
    }
    catch (error) { result = { schemaVersion: 'workshop-target-result.v1', command, status: 'error', diagnostics: [{ code: error.code || 'TARGET_FAILED', message: error.message }] }; }
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'success' ? 0 : 1; return;
  }
  const buildKeys = ['out-dir', 'converter', 'python', 'latexmk', 'timeout-ms', 'preamble', 'engine', 'vault-root', 'bib', 'bibliography', 'support', 'no-bib'];
  const permitted = { 'tex-checkout': buildKeys, 'tex-sync': ['prefer', 'latexmk', 'timeout-ms'], 'tex-apply': ['preview'], 'tex-import': ['out-dir', 'body-only'] }[command];
  if (permitted) for (const key of Object.keys(values)) if (!permitted.includes(key)) throw new Error(`--${key} is not an option for ${command}; see --help.`);
  if (!((['build', 'status', 'tex-checkout', 'tex-import'].includes(command) && positionals.length === 2 && values['out-dir']) || (command === 'doctor' && positionals.length === 1) || (command === 'tex-sync' && positionals.length === 2) || (command === 'tex-apply' && positionals.length === 2 && values.preview))) throw new Error('Expected: build/status/tex-checkout/tex-import INPUT --out-dir DIR, tex-sync SESSION, tex-apply INPUT --preview REPORT, or doctor. See --help.');
  const timeoutMs = Number(values['timeout-ms'] || 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('--timeout-ms must be an integer between 100 and 300000');
  if (values.bib && values['no-bib']) throw new Error('--bib and --no-bib are mutually exclusive');
  if (values.prefer && !['md', 'tex'].includes(values.prefer)) throw new Error('--prefer must be md or tex');
  const options = { input: positionals[1], outDir: values['out-dir'], converter: values.converter, python: values.python, latexmk: values.latexmk, timeoutMs,
    preamble: values.preamble, engine: values.engine, vaultRoot: values['vault-root'], bib: values.bib, noBib: values['no-bib'], bibliography: values.bibliography, support: values.support, prefer: values.prefer, preview: values.preview, bodyOnly: values['body-only'] };
  const result = await ({ build, doctor, status, 'tex-checkout': checkout, 'tex-sync': sync, 'tex-apply': apply, 'tex-import': importTex }[command](options));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'success' && (!result.target || result.target.status !== 'error') ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({ schemaVersion: 'workshop-result.v1', status: 'error', stage: 'arguments', diagnostics: [{ severity: 'error', code: 'INVALID_ARGUMENT', message: error.message }] }, null, 2));
  process.exitCode = 2;
});
