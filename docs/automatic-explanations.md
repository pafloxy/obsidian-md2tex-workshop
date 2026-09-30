# Automatic failed-build explanations

The Workshop output area has PDF, Compiler log, and Agent tabs. Assistance is off by default. In Agent, expand Configure assistance, select Local API or Codex, enter the endpoint/model or absolute executable path, and explicitly enable assistance. Automatic explanation is initially selected; turn it off for manual-only calls. Enabling does not explain an old failure; successful, cancelled, and skipped unchanged builds never trigger a call. A new failed build triggers at most one call, independently of how many Workshop views are open.

Local API uses an OpenAI-compatible, non-streaming `/v1/chat/completions` endpoint with strict JSON-schema responses. Only literal HTTP loopback endpoints are accepted; credentials, query strings, fragments, redirects, remote hosts, tool calls, and malformed envelopes are refused. Workshop sends a fixed explanation system prompt plus bounded captured source/log evidence, not the whole vault. The local server may itself forward that evidence to a remote model; review its configuration before enabling it. No API key is accepted or persisted by this feature.

Codex uses the existing trusted local-agent bridge and its fixed noninteractive, read-only invocation. It may use saved authentication and a cloud provider, transmit the bounded packet, and incur usage charges. Workshop does not prove operating-system isolation. Enabling Codex assistance authorizes later calls under the selected automatic/manual policy; it does not authorize source changes. Other named agents and unrestricted custom-provider selection are not included in this panel increment.

## Review, then edit manually

The Agent tab displays running, suggestion, cancelled, or retry status without blocking builds or the other tabs. Replies identify captured Markdown or log line ranges when available. Small corrections appear as red deletion and green addition lines with git-style prefixes. There is no Apply button: make the change in the editor yourself, then Build again. Advice is not proof that a proposed correction compiles. When captured evidence cannot establish a cause, the agent should explain the limitation or ask for human judgment instead of inventing a patch.

The response contract accepts at most three evidence-bound edits. Each `before` must match the exact captured source range, overlapping ranges are refused, and truncated excerpts or log text cannot be patch targets. Tool setup, execution, configuration, and target-publication failures cannot propose source edits. A successful PDF with a refused linked-target update is reported as a publication failure, not a syntax failure. Generation checks and a second live-source capture reject delayed replies after edits, note switches, new builds, disable, cancellation, or unload. Provider failures do not loop automatically; Retry explanation is explicit.

## Reproducible web demo

Run from this feature checkout root with Node 24, local TeX tools, and Poppler already available. No npm packages need installation.

```sh
node scripts/explanation-demo.cjs --agent fixture --port 36697
```

Open `http://127.0.0.1:36697`. The demo builds a valid synthetic note first, then fails on `\fracc` at Markdown line 6 and automatically explains it. Inspect the colored patch, switch to PDF and Compiler log, manually replace `\fracc` with `\frac`, and Build again. Successful rebuilds make no model call. The deterministic fixture is not model-quality evidence.

To emulate the API using an installed local Codex instance, run from the same checkout root:

```sh
node scripts/explanation-demo.cjs --agent codex --codex /absolute/path/to/codex --port 36698
```

The emulator checks the same fixed system prompt and routes the synthetic captured packet through the production Codex bridge; the production API client validates its response. The demo retains notes, builds, request/reply records, and agent process evidence beneath project `tmp/`. Use a fresh scratch run rather than editing retained evidence. Stop the server with Ctrl+C. Codex availability, authentication, and usage are external prerequisites; the fixture route remains available offline.

The browser host loads the current production panel, output tabs, session, and API client. Its editor and lifecycle are host adapters, and its PDF preview is a rendered first-page image rather than Obsidian's native PDF embed. Settings, linked-target navigation, and native editor lifecycle need separate native acceptance; a browser pass does not establish that acceptance.

## Verification

From the checkout root:

```sh
node --test --test-isolation=none --test-concurrency=1 testing/automatic-explanation.test.cjs testing/obsidian-host.test.cjs testing/output-tabs.test.cjs testing/agent-bridge.test.cjs
```

Tests cover exact patches, invalid evidence, stale identities, duplicate dispatch, disabled/success/history behavior, cancellation, silent source changes, startup failures, settings rollback, loopback transport, missing providers, malformed replies, output limits, redirects, tool calls, and deadlines. Real Codex and browser evidence must be recorded separately with the selected executable, actual captured packet, and source-preservation check.
