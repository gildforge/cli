Verified on 10 October 2026 (UTC) against the 0.6.2 candidate packages.
The worktree is `/Volumes/Projects/codex/gild-cli-noscripts`, branch
`codex/no-install-scripts`; Bugsy used
`/Users/sami/Projects/codex/gild-cli-noscripts`.

`node-pty@1.1.0` has no Linux prebuild. The pinned official
`1.2.0-beta.15` npm tarball includes all three requested targets. Each platform
package contains the five Unix loader files, MIT license, scriptless CommonJS
manifest and its native prebuild. Both macOS packages include executable
`spawn-helper`; Linux does not use or ship that helper. Tarball SHA-512/SHA-256
and every copied file's SHA-256 are checked against `scripts/node-pty.json`,
then checked again in the actual `npm pack` output.

| Host | Full suite | Installed-launcher suite | npm install stderr |
| --- | --- | --- | --- |
| Intel Mac, Bun 1.4.0, Node 26.3.1 | 229 pass, 18 skip, 0 fail | 70 pass, 4 skip, 0 fail | 0 bytes |
| Bugsy arm64, Bun 1.4.2, Node 26.10.0 | 229 pass, 18 skip, 0 fail | 70 pass, 4 skip, 0 fail | 0 bytes |

The skips are existing opt-in live VM/container/host isolation checks. Linux's
packed files and dependency metadata passed the audit; native Linux execution
is covered by the updated Ubuntu CI job, rather than claimed as local evidence.

Bugsy ran the entire sequence under
`lockf ~/Projects/claude/.heavy.lock sh ~/Projects/codex/gild-cli-noscripts/.tmp/verify-bugsy.sh`.
The wrapper created a new empty HOME per command and set TMPDIR to the worktree.
These commands all exited zero:

```sh
bun install --frozen-lockfile --ignore-scripts
npm install --prefix "$PWD/.tmp/npm" --ignore-scripts --no-audit --no-fund npm@11.16.0
# Subsequent verification uses that private npm CLI via TEST_NPM_CLI.
bun run typecheck
bun run format:check
bun test --timeout 30000
bun test src/runner-setup-node.test.ts
scripts/build-vz-helper.sh
bun run pack
bun run test:install
bun run test:installed-pty
bun run test:install:revert
```

The Swift helper compiled, retained the virtualization entitlement and returned
`ok`. The Node installer tests exercised upstream Node 22, 24 and 26 downloads.
A pre-existing wrapping error in `src/import/commands.ts` was formatted so the
format gate passes. An initial Intel installed-suite run hit the default 5-second
profile timeout; the installed step now uses the CI suite's 30-second default.
One Intel nudge-fixture timeout passed in isolation, and the final sequential
installed suite and both full suites passed.

`test:install` packs the candidate packages and serves their actual tarballs
through a temporary localhost registry, proxying only published server packages
from npm. It then runs `npm i -g gildforge --prefix <private-prefix>` against that
registry with a fresh HOME/cache, no ignore-scripts or allow-scripts flag, and
update notices disabled. It rejects every warning or stderr byte. All seven
resolved packages were audited, including foreign-platform optional packages:
`gildforge@0.6.2`, all three `@gildforge/cli-*@0.6.2`, and all three
`@gildforge/server-*@0.1.3`. None declares an install hook; the platform/server
packages have no dependencies. Pack manifests and the complete dependency list
are retained under `.tmp/packed` and `.tmp/install/published-dependencies.json`.

Full Bugsy npm install stdout:

```text

added 3 packages in 684ms
```

Full stderr: empty (0 bytes). Intel's full stdout was `added 3 packages in 4s`
with its leading/trailing newline; stderr was also empty.

From that fresh install, these all exited zero:

```text
gild spawn --detach --name t cat  -> t
gild send t hi                   -> queued for t
PTY output                      -> contains hi
gild status t                   -> detached: true, live child PID
gild stop t                     -> exited event, code 129 (SIGHUP)
```

The installed suite exercises interactive attach, watch, replay, send, resize,
Ctrl-C, exit status, terminal restoration and cleanup through the real launcher.

The revert proof repacks a scratch launcher with the original resolved
`node-pty@1.1.0` dependency. Its packed manifest is rejected, and the same fresh
global-install warning check exits 1. Source and the passing install are retained.
The outer revert command succeeds only when this regression is detected.
Full reverted npm install stdout:

```text

added 5 packages in 4s
```

Full reverted npm install stderr:

```text
npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: node scripts/post-install.js)
npm warn allow-scripts
npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review, or `npm approve-scripts <pkg>` to allow.
```

-codex
