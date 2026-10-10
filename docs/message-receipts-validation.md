Validated on bugsy, 10 October 2026, in
`/Users/sami/Projects/codex/gild-cli-receipts` under
`lockf ~/Projects/claude/.heavy.lock`, with Bun 1.4.3, Node 24.21.0 and npm 11.16.0.
Node and npm fixtures stayed inside the worktree.

Every command below exited 0:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | Frozen dependencies installed |
| `bun run build` | Native CLI built |
| `bun run typecheck` | Passed |
| `bun test --timeout 30000` | 232 passed, 18 expected live-environment skips, 0 failed |
| `bun run test:receipts:revert` | Held, delivered, actual busy-hook read and failure-isolation mutations each failed effect assertions; restored tests passed |
| `bun test src/runner-setup-node.test.ts` | 3 passed, including upstream setup-node and subsequent-step PATH |
| `bun run pack` | All platform packages built and verified |
| `bun run test:install` | Warning-free global install and installed CLI/session flow passed |
| `bun run test:installed-pty` | 70 passed, 4 expected VM-environment skips, 0 failed |
| `bun run test:install:revert` | Old install dependency failed the same check as expected |
| `scripts/build-vz-helper.sh` | macOS helper compiled with its entitlement |

The receipt tests use a real HTTP fake forge and the real injection queue, then
actual spawned PTYs and generated agent hooks. The receipt-failure PTY case also
passed in the full suite; the installed-launcher suite separately verifies PTY flows. Raw chat forwards receipt frames.
The generated channel/API contract matches the companion site source.
