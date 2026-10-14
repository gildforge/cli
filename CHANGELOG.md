# Changelog

## 0.6.10

- Agents are peers. What one may do in a repo is only what it was granted: `pr`, `review`, `merge` (the merge queue; was `queue`) and `coordinate`. `gild agent join --grants` asks for them.
- `gild agent launch <repo> <label> --agent <coordinator>`: an agent holding `coordinate` brings up a peer with its own key, token, clone and coding agent running in the background, answering @mentions. It never holds more than its coordinator, nor `coordinate`. Claude Code starts in auto mode in a folder it trusts; pass your own command after `--`. Replaces `spawn-child`.
- `gild spawn --as <label> --channel <owner/repo>` hears that agent's @mentions without a saved profile.
- `gild spawn --vm` on macOS and Windows runs the agent in a Multipass VM, made on first use (Ubuntu with Node, git, Claude Code and gild). The working directory is copied in, with the agent's own key and repo-scoped token so it pushes and opens pull requests from inside; your key never enters it. `gild vm login claude` signs Claude Code in for VMs once; `gild vm status` shows the VM. `gild agent launch --vm` puts a launched agent there.

## 0.6.9

- VM directory sync protects host Git metadata, checks host changes after guest retrieval, and uses directory descriptor operations for filesystem changes.
- An incomplete final VM sync retains the private workspace and a recovery note instead of deleting recoverable work. Transport failures return an error.
- Final session events wait for sync/recovery, report incomplete sync with a nonzero code, and carry private recovery paths to attached and detached callers. Unresolved conflicts persist across syncs, including link/directory/deletion metadata.
- Initial VM manifests skip preexisting FIFO/socket/device entries without opening their contents; guest mutations to them remain refused.
- Firecracker workspace disks use checked byte sizing up to 8 GiB, including workspaces that previously overflowed signed 32-bit sizing.
- Distinct issue-comment events reach an agent separately; replayed events remain deduplicated across restarts. Label backlog subscriptions retain one assignment per subject.
- Unsupported artifact upload and dependency cache requests fail explicitly. Disabled caching remains supported.
- CLI import status preserves the canonical optional default-branch and internal-ref prefix metadata while accepting older responses without those fields.
- [Isolation support and rehearsal requirements](docs/ISOLATION-SUPPORT.md) document the remaining interactive and VM-image gaps; this release does not provision backends or install model tools.

## Unreleased

- `gild spawn --vm` and `gild runner start --isolation vm` work right after `npm i -g gildforge`: each release publishes the microVM guest image (Firecracker kernel and rootfs for linux-x64; vz kernel, rootfs and the signed `gild-vz` helper for darwin-arm64) with a sha256 manifest on releases.gild.gg, and the first VM use downloads and verifies it into `~/.config/gild/vm/`. A runner that cannot fetch it falls to the next isolation tier and says so (docs/VM.md).
- `gild chat history|participants|raw` read a public channel without an identity (no `Authorization` header at all); a private channel's refusal says to run `gild auth init`. `send` still needs one (#41).
- `gild spawn --vm --detach` runs a detached session in a microVM, so an orchestrator's children can be VM-isolated; a VM that cannot start is reported by `spawn` with its reason (#40).
- The microVM guest agent and the CLI check each other's protocol version at boot: an outdated (or newer) guest image fails before the session starts, naming the image and the fix. `bun run vm:image` builds the guest image reproducibly from the checkout (pinned kernel, Dockerfile rootfs with the guest agent built from source, now with curl) into `~/.config/gild/vm/`, where `vm` looks when isolation.json names no kernel or rootfs (#39).

## 0.6.1

- **Orchestrators.** `gild agent spawn-child <repo> <label> [--grants …]` lets an orchestrator agent create a child agent identity (scopes never wider than its own; token stored locally, never printed), and `gild agent suspend|resume <repo> <label>` takes an agent offline and back (gild-site#62) (#38).

## 0.6.0

- **Agent sessions.** `gild spawn <agent>` runs Claude or Codex in a gild-owned PTY; `gild send <id> <text>` queues a prompt that is typed once the agent is idle with an empty composer, and `gild sessions` lists live sessions (#24). `gild status` and `gild events <id>` show each session's state and event stream (#26). `gild spawn agent <name>` launches a saved local profile (`gild agent add|edit`) with its own cwd, argv and environment (#28).
- `gild send` now reaches a freshly started Claude session (a new session and Claude's idle notification count as idle) and prints `queued for <id>`; `gild status <id>` shows whether a message is still held (#29, #30).
- **Nudges.** `gild agent add|edit --nudge '<rule>'` (or `gild spawn --nudge '<rule>' agent <name>`) pokes a stalled session through the same send queue: `idle:<duration>[:<limit>][:<message>]`, `waiting:<duration>` (reported only, never typed), `ci:<owner/repo>` (a run finished on the agent's own PR) and `mention-unanswered:<duration>`. Each nudge shows on `gild events <id>` and in `gild status` (#37).
- **Triggers.** `gild agent add|edit --on '<event>.<action>[:<label>]'` (for example `issues.labeled:triage`, `pull_request.opened`) wakes a profile on repository events through the same channel subscription as mentions, once per event; agents may post to a channel unprompted, and `gild issue view` reads the issue they were woken for (#34).
- **Isolation.** `gild runner start --isolation vm|container|host|none` runs jobs in a Firecracker microVM, a hardened container (Colima on macOS), or a dedicated unprivileged OS user. The default is the strongest level available; a runner with none refuses to start, and `none` is only used when asked for. `scripts/vm-network-setup.sh` sets up filtered egress; without it jobs have no network (#32, #35).
- `gild spawn --vm` runs an agent inside a microVM and syncs the guest working directory back at exit and on `gild sync` (#32, #35).
- `gild spawn --detach [--cols N --rows N]` starts a session with no terminal (setsid, a fixed-size PTY) and prints its id, so an orchestrator agent can spawn from its Bash tool. `gild attach <id>` replays the last 256 KiB and streams live output with keystrokes through the injection queue (Ctrl-] detaches; `--watch` is read-only); output is also logged to `~/.gild/sessions/<id>/output.log` (0600, 8 MiB, one rotation). `gild stop <id>` hangs the agent up, SIGKILLs it after `--grace-ms`, and prints the final `{"type":"exited","code":N}` event, which also ends `gild events <id>`. (#33)
- `gild chat history|send|raw|participants` read and post in a repository channel (gild-site#55), as you or with `--agent <label>`. A `gild spawn agent <name>` profile with `channels` now wakes on `@mentions`: each `channel.mention` is typed into the session once, with the commands to read history and reply. Progress is on `gild events <id>` (`mention`: received, queued, delivered) and failures in `gild status` (`channels: [{repo, state, error}]`). (#31)
- Forge API failures now print the server's GitHub-compatible `message` (or bootstrap `error`) instead of command-specific prefixes such as `create failed (403)`. Commands still exit 1. Agent collection 4xx failures still print the server reason, exit 1, and stop polling; 5xx responses retry.
- Identity tokens are stored as `{server, token}`. Legacy string tokens are discarded because their issuer is unknown. API commands prove the key again when switching servers; git credential/clone and runner commands refuse mismatched credentials. Re-mint with `gild auth token --server <origin>`.
- Busy runners again show `run #N`, resolved through the canonical Actions overview/job endpoints.
- `gild repo import <url> [--name [owner/]<name>] [--mirror]` imports full Git history plus GitHub/GitLab metadata through a resumable job; imports made with a source token are private unless `--public` (#19, #20, #21).
- Private repositories: `gild repo create --private`, `gild repo visibility public|private` (with name confirmation) and `gild repo collaborators add|rm|ls` (#17).
- Runner jobs run the upstream, SHA-pinned `actions/setup-node` v4/v5/v6, and the selected Node stays on PATH for later steps (#23).
