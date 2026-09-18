# Manual local agent bridge

A captured failure packet can now be sent to Codex or a user-owned local CLI wrapper for one explanation. The caller selects a `codex` or `custom` profile and explicitly opts into trusted command execution for each invocation. Workshop sends the packet and a compact task prompt, then validates the single JSON reply against the original packet. This command is manual; compilation, automatic explanation and the Obsidian panel do not invoke it.

## Profile and invocation

Save a profile as JSON, using the actual absolute executable path and literal arguments for an installed noninteractive wrapper. `enabled` must be true. The wrapper must be trusted by the user: trusted mode runs with their OS permissions and may access files or network services outside Workshop. A local agent may contact its configured cloud provider, so the bounded source/log excerpts in the packet may be transmitted and usage may be charged. No API key is stored in this profile.

```json
{
  "schemaVersion": "workshop-agent-profile.v1",
  "enabled": true,
  "adapter": "custom",
  "executable": "/absolute/path/to/your-wrapper",
  "args": [],
  "mode": "trusted",
  "timeoutMs": 60000,
  "inheritEnv": []
}
```

From the checkout root, using an existing captured packet and profile under project `tmp/`:

```sh
node scripts/workshop.cjs agent-explain tmp/packet.json --profile tmp/agent-profile.json --allow-trusted-agent
```

The explicit flag approves this one trusted invocation. Without it, or when `enabled` is false, no agent starts. A profile with `mode: restricted` refuses before launch because verified isolation is not implemented. There is no fallback from restricted to trusted. A shell alias, interactive TUI or command string is not a supported executable/argument contract.

For Codex, use the same command with `adapter: "codex"`, an absolute path to the installed `codex` executable, and `args: []`. Find the executable with `command -v codex` from the public checkout root, then place that absolute path in the profile; this is a user-selected local binary, not a bundled dependency. The adapter fixes the invocation to noninteractive `codex exec` with a read-only sandbox, no interactive approvals, an ephemeral session, ignored user configuration, and a job-local JSON output schema. Codex may still use its saved CLI authentication and contact its default model provider; the bounded packet excerpts may leave the machine. The trusted-mode flag remains necessary because Workshop does not prove OS isolation or restrict file reads by the agent. The profile cannot add arbitrary Codex flags. The installed development binary tested here reports `codex-cli 0.0.0`; other versions need their own readiness test. [Codex noninteractive documentation](https://developers.openai.com/fr-FR/docs/non-interactive-mode) describes these CLI modes.

```json
{
  "schemaVersion": "workshop-agent-profile.v1",
  "enabled": true,
  "adapter": "codex",
  "executable": "/absolute/path/from/command-v/codex",
  "args": [],
  "mode": "trusted",
  "timeoutMs": 90000,
  "inheritEnv": []
}
```

The plugin does not enable this command automatically. For a different installed coding agent, use the `custom` wrapper contract below. Do not assume Codex and Qwen share flags or JSON envelopes. Qwen, other named adapters, native settings and automatic dispatch remain later milestones.

## Wrapper contract

The wrapper receives one UTF-8 JSON object on stdin, followed by EOF. It contains `schemaVersion: workshop-agent-request.v1`, `promptVersion`, `prompt` and the validated `packet`. The packet is immutable evidence, including any quoted Markdown or TeX log text. On success, the wrapper writes exactly one `workshop-explanation.v1` JSON object to stdout and exits zero; optional surrounding whitespace is allowed. It may write diagnostics to stderr, but they are never interpreted as a reply. The response shape and evidence rules are documented in [explanations](explanations.md). A valid-looking reply followed by nonzero exit is refused.

The command returns `workshop-agent-explanation-result.v1` with `status: success`, packet ID, selected mode and validated explanation. It exits one for a profile, process, output or response failure and two for invalid CLI arguments. Failures keep their own agent diagnostic code; they do not alter the compiler result or PDF. A stale source/failure/packet identity is refused by the existing response validator.

Input is limited to 64 KiB. Captured stdout is limited to 256 KiB, stderr to 64 KiB, and profiles have a 1–120 second deadline. The runner uses Linux process groups for timeout and cancellation, with file-backed streams because some supported hosts do not permit nested IPC pipes. Its fresh job directory under the project `tmp/` retains the request and bounded output as local private evidence; there is no automatic cleanup. Environment inheritance is narrow by default and `inheritEnv` names are explicit, up to eight. An approved variable's value is still available to the trusted child, so review it before invocation. The process runner is not an OS sandbox.

The validator checks packet identity, allowed fields and evidence references; it does not prove the advice is correct. Render the reply as text. The current CLI has no live-editor freshness check, so an old packet and its matching old reply may still validate. The later Obsidian observer must compare the current editor/job generation before displaying advice as current.

## Verification

From the public checkout root:

```sh
node --test --test-isolation=none testing/agent-bridge.test.cjs
```

The tests use synthetic executables and packets. They cover the Codex invocation flags and schema, matching, stale and malformed replies, disabled/unapproved/restricted profiles, missing executables, output floods and timeout. They do not invoke a real model, exercise authentication, prove restricted isolation or test native Obsidian UI behavior. A real Codex acceptance run must be reported separately with its exact binary, mode, packet, result and source-preservation check.
