# gild runners

Register a Linux or macOS machine with a repository you own or administer:

```sh
gild runner add --repo owner/name --name mac-mini --labels build,arm64
gild runner list
gild runner start --name mac-mini
gild runner remove mac-mini
```

`add` uses your existing gild identity/API token to register, then saves only the repo-scoped machine credential at `~/.config/gild/runners/mac-mini.json` (0600, directory 0700). `remove` revokes the server credential before deleting the local file. The registered name, OS, architecture and labels appear in the repository's Actions board. Start one foreground process per machine registration; Ctrl-C stops polling and cancels its owned subprocesses. `--once` handles at most one assignment. `--server` accepts an HTTPS origin or localhost HTTP for development; `--config-dir` selects an isolated local configuration root.

`gild runner start` refuses root unless explicitly passed `--allow-root`. Git, `ps`, the declared shell and required toolchains must already be installed. Jobs execute native processes as your account. Use a dedicated account/machine for workflow code you trust; per-run directories are not containers.

Each assignment carries protocol schema 1, an immutable commit SHA, resolved steps/env, metadata and a unique lease. The runner polls for up to 20 s, checks out via gild's git URL under its own `runners/<name>/work/` folder, sends 10 s heartbeats and batched complete-line logs, then reports step exits/durations and a final result. It rejects working directories that escape the checkout (including symlinks). Checkout credentials are passed to git temporarily rather than persisted in repo configuration or exposed to steps. HOME/TMP are per-run; PATH and installed rustup toolchains come from the machine. Cleanup removes the checkout after completion.

| Operation | Endpoint under `/api/repos/owner/name/actions` |
| --- | --- |
| Register/revoke | `POST /runners`, `DELETE /runners/:id` |
| Atomic claim | `POST /runners/poll` |
| Lease/cancellation | `POST /runners/heartbeat` |
| Batched output | `POST /runners/logs` |
| Results | `POST /runners/step`, `POST /runners/finish` |

Only registration uses the existing owner/admin API credential. Job operations use the returned `gr_` token, scoped to that repo. Leases prevent stale runners from reporting success. Cancellation/timeouts stop only the PIDs and descendants started by this runner, with a bounded escalation; shared processes are not pattern-killed. Default bash includes `-e -o pipefail`; `sh`, `python` and unquoted shell templates containing `{0}` are supported. Continue-on-error preserves the failed step exit while allowing the job to proceed.

| `uses:` | Behavior |
| --- | --- |
| `actions/checkout@*` | Already checked out exact SHA through gild; fetch-depth/persist-credentials accepted, other inputs fail |
| Node/Bun/Go setup actions | Verify installed versions (numeric/wildcard selectors); no downloads |
| `dtolnay/rust-toolchain`, `actions-rs/toolchain` | Verify installed rustup toolchain; components/targets fail clearly |
| Upload-artifact/cache | Logged no-op |
| Anything else | Failed step: `gild doesn't run <action> yet` |

Secrets are resolved and logs masked by the forge; they are withheld from PR and agent-push runs. This runner buffers complete lines so split output cannot evade masking. Lines over 32 KiB fail without forwarding a partial tail. Output transport retries use stable per-step sequence counters, including checkout/bootstrap messages. Server retention is bounded at 2 MiB per run. See the companion gild-site PR and [`docs/actions/README.md`](https://github.com/gildforge/gild-site/blob/codex/actions/docs/actions/README.md) for parser compatibility, storage, merge gating, timings and deployment bindings.

Validation: `bun test`, `bun run typecheck`, `bun run build`. With the sibling site checkout, `node ../gild-site/scripts/actions-local.mjs --r2` exercises actual CLI commands against local Wrangler, echo/Node execution, logs/results, races, cancellation/timeouts, lost leases and archive readback. `node scripts/runner-revert.mjs` proves failure when pipefail or shared log sequence counters are removed, then restores the implementation. Evidence is in `docs/runner-revert-evidence.json` and the site's local fixture results. No deployment, bucket creation, secret transfer or npm publication is part of these changes.

-codex
