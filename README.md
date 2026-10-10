# gild

Key-first identity for the forge, in your terminal. TypeScript on Bun, in the
style of woreda: one entry point, interactive questions to get started,
standalone executable via `bun build --compile`.

## commands

Mirrors `gh` where it can — familiarity is the point. Account lives under
`gild auth` (key-first instead of OAuth, same verbs):

```sh
gild auth init        # create your ed25519 identity key (asks questions first)
gild auth claim <challenge>   # claim your @name (challenge comes from the claim page)
gild auth token       # mint the API token git pushes use
gild auth status      # show this machine's identity
gild auth sign <challenge>    # sign a browser sign-in challenge
gild auth setup-git   # wire git's credential helper (done automatically by init/token)

gild repo create [org/]<name> # new repo (personal or under an org)
gild repo import <url> [--name [owner/]<name>] [--private] [--mirror]
gild repo import-status|resume|cutover <owner/name>
gild repo clone <owner/name>  # clone with push wired (alias: gild clone)
gild org create|list|add-member
```

`gild auth init` and `gild auth token` also register gild as git's
credential helper for gild.gg, so plain `git clone` / `git push` just work.

The private key lives at `~/.config/gild/identity.json` (mode 0600) and never
leaves the machine. Browser sessions are signed delegations; gild.gg never
sees the key.

## Agent issue and PR workflow

Every command below accepts `--agent <label>` to use that label's stored,
approved token and joined server. Omit it to use the human identity. Reads
accept `--json`; writes print the result URL (and also accept `--json`).

```sh
gild clone owner/repo agent-work --agent ava
cd agent-work
git switch -c fix-12
# edit files, then:
git add . && git commit -m "Fix issue 12"
git push -u origin fix-12
gild issue view owner/repo#12 --agent ava --json
gild issue create owner/repo --title "Bug" --body "Details" --agent ava
gild issue comment owner/repo#12 -b "Working on it" --agent ava
gild issue label owner/repo#12 --add ready --remove triage --agent ava
gild issue close owner/repo#12 --agent ava
gild pr create owner/repo --head fix-12 --base main --title "Fix issue 12" --body "Details" --agent ava
gild pr list owner/repo --agent ava --json
gild pr view owner/repo#13 --agent ava --json
gild pr diff owner/repo#13 --agent ava
gild pr checks owner/repo#13 --agent ava --json
gild pr comment owner/repo#13 -b "Ready for review" --agent ava
gild pr review owner/repo#13 --approve -b "Verified" --agent reviewer
gild pr merge owner/repo#13 --agent ava
```

Issue commands also accept `owner/repo 12`. Reviews require exactly one of
`--approve`, `--request-changes`, or `--comment`. `pr checks` reads Actions runs
for the current head SHA. `pr merge` pins that SHA and requests the server's
merge queue; the queue's response is printed, and merging is asynchronous.

Clones use a repository credential helper for the selected identity. Tokens
travel through Git's credential pipe, never the remote URL, command arguments,
or `.git/config`. Agent clones set the local author to `sponsor/label` and
`label+sponsor@agents.gild.gg`; human clones retain Git's author defaults.
The clone continues to use the selected identity when pushing later.

`node scripts/agent-workflow-e2e.mjs` exercises authenticated clone, commit,
push, PR, review, and queue drain against a fake forge with a real smart-HTTP
Git server. `node scripts/agent-workflow-revert.mjs <base>` proves the regression
tests fail with the implementation restored to the base, then restores it.

## develop

```sh
bun install
bun test
bun run src/gild.ts --help
bun run build   # dist/gild, standalone executable
```


Owner runners: `gild runner add --org <org> --group <group> --token <one-time>` or `--user <name>` registers without an owner identity on the machine. Setup tokens expire after one hour and work once. Existing `--repo` runners accept `--token` too and old configs still work.

`gild runner group create|ls|add-repo|rm-repo|allow-public` accepts `--org` or `--user`. For example, `gild runner group create builds --org acme`, `gild runner group add-repo builds repo --org acme`, and `gild runner group allow-public builds true --org acme`. Groups start with no selected repos and public repos excluded.

Run `gild runner start`, or install a service with `gild runner service install --name <runner>`. `service status|uninstall` manages launchd on macOS, a systemd user unit on Linux, and a Windows SCM host. Windows install needs an elevated terminal and prompts for a service account. Service definitions contain config paths, never Gild credentials. macOS and Linux services install for the current user without sudo. Windows service installation/removal requires an elevated Administrator terminal and is excluded from that claim. Linux units use only the directories of node/bun/git resolved at install time plus /usr/bin and /bin, rather than copying the installer PATH. Run `loginctl enable-linger` as the service user to keep the user manager alive after logout and start it at boot; system policy may require administrator approval. Install required workflow tools for the service account.

Owner machine tokens never clone repositories; each job supplies a repo- and live-lease-scoped checkout/reporting credential. Public fork runs wait for maintainer approval. Jobs execute as the runner OS account; use a dedicated account for untrusted workflows.

Service implementation references: [Microsoft New-Service](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/new-service) and [systemd service command syntax](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

`gild events tail --agent <label>` uses the server saved when that agent joined. A different `--server` is refused. Tail retries network errors, HTTP 408/429/5xx, and backs off from 500 ms to 10 seconds on errors or empty pages; Ctrl-C exits cleanly. Use `--once` for one page and its resume cursor. Agent-request payloads are omitted by default; `--raw` includes approval URLs and any secrets in the original payload.

Run `bun run format` and `bun run format:check` for handwritten code. Generated API sources retain the site's formatting.


Session record/list with `--agent` use that agent's saved server; a different `--server` is refused. Before upload the CLI redacts commands, notes, model names and file paths, then computes the idempotency key from the sanitized report. Rules mirror the site's redactor and include bearer/API credentials, AWS access keys, opaque Cloudflare-like credentials and secret assignments (`--token=`, `KEY=`, passwords). Raw receipt files stay local.

Service install removes the newly written unit/plist/host if the native manager fails. Uninstall removes the definition even when disable/bootout reports that it is already unloaded, and still reports manager failures. The private runner config and its `gro_`/`gr_` token remain; `gild runner remove <name>` (with the same `--config-dir`) revokes the runner and deletes the config. Uninstall alone does not revoke credentials.

## Repository import

`gild repo import https://github.com/owner/repository.git --private` transfers every code branch, tag and reachable commit with native Git, then imports GitHub issues, PRs, comments, submitted reviews, labels and milestones. GitLab issues, merge requests and discussions are also supported; use `--forge gitlab` for a self-hosted instance. Other forges support complete Git import with `--forge git`. Git LFS objects, release assets and wikis are separate source services and are outside this command.

Use `--source-token` for a masked prompt or `--source-token-file <path>` for a token file. A token is recommended for public metadata too, because forge REST limits can interrupt larger imports. Credentials are passed to Git internally and never saved in the mirror's config. The server encrypts a pending source credential with its Actions key, discards it when a one-shot import finishes or fails, and retains it in mirror mode until cutover. A failed private one-shot import needs a token again when resumed.

`--mirror` schedules hourly source synchronization through an eligible owner runner. The CLI performs the first transfer locally; later syncs require a running user/org machine whose group permits this repository. Repo-scoped Actions runners cannot claim owner imports. `gild repo resume owner/name` retries an interrupted import using the disk mirror and durable metadata checkpoint; use `--source-token-file` when needed. `gild repo cutover owner/name` stops synchronization and records the source as a read-only reference.

Source authors and timestamps are retained with explicit imported attribution. Historical reviews never approve a Gild merge. PR heads use `import/pr/<number>`; a missing head produces a closed PR with its source patch. GitLab's separate issue/MR number spaces map to odd/even Gild numbers; GitHub numbers remain unchanged. A source `_meta` branch is retained under `import/source/_meta` (with a suffix if necessary), preserving Gild's access metadata. Actions compatibility warnings come from the same support contract used by execution. Imports do not execute source workflows.

Git packs stay on disk and stream through a live repository-scoped import credential. Native Git is required. Request batches stay bounded; interrupted item IDs replay safely. Generated import contracts, source adapters and Actions support come from the site repository.

-codex

## Local terminal agents

```sh
alias claude='gild spawn claude'
gild spawn --name writer claude
gild spawn --name reviewer codex --no-alt-screen
# In another terminal:
gild sessions                         # state, current tool, activity and process metadata
gild status writer
gild events writer                    # normalized JSONL, including local raw hook payloads
gild send writer "Review the README"
printf 'First line\nSecond line\n' | gild send reviewer -
# In a repository on an approved agent identity's joined gild server:
gild spawn --name writer --as ava claude
```

Gild options go before the agent name. Everything after it passes to the native
agent verbatim. With piped stdin or redirected stdout, gild runs the agent
directly without a PTY or session socket. PATH wrappers that re-enter gild are
skipped; spawn is quiet unless `--print-id` is requested.

The native TUI owns the display, colours, keyboard handling and exit status.
Claude hooks and Codex notifications provide a separate event channel. Messages
queue until the adapted agent ends its turn and the composer has no unsent text.
For other agents, state stays unknown and the configurable `--idle-ms` heuristic
remains (default 1500 ms, range 0–60000). Multi-line injection uses bracketed
paste and a final Enter; message controls other than newline and tab are
stripped. `send` acknowledges queue acceptance. Pending messages are discarded
on exit. Attached sessions do not persist messages or terminal output; local event
subscribers can see raw hook payloads.

Sessions use `~/.gild/sessions/<id>.sock` (0600 in a 0700 directory), accessible
only to the local user. Names contain 1–32 letters, digits, underscores or
hyphens. Duplicate names fail without disturbing the existing session. Listing
removes stale sockets. Temporary observer settings/plugins are private and
removed on exit; the user's Claude settings are left intact.

Interactive PTYs require Node.js on PATH and the PTY module bundled in the npm platform package.
Install `gildforge` with npm without omitting optional dependencies. macOS uses
upstream prebuilds; Linux installation needs Python and C++ build tools. The
standalone Bun binary embeds its Node companion, but a downloaded binary alone
has no native addon; npm installs provide it. Windows PTYs are unsupported in
v1; direct pipe/redirect execution still works.

`--as` reports state to the existing commit session REPORT API using the approved
agent's scoped token. That endpoint currently requires `repo:write`; this does
not broaden token grants. Reports contain state, tool name and activity time,
coalesce to at most one per second, and finish with ended. Prompts, arguments,
commands and file paths stay local. Channel mention subscriptions remain a
future source for the same injection queue.

Local profiles make a gild label runnable with `gild spawn agent ava`:

```sh
gild agent add ava --runtime claude --model claude-opus-5-5 --effort high --dir /path/to/repo
gild agent ls
gild spawn agent ava --continue
gild send ava "Review the README"
```

Interactive launches use the existing approved identity for that label. The
profile stores runtime settings separately from credentials. Duplicate profile
sessions become `ava`, `ava-2`; sessions show both profile and runtime. Profile
arguments precede invocation arguments and use the existing events adapters.
See [profile management and verified flags](docs/agent-profiles.md) and
[adapter experiments, live evidence and validation](docs/spawn-events.md).

### Detached sessions (for orchestrator agents)

An agent's Bash tool has no terminal. `--detach` starts the session in the
background on a PTY nobody is attached to, prints its id once the session is
listening, and returns without holding the caller's stdin, stdout or stderr:

```sh
gild spawn --detach --name bob claude       # prints: bob
gild spawn --detach agent ava               # profiles too (prints ava, or ava-2)
gild send bob "Review the README"
gild status bob                             # ... "detached":true,"viewers":0 ...
gild events bob                             # JSONL; ends with {"type":"exited","code":N}
gild attach bob                             # from a terminal: replay, then live; Ctrl-] detaches
gild attach --watch bob                     # read-only, alongside one interactive viewer
gild stop bob                               # hangup, SIGKILL after --grace-ms (3000), prints the exit
```

The terminal is 120x40 unless `--cols`/`--rows` say otherwise; an interactive
viewer resizes it while attached. The session keeps the last 256 KiB of output
for `attach` to replay and appends everything to
`~/.gild/sessions/<id>/output.log` (0600, 8 MiB, one rotation to `output.log.1`).
Keystrokes from `attach` go through the same input tracking as an attached
spawn, so an unsent draft still holds injected messages. Detaching never stops
the agent; `gild stop` does, and removes the socket, settings and log with it.

`--detach` combines with `--vm`: `gild spawn --vm --detach --name bob claude`
runs the child in a microVM with no terminal, and `send`, `attach`, `sync` and
`stop` work as above; `stop` brings the guest's last changes back to the host.

### microVM sessions (`--vm`)

`gild spawn --vm` runs the agent in a Firecracker microVM on a copy of the
working directory (`gild sync <id>` brings changes back; exit does too). Build
the guest image once per gild version on an x86_64 Linux host with Docker:

```sh
bun run vm:image        # in a gildforge/cli checkout; writes ~/.config/gild/vm/
```

A guest image built for another gild version is refused at boot with that same
command as the fix. Details: [docs/VM.md](docs/VM.md).

-codex
