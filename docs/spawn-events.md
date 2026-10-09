# Structured PTY sessions

The native terminal remains the sole display. Events use the same private
0600 Unix socket as local sends; nothing is parsed from terminal output.

```sh
alias claude='gild spawn claude'
gild spawn --name work claude --resume
gild status work
gild send work 'Please review the diff when this turn finishes'
gild events work
# In a repository on the agent's joined gild server:
gild spawn --as ava --name work claude
```

All gild options precede the agent name. Every following argument belongs to
the native agent, including `--`. Pipes and redirects bypass the PTY, adapters,
socket and injection entirely. PATH resolution skips recognizable gild shims;
private recursion markers also skip opaque wrappers on re-entry. The normal
path prints nothing. `--print-id` explicitly writes the ID to stderr.

Local JSONL events have one `AgentEvent` definition in `src/spawn-events.ts`:
`{session, agent, type, tool?, text?, ts, raw}`. Types are busy, idle,
tool_start, tool_end, waiting and message. Subscribe directly by sending
`{"type":"subscribe"}\n` to the session socket. A subscriber gets the current
state when known, then future events. Slow subscribers are disconnected at a
1 MiB write backlog. `gild events tail` continues to stream forge events.

Status includes state, current tool, last activity, native session ID and
transcript path when available. Running tools use `tool_start`; tool completion
returns status to busy until the agent ends its turn. Unsupported agents remain
unknown and retain the configurable idle timeout.

Adapted sessions inject one queued prompt only after an idle event and with no
unsent composer text. Submission marks the session busy immediately. FIFO
messages wait for each subsequent turn to finish. Enter, Ctrl-U and Ctrl-C clear
the tracked draft. Escape never implies that existing text was erased; a lone
Escape settles after 50 ms. Split cursor controls and bracketed pastes are
tracked conservatively; paste newlines do not clear the draft. Keystrokes that
arrive between synthetic paste and Enter are held for that 80 ms pair, then
forwarded unchanged. Async fd output keeps hooks and signals responsive even
when a terminal reader stops draining. Backspace or uncertain cursor editing
requires submit or an explicit clear before injection.

## Claude Code 2.1.295 experiment

`claude --help` describes `--settings` as additional settings. We ran the actual
installed native TUI, driven by an outer PTY, against a deterministic local
Messages API. This exercises Claude's own hooks, tools, permission dialog and
composer; no provider credentials, paid requests or screen windows are needed.

Isolated user, project and local settings each registered a recorder for the
same hook names. With gild's per-session `--settings`, all four sources ran.
The user/project/local hook commands remained intact and executed on both
turns. Hashes before and after were identical. The real user's settings file
was also hashed before/after without editing it.

The refreshed `--repeat-settings` experiment passed two `--settings` files. Only the last CLI file's
hooks ran; user/project/local hooks still merged. Therefore, if the caller
already passes `--settings`, gild additionally loads its observer as a
per-session `--plugin-dir`. The caller's arguments and settings file are left
untouched. A second live TUI run verified all original sources plus gild's
plugin hooks, with identical before/after file hashes. Both temporary settings
and plugin files are removed on exit. `--bare` and `--safe-mode` keep their
native no-hooks behavior and use the fallback adapter.

The captured normalized sequence, including a prompt sent during the tool:

```text
busy (SessionStart)
busy (PTY submit)
busy (UserPromptSubmit)
tool_start (Bash)
waiting (PermissionRequest; native permission dialog)
waiting (Notification; delayed permission notification)
busy (permission response via PTY)
tool_end (Bash)
idle (Stop)
busy (queued prompt submitted via PTY)
busy (UserPromptSubmit)
idle (Stop)
```

`PermissionRequest` is observed in addition to `Notification`, so waiting is
visible immediately rather than depending on Claude's delayed notification.
Native hook payloads with fixture data are recorded in
`scripts/evidence/claude-hooks.jsonl`. Subagent hooks are ignored when they carry
an `agent_id`, so a subagent Stop cannot unlock the main composer.

Reproduce the live checks (all launches are headless):

```sh
TEST_GILD_COMMAND='["bun","run","/Volumes/Projects/codex/gild-cli-fixspawn/src/gild.ts"]' python3 scripts/fixtures/live-events.py
TEST_GILD_COMMAND='["bun","run","/Volumes/Projects/codex/gild-cli-fixspawn/src/gild.ts"]' python3 scripts/fixtures/live-events.py --explicit-settings
TEST_GILD_COMMAND='["bun","run","/Volumes/Projects/codex/gild-cli-fixspawn/src/gild.ts"]' python3 scripts/fixtures/live-events.py --repeat-settings
```

## Codex 0.160.1 capabilities

`codex --help` supports `-c key=value` and has
`--dangerously-bypass-hook-trust`; `codex features list` reports hooks stable
and enabled. The official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
defines `notify` as a command receiving notification JSON. Official
[hook documentation](https://learn.chatgpt.com/docs/hooks) describes lifecycle,
tool and permission hooks, additive sources, and mandatory trust review for
non-managed hooks. We preserve that review policy rather than bypass it.

The adapter supplies `-c notify=[gild,hook,--session,id,--agent,codex]` with the
appropriate development or compiled executable prefix. Codex appends its JSON
payload to argv. `agent-turn-complete` becomes idle. User PTY submission becomes
busy. Gild reads root `notify` from `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`) using a TOML parser, overlays the selected
`<profile>.config.toml` (including `--profile`/`-p`), then applies notify CLI
overrides in order. System `config.toml` supplies lower-priority defaults;
project config cannot override notify. Codex 0.160.1 resolves `notify` from root `cfg.notify`;
CLI config overrides replace it. Gild wraps that effective command: its hook
forwards first, then invokes the original command with its fixed arguments and
the exact JSON argument Codex appended. An absent/dead gild socket still runs
the caller's notifier after the forwarding deadline. Other CLI arguments stay
in order and `--` ends config-option parsing. User config files are never edited.
An empty notify command disables only the caller's notifier, leaving observation
active. The forwarding deadline bounds gild, not the caller's command runtime.

Only the executable-chain recursion guard remains; the unused depth counter
was removed. Windows fallback defers executable-suffix lookup to native spawning.

We also inspected JSONL shapes in `~/.codex/sessions`: `event_msg`,
`response_item`, tool calls/outputs, completion items and usage records. The
reader binds only to a notify-proven thread ID, never by matching cwd or the
newest log. It starts at EOF, ignores older timestamps, tolerates unknown or
malformed shapes and bounds line/read sizes. Subsequent task-start and tool
records enrich state. Completion remains notify-only, so delayed JSONL cannot
unlock injection. This is best effort: paginated history, unknown file naming,
missing transcripts and unknown shapes reduce coverage; the first turn's tools
are not observable before the thread is bound. Claude transcript tailing is
optional and is not enabled here.

## Reporting to gild

`--as <label>` reads an approved scoped token from the existing CLI agent store.
The current repository must have an origin on that identity's joined server
and a committed HEAD. Reports use the existing agent REPORT commit sessions
endpoint (existing `repo:write` scope), bound to that SHA and a stable receipt ID.
The required receipt model is `unknown`; this observer does not measure model usage.

The companion `codex/session-state` site change adds only an optional strict
state object: `{status, tool?, last_activity}`. Old receipts still parse.
Tool names use that shared contract validator. Raw payloads, message text,
tool arguments, commands and file paths are never reported. Updates coalesce
and run at most once a second, with a bounded request and a final ended receipt
on exit. Reporting failure never changes the native agent or prints into its
TUI. Tokens travel over worker IPC, never argv, environment, settings or events.

The Agents-channel lane can render busy/tool_start/tool_end as `● busy · Edit`,
idle as `○ idle`, waiting as `◐ waiting for permission`, and ended as offline.
That lane owns participant rendering; this PR supplies its state contract and
producer without modifying another agent's branch.

## Validation

`bun test` includes real nested PTYs, safe aliases, socket subscriptions,
recorded Claude translations, Codex notify/log parsing, injection gating,
unchanged settings and a linked session uploading to a local API.
`node scripts/events-revert.mjs` independently disables forwarding, deadline,
silence, each adapter, busy/draft gating, FIFO, fallback timing, settings
permissions/cleanup, additive hooks, status and privacy/reporting; each selected
test must fail by assertion. The installed npm launcher runs the same PTY,
alias and event tests. Hook deadline checks invoke the compiled binary directly,
as the generated native hook commands do. On this Mac the npm launcher added
about 140 ms: open-stdin expiry was 451 ms through Node versus 289 ms directly
(including process startup; the internal deadline is 200 ms). No release or
deployment is part of these checks.

-codex
