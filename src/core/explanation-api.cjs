/**
 * Bounded local OpenAI-compatible HTTP transport for explanation-only replies.
 * Usage: await explainWithApi(packet, { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local', timeoutMs: 30000 });
 * No credentials, SDK, redirects, tool calls, compiler or source writer.
 */
const http = require('node:http');
const { validateFailurePacket, validateExplanation } = require('./explanation-contract.cjs');
const { explanationSchema } = require('./agent-adapters.cjs');
const { prompt } = require('./agent-dispatch.cjs');

/** Raise a transport error without printing a provider response or request. */
function fault(code, message) { return Object.assign(new Error(message), { code }); }

/** Validate a literal loopback endpoint and bounded model/deadline before connecting. Usage: validateApiProfile({ endpoint, model, timeoutMs }). */
function validateApiProfile(profile) {
  let url;
  try { url = new URL(profile?.endpoint); } catch { throw fault('AGENT_API_PROFILE', 'Enter a local HTTP chat-completions endpoint.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw fault('AGENT_API_PROFILE', 'Use an HTTP loopback endpoint without credentials, query or fragment.');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (typeof profile.model !== 'string' || !profile.model.trim() || Buffer.byteLength(profile.model) > 200 || /[\x00-\x1f]/.test(profile.model)) throw fault('AGENT_API_PROFILE', 'Enter a bounded local model name.');
  const timeoutMs = profile.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fault('AGENT_API_PROFILE', 'Explanation timeout must be 1000–120000 ms.');
  return Object.freeze({ endpoint: url.href, model: profile.model, timeoutMs });
}

/** POST one fixed system prompt and captured packet; accept a single bounded validated reply. Usage: explainWithApi(packet, profile, { signal }). */
async function explainWithApi(rawPacket, rawProfile, { signal } = {}) {
  const packet = validateFailurePacket(rawPacket);
  const profile = validateApiProfile(rawProfile);
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Explanation cancelled before connecting.');
  const body = JSON.stringify({ model: profile.model, stream: false, messages: [
    { role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ packet }) },
  ], response_format: { type: 'json_schema', json_schema: { name: 'workshop_explanation', strict: true, schema: explanationSchema } } });
  if (Buffer.byteLength(body) > 64 * 1024) throw fault('AGENT_INPUT_LIMIT', 'Explanation request exceeds 64 KiB.');
  const deadline = Date.now() + profile.timeoutMs;
  const raw = await new Promise((resolve, reject) => {
    let settled = false;
    let response;
    const request = http.request(profile.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    /** Settle once and release every deadline/abort listener, including a stalled response. */
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { response?.destroy(); request.destroy(); reject(error); } else resolve(value);
    }
    /** Revoke acceptance on caller cancellation even after headers have arrived. */
    function abort() { finish(fault('AGENT_CANCELLED', 'Explanation cancelled.')); }
    const timer = setTimeout(() => finish(fault('AGENT_TIMEOUT', 'Local explanation API exceeded its deadline.')), profile.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', () => finish(fault('AGENT_API_UNAVAILABLE', 'Cannot reach the configured local explanation API.')));
    request.on('response', incoming => {
      response = incoming;
      if (incoming.statusCode !== 200) { finish(fault('AGENT_API_HTTP', `Local explanation API returned HTTP ${incoming.statusCode}; redirects are refused.`)); return; }
      const chunks = []; let bytes = 0;
      incoming.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) finish(fault('AGENT_OUTPUT_LIMIT', 'Local API response exceeds 64 KiB.'));
        else chunks.push(chunk);
      });
      incoming.on('error', () => finish(fault('AGENT_API_UNAVAILABLE', 'Local API response ended unexpectedly.')));
      incoming.on('end', () => {
        try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { finish(fault('AGENT_PROTOCOL', 'Local API response must be valid UTF-8 JSON.')); }
      });
    });
    if (signal?.aborted) abort(); else request.end(body);
  });
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Explanation cancelled.');
  if (Date.now() >= deadline) throw fault('AGENT_TIMEOUT', 'Local explanation API exceeded its deadline.');
  let reply;
  try {
    const envelope = JSON.parse(raw);
    if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1 || envelope.choices[0].message?.tool_calls || envelope.choices[0].message?.function_call || envelope.choices[0].message?.refusal) throw new Error();
    const content = envelope.choices[0].message?.content;
    if (typeof content !== 'string') throw new Error();
    reply = JSON.parse(content);
  } catch { throw fault('AGENT_PROTOCOL', 'Local API must return one JSON explanation in choices[0].message.content.'); }
  const explanation = validateExplanation(reply, packet);
  if (signal?.aborted) throw fault('AGENT_CANCELLED', 'Explanation cancelled.');
  if (Date.now() >= deadline) throw fault('AGENT_TIMEOUT', 'Local explanation API exceeded its deadline.');
  return Object.freeze({ schemaVersion: 'workshop-agent-explanation-result.v1', command: 'agent-explain', status: 'success', mode: 'local-api', packetId: packet.packetId, explanation });
}

module.exports = { validateApiProfile, explainWithApi };
