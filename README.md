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
gild spawn claude --name writer
gild spawn codex --name reviewer --idle-ms 1500
# In another terminal:
gild sessions                         # id, executable, cwd, owner pid, start time
gild send writer "Review the README"
printf 'First line\nSecond line\n' | gild send reviewer -
# Pass agent arguments after -- (including options also understood by gild):
gild spawn codex --name reviewer -- --no-alt-screen
```

The agent owns its normal TUI, colours, keyboard handling and exit status. Gild
forwards terminal bytes and size changes and queues incoming messages until
keyboard input has been idle for 1500 ms (`--idle-ms` accepts 0–60000). This is
an idle heuristic: it does not detect whether the agent is generating a reply,
and a paused, partially typed draft may receive a message after the idle timeout.
Multi-line messages use bracketed paste and a final Enter. Injected messages
cannot contain terminal controls other than newline and tab; keyboard input is
forwarded unchanged. `send` acknowledges acceptance into the bounded queue, not
completion of an agent response. Pending messages are discarded when the agent
exits. Messages and terminal output are not recorded.

Sessions use `~/.gild/sessions/<id>.sock` (0600 in a 0700 directory), accessible
only to the current local user. Names are 1–32 letters, digits, underscores or
hyphens; automatic names include a random suffix. `sessions --json` includes the
PTY owner and child PIDs. Listing removes sockets whose owner no longer accepts
connections. Duplicate names fail without disturbing the existing session.
Windows is explicitly unsupported in v1. No forge identity or token is needed.

`spawn` requires Node.js on PATH and the optional `node-pty` native dependency.
The npm `gildforge` package installs it; do not omit optional dependencies. The
other CLI commands still work if the addon is unavailable. Upstream 1.1.0 ships
macOS prebuilds; Linux installation needs Python and C++ build tools for its
native build. Bun installs trust the `node-pty` build script. Gild fixes the
missing executable permission on the upstream macOS spawn helper before use.

The standalone Bun binary embeds a Node companion, but **a downloaded binary
alone cannot run `spawn`**: it has no native addon beside it. Use the npm install
for PTY sessions. In local testing `node-pty` loaded in Bun but its terminal read
path hung; the Node companion owns the PTY instead. See
[node-pty](https://github.com/microsoft/node-pty) for the native dependency and
[Bun macros](https://bun.sh/docs/bundler/macros) for embedding the companion. The
socket is a message source for the injection queue; a later channel subscription
can enqueue mentions through the same interface. Channel/token flags are not
implemented in v1.

-codex
