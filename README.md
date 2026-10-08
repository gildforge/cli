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
