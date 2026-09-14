# Working on md2tex Workshop

The CLI and Obsidian adapter share `src/core/`. Keep syntax changes paired with
reverse-conversion tests; preserve ownership, freshness checks and backups.
Read [docs/architecture.md](docs/architecture.md) before changing those boundaries.

- For local setup or user onboarding, read [AGENT_SETUP.md](AGENT_SETUP.md).
- For compiling or diagnosing a note, use [workshop-compile](skills/workshop-compile/SKILL.md).
- For TeX-to-Markdown recovery or linked-target conflicts, use [workshop-roundtrip](skills/workshop-roundtrip/SKILL.md).
- For public file selection or a release candidate, use [workshop-release](skills/workshop-release/SKILL.md).
- For code/test conventions, read [CONTRIBUTING.md](CONTRIBUTING.md).

Keep experiments and test output under project `tmp/`. Preserve user changes
and generated recovery evidence. Scope external writes, tool installation,
plugin deployment and publication to the user's explicit request. Optional AI
must remain outside ordinary compilation and source-write authority.
