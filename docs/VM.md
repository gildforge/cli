# microVM guest image

`gild spawn --vm` and `gild runner start --isolation vm` boot a microVM
(Firecracker on Linux, Virtualization.framework on macOS) from a kernel and a
read-only ext4 root filesystem holding `gild-guest-agent` and `/init-gild.sh`.
All of it comes out of this repository.

## Published images (nothing to build)

Every release publishes the guest image for each VM platform next to the CLI
binaries, built by `.github/workflows/release.yml` on GitHub's hosted runners:

| platform | files | built on |
|---|---|---|
| `linux-x64` (Firecracker) | `vmlinux`, `rootfs.ext4` | `ubuntu-latest`: `bun scripts/vm-release.ts build linux-x64` (the recipe below) |
| `darwin-arm64` (vz) | `Image`, `rootfs.ext4`, `gild-vz` | `ubuntu-24.04-arm`: `scripts/build-vm-guest.sh`; `macos-15`: `scripts/build-vz-helper.sh` (ad hoc signed) |

```
releases.gild.gg/cli/v<version>/vm/manifest.json         version, guest protocol, commit, sha256 of every file
releases.gild.gg/cli/v<version>/vm/<platform>/<name>.gz
```

On first VM use (`--vm`, `--isolation vm`, a job or host default asking for
`vm`) gild downloads the image for its own version and platform into
`~/.config/gild/vm/`, showing progress. It refuses a manifest for another gild
version or guest protocol, and any file whose sha256 (gzipped or unpacked) is
not the manifest's; nothing is replaced until every file checks out, and
`vm/image.json` records what was installed. Later runs use it offline. At
boot the guest agent handshake below checks the protocol again.

When the image cannot be fetched (offline, no image for this version or
platform), `gild spawn --vm` fails with the reason, since it never runs an
agent on the host; `gild runner` falls to the next tier the floor allows
(`container`, then `host`, never `none`) and says so in its log line:

```
isolation: container (oci), requested by flag (vm image unavailable, fell back to container: could not fetch …)
```

Nothing is downloaded when isolation.json points `vm` at your own kernel and
rootfs, when `vm/image.json` is a local build (`bun run vm:image`), or when
the host cannot run the backend anyway (no Firecracker, `/dev/kvm` or
`mke2fs`; a Mac without a hypervisor). Firecracker itself is not shipped.

## Build it yourself

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
