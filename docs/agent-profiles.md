# Local agent profiles

A profile connects a machine's native runtime settings to an existing gild
agent label. Profiles live in `~/.gild/agents/<name>.json` (0600, directory 0700).
Approved identities and scoped tokens stay in the existing credential store,
`~/.config/gild/agents` (or the explicit `--config-dir`). Profile commands never
read or copy those credentials. A profile JSON accepts only the fields below;
unknown fields, including token/secret fields, are rejected before writing.

```sh
gild agent add ava --runtime claude --model claude-opus-5-5 --effort high --dir /path/to/repo
gild agent edit ava --arg=--resume --arg 'native session id'
gild agent ls --json
gild spawn agent ava --continue
gild sessions
gild send ava 'Please review the diff'
gild agent rm ava
```

`agent ls` lists runtime profiles. The existing `agent list`, `join`, and
`token` commands continue to manage approved forge identities. Removing a
profile leaves those credentials intact. Add fails if the name exists; edit
fails if it does not. `--file <json>` imports/replaces a complete profile with
the matching name. A directory given via `--dir` becomes an absolute path;
JSON requires an absolute directory. Launch fails clearly if it is missing.

```json
{
  "name": "ava",
  "runtime": "claude",
  "model": "claude-opus-5-5",
  "effort": "high",
  "directory": "/path/to/repo",
  "args": ["--continue"],
  "env": ["PATH", "HOME", "LANG"],
  "channels": ["owner/repo"]
}
```

Only name, runtime and directory are required; args default to empty. Names are
1–24 letters/digits/underscores/hyphens, beginning with a letter or digit. The
suffix budget accommodates duplicate sessions without exceeding socket limits.
Runtime is a native executable name or path, not a shell command string.
Unknown runtimes receive profile args and invocation args verbatim; model and
effort remain metadata and produce no guessed flags. Arguments are never shell
expanded. Relative executable paths and relative PATH entries resolve from the
profile directory.

Profile model/effort flags come from the same runtime registry as the events
adapters, then profile args, then invocation args. All gild flags precede
`agent`; all arguments after the profile name belong to the native executable,
including `--`, `--name` and `--as`. Profile sessions always use their profile
name; `--name` is rejected and an explicit `--as` must match. Interactive
launches resolve the existing approved credential using that label, with
repository/HEAD checks against the **profile's** directory. Profile launches
also work from a general existing directory: they link the approved identity
locally and activate state reporting only for a committed repository on that
identity's joined server. Explicit `gild spawn --as <label> <runtime>` keeps its
existing repository requirement. Local session metadata carries the approved
sponsor/label identity for the future channel hook. Credentials travel
over the existing IPC path, never in profile JSON or process argv.

The same PTY, alias resolution, event adapters, prompt queue and private socket
are used as for direct runtime launches. Socket binding reserves the name
atomically: simultaneous live sessions become `ava`, `ava-2`, etc. Status and
sessions expose the runtime and profile name separately. `--print-id` prints
the actual reserved name. The worker probes and reclaims dead sockets before choosing a suffix;
`gild sessions` also retains its stale cleanup. Pipes/redirects use the direct native process with the profile's
cwd, args and environment; the existing direct-execution path has no session
socket or forge reporting.

`env` is an optional **inheritance allowlist of variable names**, never values.
Omit it to retain normal spawn inheritance. When present, listed variables plus the baseline PATH, HOME, TERM, LANG, USER,
SHELL and TMPDIR reach the native process. The baseline is always inherited
when set, including with an empty allowlist, so executable lookup, native
configuration/auth and hooks keep working. Gild still removes its existing
nested-agent markers and supplies its private recursion markers; the PTY
supplies TERM. Codex notification resolution uses the native child environment
after filtering, so an excluded CODEX_HOME cannot select the wrapper's config. Repeated `--env` replaces the allowlist. Repeated `--arg` or
`--channel` replaces that list. `--clear-args`, `--clear-env` (normal inheritance)
and `--clear-channels` clear the respective fields; an empty model/effort clears
it on edit.

`channels` is validated and passed to the worker with the approved identity.
The existing mention bridge subscribes to these repositories and routes mentions
through the injection queue. The profile's instructions repository also joins
that subscription so browser edits can reach the session.

## Verified native flags (8 October 2026)

Inspected the installed executables with `claude --help`, `codex --help` and
`kimi --help`, plus their `--version` output:

| Runtime | Version | Model | Effort |
| --- | --- | --- | --- |
| Claude Code | 2.1.295 | `--model <model>` | `--effort <level>`; low, medium, high, xhigh, max |
| Codex | 0.160.1 | `-m <model>` | `-c model_reasoning_effort="<effort>"` |
| Kimi Code | 2.1.1 | `--model <model>` | Not exposed by help; a profile effort fails clearly |

Codex help verifies `-c` and its TOML value parsing; the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
verifies `model_reasoning_effort`. Effort is JSON/TOML quoted to avoid changing
the config expression. Codex effort levels and model IDs depend on the selected
client/provider; gild passes the supplied model ID unchanged and does not claim
model availability. In particular, `claude-opus-5-5` is the requested example
ID, not a provider availability check.

## Validation

`bun test src/agent-profiles.test.ts` exercises CRUD, JSON import/rejection,
credential separation, runtime flag tables including unknown passthrough,
piped cwd/argv/environment and relative executable resolution. The existing
fake-agent outer-PTY harness runs with `--profile`, `--profile-names` and `--profile-local` to
exercise mapped flags, cwd, scoped reporting, adapter hooks, FIFO/draft gating,
send-by-name, suffix reservation, environment and socket/settings cleanup.
No provider requests or real credentials are needed.

`node scripts/profiles-revert.mjs` independently reverts each covered behavior,
requires an assertion failure and restores sources after every case. The CI
installed-npm PTY gate includes profile tests as well as the spawn/events suites.

## Repository instructions and runtime preferences

The forge repository's `_meta` branch is the portable profile source.
Before a registered Claude/Codex profile launches, Gild pulls its repository
instructions and applies the repository runtime/model/effort preferences.
Native arguments supplied for this launch retain their normal precedence.
The file is written in the profile directory as `CLAUDE.md` or `AGENTS.md`.
The private adjacent `.gild-sync.json` records which remote revision was synced.
A pre-existing file or a file edited since that sync is kept, and status warns
about the conflict. VM launches seed the guest file and protect later guest
edits as well.

```sh
gild agent instructions ava --repo owner/repo
gild agent instructions ava --repo owner/repo --pull
gild agent instructions ava --repo owner/repo --edit --editor vi
gild agent instructions ava --repo owner/repo --push
```

Read/pull uses the approved agent identity. Edit/push uses the human sponsor's
existing login, so the commit belongs to the person who edited it. A pull asks
before replacing local edits; unattended conflicts keep the file and fail.
Push requires a previous pull and uses the recorded remote revision, rejecting
concurrent browser edits. During a live profile session, existing event
subscriptions and a 30-second sync update the instructions file; the existing
prompt queue delivers `[gild] your instructions changed` after a successful
update. A local conflict keeps the file and queues no replacement prompt.

Status/session reports expose runtime/version, effective model/effort,
`vm`/`none` isolation, host name, session start, state and last activity, with
redaction and no environment values or credentials. VM versions come from the
guest binary. Ordinary native launches add no isolation and report `none`;
`host` is reserved for the dedicated OS-user tier. Idle heartbeats preserve last activity and let the server show
whether a receipt is still online.

`bun run test:instructions:revert` removes nine instruction/runtime behaviors
independently and requires their effect assertions to fail. The installed PTY
gate includes native profile launch, browser-style instruction updates, dirty
local-file protection, prompt delivery and observed runtime reports.
[Gate evidence](agent-profile-gates.json) records the bugsy commands and the
existing opt-in VM/host/network skips. The site companion supplies the real
web edit, Git/D1, private-reader and cropped-photo browser proof.

-codex
