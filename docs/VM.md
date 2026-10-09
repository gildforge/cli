# microVM guest image

`gild spawn --vm` and `gild runner start --isolation vm` boot a Firecracker
microVM from two files: a kernel and a read-only ext4 root filesystem holding
`gild-guest-agent` and `/init-gild.sh`. Both come out of this repository.

## Build it

On an x86_64 Linux host with `/dev/kvm`, Firecracker, `mke2fs` and Docker
(BuildKit), from a checkout of the gild version you run:

```sh
bun run vm:image                         # writes ~/.config/gild/vm/
bun run vm:image --config-dir <dir>      # or another gild config directory
```

It writes:

| file | what |
|---|---|
| `vm/vmlinux` | Firecracker's CI kernel 5.10.245, downloaded and checked against a pinned sha256 |
| `vm/rootfs.ext4` | `guest-agent/image/Dockerfile`: Ubuntu 24.04 with bash, git, curl, python3, ripgrep, Node 24 and Bun (pinned by sha256), plus the guest agent compiled from this checkout |
| `vm/image.json` | protocol, agent version, commit and sha256 of both files |

and, if `isolation.json` has no `vm` block yet, adds `"vm": {}`. With no
`kernel`/`rootfs` in that block, gild uses `vm/vmlinux` and `vm/rootfs.ext4`.
If the block names other files, the script says so and leaves it alone.

The mke2fs step uses a fixed UUID, hash seed and timestamp, so the same tree
packs to the same bytes; apt packages still follow the Ubuntu mirror.

## macOS (`vz`)

The Virtualization.framework backend boots an arm64 guest built by
`scripts/build-vm-guest.sh <dir>` (docker or Colima); it compiles the same
guest agent from this checkout, so the handshake below applies to both.

## Version handshake

The CLI and the guest agent share one protocol number,
`src/isolation/guest-protocol.json` (the agent compiles it in). On boot the
host (Firecracker or vz) pings the agent; the reply carries the agent's protocol and version, and
any difference stops the VM before the session starts:

```
--vm failed: The guest image /home/me/.config/gild/vm/rootfs.ext4 is outdated:
its gild-guest-agent (no version, before 0.2.0) speaks protocol 1, this gild
needs 2. Rebuild the guest image from a gildforge/cli checkout at this gild
version: `bun run vm:image` (docs/VM.md).
```

Bump the number with any new guest op. Protocol 1 was ping, pty, put and
exec; protocol 2 added list and get (`gild sync`).
