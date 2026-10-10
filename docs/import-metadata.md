Public GitHub imports use `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token` for source metadata reads. The automatically discovered credential stays in memory on the importing machine: it is not a Git transport credential, sent to gild, included in the import job, or saved in the local snapshot. `--anonymous` disables discovery. Destination privacy is unaffected. Explicit `--source-token` / `--source-token-file` credentials retain their separate existing server/mirror contract and private destination default.

Each completed issue or PR (including its comments/reviews) is acknowledged together with the next cursor through `importBatch`. The job holds the cursor and cumulative record count. Local list-page snapshots beside the import Git directory preserve the listing across retries, so resumed imports do not list or fetch finished records again. Files use mode 0600 inside a mode 0700 directory; no request headers are saved. Losing the snapshot can require rereading the current list page, but completed item detail/comment requests are still skipped. An interrupted unfinished item can replay deterministic writes. Mirror cycles start a fresh snapshot.

Source 403/429 rate-limit responses with exhausted-budget or retry headers wait at most fifteen minutes, printing a second-by-second countdown. Ctrl-C leaves acknowledged work resumable. Longer or unknown resets stop with the reset time, `gh auth login`, and resume guidance. The import and resume commands both cancel cleanly.

The companion gild-site change selects source HEAD before streaming refs, hides the job's collision-free temporary PR namespace from readers, accepts flush-only pushes, and freezes PR heads as reachable commits before removing temporary refs at finish. A source `_meta` branch is preserved separately as collision-free `source/_meta` rather than overwriting gild's ACL branch.

Ava's live verification after the companion changes are deployed and the CLI is available (not run by this PR):

```sh
gh auth status --hostname github.com
gild repo import https://github.com/jonschlinkert/is-number --name avatest/is-number-4
gild repo import-status avatest/is-number-4
git clone https://gild.gg/avatest/is-number-4.git is-number-4
git -C is-number-4 symbolic-ref --short HEAD
# expected: master
git ls-remote --heads https://gild.gg/avatest/is-number-4.git 'refs/heads/import/*'
# expected: no output
```

If interrupted: `gild repo resume avatest/is-number-4`.

Local reversal proof: `bun scripts/import-metadata-revert.mjs` removes automatic auth, per-item acknowledgment, list-page reuse, no-op head skipping, and masked Git reasons individually; each effect test fails, then the restored suite passes.

-codex
