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
the actual reserved name. Stale sockets retain the existing `gild sessions`
cleanup rule. Pipes/redirects use the direct native process with the profile's
cwd, args and environment; the existing direct-execution path has no session
socket or forge reporting.

`env` is an optional **inheritance allowlist of variable names**, never values.
Omit it to retain normal spawn inheritance. When present, only listed inherited
variables reach the native process; include PATH for env-based scripts and HOME
for native config/auth and generated hooks. Gild still removes its existing
nested-agent markers and supplies its private recursion markers; the PTY
supplies TERM. Repeated `--env` replaces the allowlist. Repeated `--arg` or
`--channel` replaces that list. `--clear-args`, `--clear-env` (normal inheritance)
and `--clear-channels` clear the respective fields; an empty model/effort clears
it on edit.

`channels` is the v2 subscription seam: it is validated, persisted and passed to
the worker's session metadata with the profile identity. There is no channel
network subscription or mention injection yet. Future `channel.mention`
handling can bind this metadata to the existing injection queue.

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

-codex
