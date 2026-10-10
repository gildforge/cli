# Local PTY verification

The integration fixture drives gild inside an outer Unix PTY with Python's
standard library. The child fixture puts its terminal in raw mode. No terminal
windows or GUI automation are involved. `bun test src/spawn.test.ts` exercises
stdin and stdout (including invalid UTF-8 and Ctrl-C), initial dimensions and
resize, exit status, socket send, multi-line bracketed paste, user idle timing,
control stripping, environment markers, process-group cleanup, parent death,
terminal restoration before runtime exit, session permissions/metadata,
duplicate names, stale sockets, failed startup and FIFO order.

`bun run scripts/spawn-revert.mjs` disables one behavior at a time, requires the
corresponding integration test to fail, then restores the file in `finally`.
It covers input/Ctrl-C, output, resize, exit code, submit, bracketed paste, idle,
control stripping, markers, process group, parent death, terminal restoration,
permissions, stale sockets, failed startup cleanup and FIFO order. Logs stay
under `.tmp`. An optional argument filters by mutation name. Do not run source
tests or builds concurrently with this deliberately mutating proof script.

## Runtime and distribution

On macOS x64, `node-pty` 1.1.0's prebuilt `spawn-helper` lacked its executable
bit. After correcting that, `/bin/echo pty-ok` through node-pty worked under
Node 26.3.1 but hung in Bun's PTY read path. The hanging probe was stopped by its
own process/session, without affecting other agents. Production uses Node for
PTY ownership and embeds its bundled companion with a Bun macro.
`node-pty` is loaded by Node from the installed platform package (vendored at
pack time from the hash-pinned npm tarball), or the development dependency, not
Bun's virtual compiled filesystem. The npm launcher forwards signals and uses
an IPC lifetime link so killing any launcher layer hangs up the PTY owner.

All three npm platform packages ship the loader and native prebuild from
`node-pty@1.2.0-beta.15`. Stable 1.1.0 has no Linux prebuild; the pinned beta
includes Linux x64. Linux does not require a spawn-helper; macOS ships it with
its executable bit set and retains the runtime chmod fix. `scripts/node-pty.json`
records the npm tarball integrity, SHA-256, and each shipped file's SHA-256.
`bun run test:install` checks the actual npm pack files, all-platform published
dependency graph, fresh global npm install output, and detached spawn/send/status/
stop. `bun run test:installed-pty` runs the CI PTY suite (including attach) through
that install with an empty HOME. CI runs these checks on all three platforms.
When Node, node-pty, or PTY creation is unavailable, `spawn` silently launches
the original agent with inherited stdio and its exit status. Windows and
pipes/redirects also take this native path, without hooks, injection or a socket.
`GILD_DEBUG` is a tooling-only diagnostic for fallback reasons.

Only explicit nested-session markers are removed: `CLAUDECODE`, `CLAUDE_PID`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_PARENT_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SESSION_ID`
and `CODEX_THREAD_ID`. Authentication, provider and effort configuration is kept.
cqx-desktop currently uses a broader prefix filter; the alias intentionally
does not inherit that filter because it would remove user configuration.

The native child shares the terminal process group; gild consumes its own SIGINT
without forwarding a second copy. The worker probes a colliding named socket
and reclaims only a refused socket with an unchanged inode/device.

`node scripts/spawn-review-revert.mjs` verifies eight independent review
regressions fail with their fixes disabled and restores each source afterward.

## Real-agent transcript excerpts

Checked against the compiled binary through an outer PTY, with normal home and
installed agent authentication. Agent tool access was disabled/restricted. The
harness answered Codex's cursor-position query, accepted trust for its own
scratch workspace, and called `gild send` from a separate process. Agent redraw
controls and unrelated startup text are omitted below.

Claude Code 2.1.295:

```text
gild spawn --name <session> claude -- --tools '' --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --setting-sources '' --permission-mode plan
gild send <session> 'Reply with exactly GILD_PTY_REPLY_OK. Do not use any tools or inspect files.'
❯ Reply with exactly GILD_PTY_REPLY_OK. Do not use any tools or inspect files.
⏺ GILD_PTY_REPLY_OK
SIGTERM → terminal restored
```

Codex CLI 0.160.1:

```text
gild spawn --name <session> codex -- --no-daemon --no-alt-screen \
  -s read-only -a never -c check_for_update_on_startup=false
gild send <session> 'Reply with exactly GILD_PTY_REPLY_OK. Do not use any tools or inspect files.'
› Reply with exactly GILD_PTY_REPLY_OK. Do not use any tools or inspect files.
• Working (0s • esc to interrupt)
• GILD_PTY_REPLY_OK
SIGTERM → terminal restored
```

The first smoke harness sent Enter while Codex's update menu was open and
accidentally updated the installed CLI. The prior 0.160.1 installation was
restored and verified before the final smoke. Subsequent smoke invocations
explicitly disabled startup update checks without changing the user's config.
Claude's own automatic update advanced 2.1.294 to 2.1.295 during the checks.

A text burst followed by Enter in the same input event initially left Claude's
prompt unsubmitted. Production now delivers Enter 80 ms after the text/paste,
and both real TUIs submitted and answered the injected prompt. This is generic
terminal input, with no provider integration or structured event parsing.

-codex
