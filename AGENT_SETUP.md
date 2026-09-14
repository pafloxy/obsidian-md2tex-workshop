# Agent handoff: get md2tex Workshop running locally

Give an assistant this repository and the following request:

> Read AGENT_SETUP.md, help me obtain this repository locally if needed, check
> its prerequisites, and compile the quickstart in a disposable directory.
> Explain where the PDF and log are. Ask before installing system software or
> applying changes to my notes.

## Procedure

1. Establish the source. If this file is being read on GitHub, use that exact
   repository's clone URL or source ZIP and the user's chosen destination.
   If the repository is already local, inspect its root and current changes.
   Record the selected revision; do not guess another project with a similar name.
   For a Git clone, run from the **chosen parent directory**, replacing both
   placeholders:

   ```sh
   git clone REPOSITORY_URL LOCAL_DIRECTORY
   ```

2. Read [README.md](README.md) and the applicable local instructions. Run the
   following from the **downloaded repository root**:

   ```sh
   node --version
   node scripts/workshop.cjs --help
   node scripts/workshop.cjs doctor
   ```

   Complete this step when the runtime and recipe checks succeed or a specific
   missing prerequisite is identified. No npm installation is needed. Use the
   reported tool paths and errors; request permission before installing tools
   or modifying the user's configuration.
3. Read [the compilation skill](skills/workshop-compile/SKILL.md) and follow
   [the quickstart](examples/quickstart/README.md) through its first build using
   a fresh project-local `tmp/` directory. Report the actual PDF/log paths and
   build status. Do not infer success just from a process exit or an old PDF.
4. If the user requests a round trip, read
   [the round-trip skill](skills/workshop-roundtrip/SKILL.md). Preview first,
   show the concrete change and retain freshness/backup checks. Stop before
   apply until the proposed source edit is accepted and editors are paused.
5. Finish with the local revision, commands run, output paths and any unresolved
   limitation. Distinguish CLI success from native Obsidian behavior. Installing
   or reloading the Obsidian adapter is a separate task.

The [skills directory](skills/README.md) can be read directly. It does not need
installation into a global agent directory, and it grants no additional access.
For code changes, continue from [CONTRIBUTING.md](CONTRIBUTING.md); for a public
release, use [docs/releasing.md](docs/releasing.md).
