/**
 * Verify evidence-bound manual patches, bounded API transport and automatic lifetimes.
 * Usage from checkout root: node --test --test-isolation=none testing/automatic-explanation.test.cjs
 * Local HTTP fixtures emulate providers without an AI call or source mutation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFailurePacket } = require('../src/core/failure-packet.cjs');
const { sourceHash } = require('../src/core/protocol.cjs');
const { validateExplanation } = require('../src/core/explanation-contract.cjs');
const { explainWithApi, validateApiProfile } = require('../src/core/explanation-api.cjs');
const { ExplanationSession } = require('../src/obsidian/explanation-session.cjs');
const { prompt } = require('../src/core/agent-dispatch.cjs');

/** Construct captured source and log evidence with one actual mapped error. */
function fixture() {
  const sourceText = '# Draft\n\n![Plot](missing.png)\n';
  const result = { schemaVersion: 'workshop-result.v1', command: 'build', status: 'error', stage: 'preflight', attemptId: 'attempt-1',
    source: { path: '/fixture/draft.md', sha256: sourceHash(sourceText) },
    diagnostics: [{ severity: 'error', stage: 'preflight', code: 'UNSUPPORTED_IMAGE', message: 'Images are unsupported.', path: '/fixture/draft.md', line: 3 }] };
  const packet = createFailurePacket({ result, sourceText, logText: '! Unsupported image\nl.3 image\n' });
  const reply = { schemaVersion: 'workshop-explanation.v2', packetId: packet.packetId, failureId: packet.identity.failureId, sourceHash: packet.identity.sourceHash,
    verdict: 'explained', summary: 'The image on Markdown line 3 uses unsupported syntax.', evidenceIds: ['diagnostic-1', 'source-1'],
    suggestions: [{ text: 'Replace the image with a placeholder, then rebuild.', evidenceIds: ['source-1'] }],
    locations: [{ evidenceId: 'source-1', startLine: 3, endLine: 3, reason: 'Unsupported image syntax.' }],
    edits: [{ evidenceId: 'source-1', startLine: 3, endLine: 3, before: '![Plot](missing.png)', after: 'Figure placeholder.', reason: 'A text placeholder uses supported syntax.' }] };
  const state = { target: { path: 'draft.md' }, latest: result, latestCurrent: true, busy: false, buildGeneration: 1 };
  return { packet, reply, state };
}

/** Create an independently mutable response without mutating the fixture. */
function copy(value) { return JSON.parse(JSON.stringify(value)); }
/** Yield to pending session continuations without arbitrary sleeps. */
async function settle() { await new Promise(resolve => setImmediate(resolve)); }
/** Create a provider barrier for race tests. */
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

test('v2 advice accepts exact source ranges and remains deeply frozen; v1 stays compatible', () => {
  const f = fixture(); const accepted = validateExplanation(f.reply, f.packet);
  assert.equal(accepted.edits[0].before, '![Plot](missing.png)'); assert.ok(Object.isFrozen(accepted.edits[0]));
  const legacy = copy(f.reply); legacy.schemaVersion = 'workshop-explanation.v1'; delete legacy.edits; delete legacy.locations;
  assert.equal(validateExplanation(legacy, f.packet).schemaVersion, 'workshop-explanation.v1');
});

test('invented locations, mismatched/overlapping patches, log edits and command authority are refused', () => {
  const f = fixture();
  for (const mutate of [
    value => { value.locations[0].endLine = 900; },
    value => { value.edits[0].before = 'invented source'; },
    value => { value.edits.push(copy(value.edits[0])); },
    value => { value.edits[0].evidenceId = 'log-1'; },
    value => { value.command = 'touch source.md'; },
    value => { value.sourceHash = '0'.repeat(64); },
  ]) { const response = copy(f.reply); mutate(response); assert.throws(() => validateExplanation(response, f.packet)); }
});

test('automatic failures deduplicate across notifications and manual double-clicks', async () => {
  const f = fixture(); const barrier = deferred(); let calls = 0;
  const session = new ExplanationSession({ prepare: async () => f.packet, dispatch: async () => { calls++; return barrier.promise; } });
  session.configure({ enabled: true }); session.observe(f.state); await settle();
  session.observe(f.state); const one = session.request(); const two = session.request();
  assert.equal(one, two); assert.equal(calls, 1);
  barrier.resolve({ explanation: f.reply }); await one;
  assert.equal(session.state().status, 'success'); assert.equal(session.state().answer.explanation.edits.length, 1);
  session.observe(f.state); await settle(); assert.equal(calls, 1);
});

test('disabled assistance, successful builds and persisted failure history make zero automatic calls', async () => {
  const f = fixture(); let calls = 0;
  const session = new ExplanationSession({ prepare: async () => f.packet, dispatch: async () => { calls++; return { explanation: f.reply }; } });
  session.observe(f.state); await settle(); assert.equal(calls, 0);
  session.configure({ enabled: true }); session.observe(f.state); await settle(); assert.equal(calls, 0, 'enabling does not launch an old failure');
  session.observe({ ...f.state, buildGeneration: 0 }); await settle(); assert.equal(calls, 0, 'history is not a new build');
  session.observe({ ...f.state, buildGeneration: 2, latest: { ...f.state.latest, status: 'success' } }); await settle(); assert.equal(calls, 0);
  session.observe({ ...f.state, buildGeneration: 3, latest: { ...f.state.latest, diagnostics: [{ code: 'BUILD_CANCELLED' }] } }); await settle(); assert.equal(calls, 0, 'user cancellation must not incur an automatic call');
});

test('editing, switching notes, new builds, disabling and unload revoke delayed replies', async () => {
  for (const operation of ['edit', 'switch', 'build', 'disable', 'unload', 'cancel']) {
    const f = fixture(); const barrier = deferred(); let signal;
    const session = new ExplanationSession({ prepare: async () => f.packet, dispatch: async (_packet, value) => { signal = value; return barrier.promise; } });
    session.configure({ enabled: true }); session.observe(f.state); await settle();
    const pending = session.active.promise;
    if (operation === 'edit') session.observe({ ...f.state, latestCurrent: false });
    else if (operation === 'switch') session.observe({ ...f.state, target: { path: 'other.md' }, buildGeneration: 0 });
    else if (operation === 'build') session.observe({ ...f.state, busy: true });
    else if (operation === 'disable') session.configure({ enabled: false });
    else if (operation === 'unload') session.dispose();
    else session.cancel();
    assert.equal(signal.aborted, true, operation);
    barrier.resolve({ explanation: f.reply }); await pending;
    assert.equal(session.state().answer, null, operation);
  }
});

test('provider errors do not repeat automatically; manual retry validates a fresh matching answer', async () => {
  const f = fixture(); let calls = 0;
  const session = new ExplanationSession({ prepare: async () => f.packet, dispatch: async () => { if (++calls === 1) throw new Error('offline'); return { explanation: f.reply }; } });
  session.configure({ enabled: true }); session.observe(f.state); await settle();
  assert.equal(session.state().status, 'error'); session.observe(f.state); await settle(); assert.equal(calls, 1);
  await session.request(); assert.equal(calls, 2); assert.equal(session.state().status, 'success');
});

test('post-provider evidence read rejects a silent source change and leaves no running indicator', async () => {
  const f = fixture(); let reads = 0;
  const session = new ExplanationSession({ prepare: async () => ++reads === 1 ? f.packet : { ...f.packet, packetId: '0'.repeat(64) }, dispatch: async () => ({ explanation: f.reply }) });
  session.configure({ enabled: true, automatic: false }); session.observe(f.state); await session.request();
  assert.equal(reads, 2); assert.equal(session.state().answer, null); assert.equal(session.state().status, 'error');
  assert.equal(session.active, null);
});

/** Start a loopback fixture and always close active connections at test completion. */
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}/v1/chat/completions`;
}

test('local API sends the fixed system prompt and receives a matching bounded reply', async t => {
  const f = fixture(); let captured;
  const endpoint = await server(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    captured = JSON.parse(body);
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.reply) } }] }));
  });
  const answer = await explainWithApi(f.packet, { endpoint, model: 'fixture' });
  assert.equal(captured.messages[0].role, 'system'); assert.equal(captured.messages[0].content, prompt);
  assert.equal(captured.stream, false); assert.equal(captured.response_format.json_schema.strict, true);
  assert.deepEqual(JSON.parse(captured.messages[1].content).packet, f.packet);
  assert.equal(answer.explanation.edits.length, 1);
});

test('API profile refuses remote hosts, credentials and fragments before connecting', () => {
  for (const endpoint of ['https://example.org/api', 'http://127.0.0.1@evil.test/api', 'http://user:secret@127.0.0.1/api', 'http://127.0.0.1/api#x']) {
    assert.throws(() => validateApiProfile({ endpoint, model: 'local' }), { code: 'AGENT_API_PROFILE' });
  }
});

test('API refuses redirects, malformed JSON, tool calls, floods and mismatched replies', async t => {
  const f = fixture();
  for (const kind of ['redirect', 'json', 'tools', 'function', 'utf8', 'flood', 'stale']) {
    const endpoint = await server(t, (_request, response) => {
      if (kind === 'redirect') { response.writeHead(302, { Location: 'http://example.org' }); response.end(); }
      else if (kind === 'json') response.end('not JSON');
      else if (kind === 'tools') response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.reply), tool_calls: [{ name: 'edit' }] } }] }));
      else if (kind === 'function') response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(f.reply), function_call: { name: 'edit' } } }] }));
      else if (kind === 'utf8') response.end(Buffer.from([0xc3, 0x28]));
      else if (kind === 'flood') response.end('x'.repeat(70000));
      else response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...f.reply, packetId: '0'.repeat(64) }) } }] }));
    });
    await assert.rejects(explainWithApi(f.packet, { endpoint, model: 'fixture' }), { code: kind === 'redirect' ? 'AGENT_API_HTTP' : kind === 'flood' ? 'AGENT_OUTPUT_LIMIT' : kind === 'stale' ? 'STALE_EXPLANATION' : 'AGENT_PROTOCOL' });
  }
});

test('API timeout includes stalled response bodies, cancellation and unavailable endpoints', async t => {
  const f = fixture();
  const endpoint = await server(t, (_request, response) => { response.writeHead(200); response.write('{'); });
  await assert.rejects(explainWithApi(f.packet, { endpoint, model: 'fixture', timeoutMs: 1000 }), { code: 'AGENT_TIMEOUT' });
  const abort = new AbortController(); const pending = explainWithApi(f.packet, { endpoint, model: 'fixture' }, { signal: abort.signal }); abort.abort();
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' });
  await assert.rejects(explainWithApi(f.packet, { endpoint: 'http://127.0.0.1:1/chat', model: 'fixture' }), { code: 'AGENT_API_UNAVAILABLE' });
});
