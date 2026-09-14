# Optional agent skills

These repository-local skills accompany the code. An assistant can read a
`SKILL.md` directly; no global installation or external service is required.
Paths in the skills resolve inside this checkout. They use the existing CLI
and documentation rather than ship a second implementation.

| Skill | Use it for |
| --- | --- |
| [workshop-compile](workshop-compile/SKILL.md) | Setup checks, compiling a note, interpreting diagnostics and locating outputs |
| [workshop-roundtrip](workshop-roundtrip/SKILL.md) | Fixed TeX targets, reviewed inverse candidates and guarded source apply |
| [workshop-release](workshop-release/SKILL.md) | Public allowlist changes, reproducible source candidates and release handoff |

Example prompt: “Use `skills/workshop-compile/SKILL.md` to compile the quickstart
and show me the resulting PDF path.” For first-time setup, start with
[AGENT_SETUP.md](../AGENT_SETUP.md).

These skills are covered by the project's Apache-2.0 license. They do not
install tools, enable providers, or authorize changes merely by being read.
