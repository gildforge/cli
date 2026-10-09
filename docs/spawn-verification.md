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
PTY ownership and embeds its bundled companion with a Bun macro. Optional
`node-pty` is resolved by Node relative to the source/install/executable, not
Bun's virtual compiled filesystem. The npm launcher forwards signals and uses
an IPC lifetime link so killing any launcher layer hangs up the PTY owner.

All three existing platform binaries build (macOS arm64/x64 and Linux x64).
The macOS x64 binary and copied npm package layout run the integration suite.
Linux execution and arm64 execution are not local evidence from this Intel
Mac; CI now repeats the PTY suite through its Linux npm layout. Linux's native
addon needs the upstream build tools because 1.1.0 has no Linux prebuild.
Standalone downloads without the optional addon cannot run `spawn`; other
commands retain their standalone distribution.

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
