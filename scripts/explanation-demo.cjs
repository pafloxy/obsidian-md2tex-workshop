#!/usr/bin/env node
/**
 * Run the production panel/session/core against a loopback explanation API.
 * Usage from checkout root: node scripts/explanation-demo.cjs --port 36697 --agent fixture
 * Usage: node scripts/explanation-demo.cjs --agent codex --codex /absolute/path/to/codex
 * The fixture is deterministic; codex sends only synthetic demo evidence to its provider.
 * All editable notes, builds and model evidence stay under this checkout's tmp/.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { parseArgs, promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { build } = require('../src/core/workshop.cjs');
const { sourceHash } = require('../src/core/protocol.cjs');
const { readFailurePacket } = require('../src/core/failure-packet.cjs');
const { validateFailurePacket, validateExplanation } = require('../src/core/explanation-contract.cjs');
const { explainWithAgent, prompt } = require('../src/core/agent-dispatch.cjs');
const { createRuntime } = require('../src/obsidian/plugin.cjs');
const { explanationReview } = require('../src/obsidian/explanation-review.cjs');
const root = path.resolve(__dirname, '..');
const seed = '# Syntax repair draft\n\nThis note tests a manual syntax correction.\n\n$$\n\\fracc{1}{2}=0.5\n$$\n';
const fixedSeed = seed.replace('\\fracc', '\\frac');

/** Encode trusted text as a script literal without allowing a closing script tag. */
function scriptLiteral(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }

/** Emulate a local model from the same evidence-bound schema; never call this a real model reply. */
function fixtureReply(packet) {
  const evidence = packet.evidence.find(item => item.kind === 'source');
  const reply = { schemaVersion: 'workshop-explanation.v2', packetId: packet.packetId, failureId: packet.identity.failureId, sourceHash: packet.identity.sourceHash,
    verdict: 'needs-human', summary: packet.summary, evidenceIds: ['diagnostic-1'], suggestions: [{ text: 'Check the reported diagnostic and rebuild after correcting it.', evidenceIds: ['diagnostic-1'] }], locations: [], edits: [] };
  if (evidence && !evidence.truncated && ['tex', 'unsupported-syntax'].includes(packet.category)) {
    const index = evidence.text.split('\n').findIndex(line => line.includes('\\fracc') || line.startsWith('!['));
    if (index >= 0) {
      const before = evidence.text.split('\n')[index]; const line = evidence.startLine + index;
      const after = before.includes('\\fracc') ? before.replace('\\fracc', '\\frac') : 'Figure placeholder.';
      reply.verdict = 'explained'; reply.summary = before.includes('\\fracc') ? `Markdown line ${line} contains an undefined TeX command: \\fracc. The fraction command is \\frac.` : `The image on Markdown line ${line} is unsupported.`;
      reply.locations = [{ evidenceId: evidence.id, startLine: line, endLine: line, reason: reply.summary }];
      reply.edits = [{ evidenceId: evidence.id, startLine: line, endLine: line, before, after, reason: 'Use the supported syntax, then rebuild.' }];
      reply.suggestions = [{ text: 'Please make the proposed change yourself and click Build.', evidenceIds: [evidence.id] }];
    }
  }
  return validateExplanation(reply, packet);
}

/** Start a bounded loopback host with a production view and automatic explanation session. */
async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '36697' }, agent: { type: 'string', default: 'fixture' }, codex: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('From checkout root: node scripts/explanation-demo.cjs --port 36697 --agent fixture|codex [--codex ABSOLUTE_EXECUTABLE]\nSynthetic demo only. Codex may contact its cloud model provider.');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['fixture', 'codex'].includes(values.agent)) throw new Error('Choose an unprivileged port and fixture or codex agent');
  if (values.agent === 'codex' && (!values.codex || !path.isAbsolute(values.codex))) throw new Error('--codex requires the selected absolute executable path');
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  const scratch = await fs.mkdtemp(path.join(root, 'tmp/automatic-explanation-demo-'));
  const note = path.join(scratch, 'demo.md'); const url = `http://127.0.0.1:${port}`;
  let source = fixedSeed; let generation = 0; let providerCalls = 0; let behavior = 'normal';
  let state = { target: { path: 'demo.md' }, latest: null, lastSuccess: null, current: false, latestCurrent: false, busy: false, buildGeneration: 0 };
  /** Supply a named host type without pretending to be a native Obsidian editor. */
  class MarkdownView {}
  const runtime = createRuntime({ app: { vault: { adapter: { getBasePath: () => scratch } }, workspace: {} }, async saveData() {} }, { MarkdownView }, {
    prepareFailure: async before => {
      const packet = await readFailurePacket(before.latest.artifacts.result);
      if (packet.identity.sourceHash !== sourceHash(source)) throw Object.assign(new Error('Draft changed; rebuild before explaining'), { code: 'STALE_EXPLANATION' });
      return packet;
    },
  });
  runtime.controller.state = () => {
    const assistance = runtime.explanations.state();
    return { ...state, assistance: { ...assistance, review: assistance.answer ? explanationReview(assistance.answer, assistance.packet) : null } };
  };
  /** Notify the same production observer after every demo state transition. */
  function emit() { runtime.explanations.observe(runtime.controller.state()); }
  /** Compile scratch text and retain the last successful PDF through an actual failed attempt. */
  async function compile(text) {
    if (state.busy) throw new Error('A build is already running');
    state.busy = true; state.latestCurrent = false; emit();
    try {
      source = text; await fs.writeFile(note, text);
      state.latest = await build({ input: note, outDir: path.join(scratch, 'builds'), vaultRoot: scratch, timeoutMs: 30000,
        ...(behavior === 'tool-error' ? { latexmk: path.join(scratch, 'missing-latexmk') } : {}) });
      if (state.latest.status === 'success') {
        state.lastSuccess = state.latest;
        await execFile('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1200', '-png', state.latest.artifacts.pdf, path.join(scratch, 'preview')]);
      }
      state.current = state.lastSuccess?.source.sha256 === sourceHash(source); state.latestCurrent = true;
    } finally { state.busy = false; state.buildGeneration = ++generation; emit(); }
    return runtime.controller.state();
  }
  /** Render production view and tabs against a minimal browser-only host adapter. */
  async function html() {
    const css = await fs.readFile(path.join(root, 'styles.css'), 'utf8');
    const viewCode = await fs.readFile(path.join(root, 'src/obsidian/view.cjs'), 'utf8');
    const tabCode = await fs.readFile(path.join(root, 'src/obsidian/output-tabs.cjs'), 'utf8');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Automatic build explanation demo</title><style>
    :root{--background-primary:#202226;--background-modifier-border:#454951;--interactive-normal:#343840;--interactive-hover:#454b56;--interactive-accent:#7c67d9;--text-on-accent:white;--text-normal:#e2e5ea;--text-muted:#a8afb9;--text-error:#ff827b;--font-ui-smaller:12px;color-scheme:dark}body{margin:0;background:#17191d;color:var(--text-normal);font:14px system-ui}header{padding:14px 20px;border-bottom:1px solid #454951}header small{display:block;color:#a8afb9;margin-top:5px}main{display:grid;grid-template-columns:42% 58%;height:calc(100vh - 86px)}textarea#source{resize:none;border:0;border-right:1px solid #454951;background:#202226;color:#e2e5ea;padding:22px;font:15px/1.7 monospace;outline:none}#panel{background:#24272c;overflow:auto}#notice{position:fixed;bottom:18px;left:18px;background:#3e3a59;padding:10px;border-radius:6px}#notice:empty{display:none}img{max-width:100%;height:auto;display:block}button,input,select{font:inherit}${css}
    </style></head><body><header>md2tex Workshop · automatic syntax explanation<small>Provider: ${values.agent === 'fixture' ? 'deterministic local API fixture (no model)' : 'local Codex CLI via API emulator (may use cloud)'} · suggestions are manual · browser PDF uses a page image.</small></header><main><textarea id="source" aria-label="Markdown source"></textarea><div id="panel"></div></main><div id="notice" role="status"></div><script>
    Object.assign(HTMLElement.prototype,{empty(){this.replaceChildren()},addClass(...x){this.classList.add(...x)},setText(x){this.textContent=x},createDiv(x){return this.createEl('div',x)},createEl(tag,o={}){const e=document.createElement(tag);if(o.cls)e.className=o.cls;if(o.text)e.textContent=o.text;for(const k of ['type','placeholder'])if(o[k])e[k]=o[k];for(const [k,v]of Object.entries(o.attr||{}))e.setAttribute(k,v);this.append(e);return e}});
    const Buffer={byteLength:x=>new TextEncoder().encode(x).length};
    const tabs={exports:{}};((module)=>{${tabCode}\n})(tabs);
    const view={exports:{}};((module,require)=>{${viewCode}\n})(view,name=>name==='./explanation-review.cjs'?{explanationReview:()=>state.assistance.review}:tabs.exports);
    let state,subscriber,panel,settings;let sending=false;
    const notify=x=>document.getElementById('notice').textContent=x;
    const request=async(route,data)=>{const r=await fetch(route,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const x=await r.json();if(!r.ok)throw new Error(x.error);return x};
    const emit=()=>subscriber?.(state);
    class Component{unload(){}}
    class ItemView{constructor(){this.contentEl=document.getElementById('panel')}addChild(x){return x}removeChild(x){x.unload()}}
    const runtime={settings:{},controller:{state:()=>state,subscribe(f){subscriber=f;f(state);return()=>subscriber=null},async inspect(){},async refreshTarget(){},togglePin(){state.pinned=!state.pinned;emit()}},
      explanations:{eligible:s=>!s.busy&&s.latestCurrent&&(s.latest?.status==='error'||s.latest?.target?.status==='error'),request:async()=>{const x=await request('/explain',{});state=x.state;emit()},cancel:async()=>{const x=await request('/cancel',{});state=x.state;emit()}},
      configureExplanation:async values=>{const x=await request('/configure',values);runtime.settings=x.settings;state=x.state;emit()},
      copyExplanation:async(answer,packet)=>{const x=await request('/agent-copy',{packetId:packet.packetId});if(state.assistance?.packet?.packetId!==packet.packetId)throw new Error('Response changed; request a fresh explanation');await navigator.clipboard.writeText(x.text);notify('Copied agent response')},
      perform:async f=>{try{return await f()}catch(e){notify(e.message)}},
      build:async()=>{sending=true;state.busy=true;emit();try{state=await request('/build',{text:document.getElementById('source').value});notify(state.latest.status==='success'?'Build succeeded':'Build failed; Agent explains it automatically.')}finally{sending=false;emit()}},
      scheduler:{cancel(){notify('This demo bounds builds at 30 seconds. Cancel explanation is available in Agent.')}},
      copyGeneratedTex:async()=>{await navigator.clipboard.writeText((await request('/tex-text')).text);notify('Copied generated TeX')},
      setBibliography:()=>notify('Bibliography settings are exercised in the native host tests.'),setLinkedTarget:()=>notify('Linked-target controls remain available in the plugin.'),openLinked:()=>notify('Use the plugin for linked TeX.'),previewLinked:()=>notify('Use the plugin for reverse review.'),
      openArtifact:kind=>window.open(kind==='pdf'?'/pdf':'/tex','_blank'),openDiagnostic:()=>document.getElementById('source').focus(),
      pdfSource:async()=>({sourcePath:'demo.md'}),renderPdf:async(s,c)=>{const image=c.createEl('img');image.alt='Actual last successful PDF, page one';image.src='/preview.png?'+Date.now()},readLog:async()=>(await request('/log')).text};
    document.getElementById('source').addEventListener('input',()=>{state.current=false;state.latestCurrent=false;state.assistance={...state.assistance,status:'idle',answer:null,packet:null,message:'Draft changed; rebuild before explaining it.'};emit();void request('/invalidate',{}).catch(e=>notify(e.message))});
    (async()=>{const initial=await request('/state');state=initial.state;runtime.settings=initial.settings;document.getElementById('source').value=initial.source;const View=view.exports.createViewClass({ItemView,Component},runtime);panel=new View();await panel.onOpen();if(state.assistance?.status==='success'||state.assistance?.status==='running')panel.output.select('agent');window.demo={runtime,get state(){return state},panel};
      setInterval(async()=>{if(sending)return;try{const x=await request('/state');const same=state.latestCurrent;state=x.state;if(!same)state.latestCurrent=false;emit()}catch{}},500);
    })().catch(e=>notify(e.message));
    </script></body></html>`;
  }
  /** Handle allowlisted same-origin routes; model emulation sees only the fixed packet request. */
  async function handle(request, response) {
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== url)) throw new Error('Unexpected demo host or origin');
      const route = new URL(request.url, url).pathname;
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Request exceeds 1 MiB'); }
      const data = body ? JSON.parse(body) : {};
      if (route === '/') { response.setHeader('Content-Type', 'text/html'); response.end(await html()); return; }
      let value;
      if (route === '/v1/chat/completions' && request.method === 'POST') {
        if (data.messages?.[0]?.content !== prompt || data.messages?.[0]?.role !== 'system') throw new Error('Expected the fixed explanation system prompt');
        const packet = validateFailurePacket(JSON.parse(data.messages[1].content).packet); providerCalls++;
        await fs.writeFile(path.join(scratch, 'last-api-request.json'), JSON.stringify(data, null, 2));
        if (behavior === 'malformed') value = { choices: [{ message: { content: 'not JSON' } }] };
        else {
          let reply;
          if (values.agent === 'fixture') reply = fixtureReply(packet);
          else {
            const abort = new AbortController(); response.on('close', () => { if (!response.writableEnded) abort.abort(); });
            reply = (await explainWithAgent(packet, { schemaVersion: 'workshop-agent-profile.v1', enabled: true, adapter: 'codex', executable: values.codex, args: [], mode: 'trusted', timeoutMs: 90000, inheritEnv: [] }, { allowTrusted: true, signal: abort.signal, scratchRoot: scratch })).explanation;
          }
          await fs.writeFile(path.join(scratch, 'last-explanation.json'), JSON.stringify(reply, null, 2));
          value = { choices: [{ message: { content: JSON.stringify(reply) } }] };
        }
      } else if (route === '/state') value = { source, settings: runtime.settings, state: runtime.controller.state(), providerCalls, scratch, agent: values.agent };
      else if (route === '/agent-copy' && request.method === 'POST') {
        const current = runtime.explanations.state();
        if (!current.answer || current.packet?.packetId !== data.packetId || !runtime.explanations.eligible(state) || sourceHash(source) !== current.packet.identity.sourceHash) throw new Error('Response or draft changed; request a fresh explanation');
        value = { text: explanationReview(current.answer, current.packet).text };
      }
      else if (route === '/build' && request.method === 'POST') { if (typeof data.text !== 'string' || Buffer.byteLength(data.text) > 256 * 1024) throw new Error('Expected bounded Markdown text'); value = await compile(data.text); }
      else if (route === '/invalidate' && request.method === 'POST') { state.latestCurrent = false; state.current = false; emit(); value = { state: runtime.controller.state() }; }
      else if (route === '/explain' && request.method === 'POST') { if (!runtime.explanations.eligible(state)) throw new Error('Build the current failing revision first'); void runtime.explanations.request(); value = { state: runtime.controller.state() }; }
      else if (route === '/cancel' && request.method === 'POST') { runtime.explanations.cancel(); value = { state: runtime.controller.state() }; }
      else if (route === '/configure' && request.method === 'POST') { await runtime.configureExplanation(data); value = { settings: runtime.settings, state: runtime.controller.state() }; }
      else if (route === '/behavior' && request.method === 'POST') { if (!['normal', 'tool-error', 'malformed'].includes(data.value)) throw new Error('Unknown fixture behavior'); if (state.busy || runtime.explanations.active) throw new Error('Wait for the current operation'); behavior = data.value; value = { behavior }; }
      else if (route === '/log') { const filename = state.latest?.artifacts?.compilationLog; const log = filename ? JSON.parse(await fs.readFile(filename, 'utf8')) : {}; value = { text: [log.stdout, log.stderr].filter(Boolean).join('\n') || 'No compiler log was generated; see the diagnostic.' }; }
      else if (route === '/tex-text') value = { text: await fs.readFile(state.lastSuccess.artifacts.tex, 'utf8') };
      else if (['/pdf', '/tex', '/preview.png'].includes(route)) { const filename = route === '/preview.png' ? path.join(scratch, 'preview.png') : state.lastSuccess?.artifacts?.[route.slice(1)]; if (!filename) throw new Error('Build successfully first'); response.setHeader('Content-Type', route === '/pdf' ? 'application/pdf' : route === '/tex' ? 'text/plain' : 'image/png'); response.end(await fs.readFile(filename)); return; }
      else { response.statusCode = 404; value = { error: 'Unknown route' }; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
    } catch (error) { response.statusCode = 400; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message })); }
  }
  const server = http.createServer(handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await runtime.configureExplanation({ explanationEnabled: true, explanationAutomatic: true, explanationEndpoint: url + '/v1/chat/completions', explanationModel: 'workshop-demo', explanationTimeoutMs: values.agent === 'codex' ? 100000 : 30000 });
  await compile(fixedSeed); await compile(seed);
  await fs.writeFile(path.join(scratch, 'url.txt'), url + '\n');
  console.log(JSON.stringify({ url, scratch, agent: values.agent, initialDiagnostic: state.latest.diagnostics[0].code }));
  /** Close only this demo's runtime and loopback listener on a termination signal. */
  function stop() { runtime.dispose(); server.closeAllConnections(); server.close(); }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, fixtureReply };
