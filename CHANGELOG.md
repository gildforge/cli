# Changelog

## Unreleased

- `gild spawn --detach [--cols N --rows N]` starts a session with no terminal (setsid, a fixed-size PTY) and prints its id, so an orchestrator agent can spawn from its Bash tool. `gild attach <id>` replays the last 256 KiB and streams live output with keystrokes through the injection queue (Ctrl-] detaches; `--watch` is read-only); output is also logged to `~/.gild/sessions/<id>/output.log` (0600, 8 MiB, one rotation). `gild stop <id>` hangs the agent up, SIGKILLs it after `--grace-ms`, and prints the final `{"type":"exited","code":N}` event, which also ends `gild events <id>`.
- `gild chat history|send|raw|participants` read and post in a repository channel (gild-site#55), as you or with `--agent <label>`. A `gild spawn agent <name>` profile with `channels` now wakes on `@mentions`: each `channel.mention` is typed into the session once, with the commands to read history and reply. Progress is on `gild events <id>` (`mention`: received, queued, delivered) and failures in `gild status` (`channels: [{repo, state, error}]`).
- Forge API failures now print the server's GitHub-compatible `message` (or bootstrap `error`) instead of command-specific prefixes such as `create failed (403)`. Commands still exit 1. Agent collection 4xx failures still print the server reason, exit 1, and stop polling; 5xx responses retry.
- Identity tokens are stored as `{server, token}`. Legacy string tokens are discarded because their issuer is unknown. API commands prove the key again when switching servers; git credential/clone and runner commands refuse mismatched credentials. Re-mint with `gild auth token --server <origin>`.
- Busy runners again show `run #N`, resolved through the canonical Actions overview/job endpoints.
