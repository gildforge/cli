# microVM guest image

`gild spawn --vm` and `gild runner start --isolation vm` boot a microVM from a
kernel and a read-only ext4 root filesystem holding `gild-guest-agent` and
`/init-gild.sh`. All of it comes out of this repository.

Which VM `--vm` uses:

| host | backend |
|---|---|
| Linux x64 | Firecracker (shipped with gild, below) |
| macOS, Windows | Multipass: one Ubuntu VM, made on first use and kept |
| macOS with a `vm` block in `<config dir>/isolation.json` | Virtualization.framework (`vz`), the guest image below |

## Firecracker ships with gild (Linux x64)

`@gildforge/cli-linux-x64`, the package npm installs for `gildforge` on Linux
x64, carries `bin/firecracker` next to `bin/gild`: Firecracker v1.17.0
(Apache-2.0; its `LICENSE`, `NOTICE` and `THIRD-PARTY` are in
`vendor/firecracker/`). `scripts/vendor-firecracker.mjs` takes it from the
upstream release tarball when the packages are built, and refuses it unless
the tarball matches both the pin in `scripts/firecracker.json` and the sha256
Firecracker publishes beside it.

gild runs, in this order: `vm.firecracker` from `isolation.json`, the
`firecracker` next to the gild executable, then `firecracker` on `PATH`. The
host still needs `/dev/kvm` (read and write for your user) and `mke2fs`
(e2fsprogs).

## Network, git and getting work out

A Firecracker guest has **no network device** unless the owner ran
`sudo scripts/vm-network-setup.sh` once (a `gildbr0` bridge and tap devices
that allow the internet and deny the host, the LAN and metadata addresses);
`gild spawn --vm` prints which one applies:

```
gild: vm network: none, egress blocked (no gildbr0 bridge; enable with: sudo scripts/vm-network-setup.sh)
```

So on Linux the agent **edits in the VM and the host commits and pushes**:

- The working directory, `.git` included, is copied into the guest at
  `/workspace`. Git works there (gild sets `safe.directory=/workspace` for the
  guest, whose files keep your uid while the agent runs as root), so the agent
  can diff, branch and commit locally.
- File changes come back to the host at exit and with `gild sync <id>`,
  three-way against what was copied in; a file you changed on the host
  meanwhile is kept and the guest's copy saved aside.
- Changes under `.git` never come back (host Git metadata is protected): a
  commit made in the guest stays in the guest, and the session keeps its VM
  workspace for recovery (`~/.gild/sessions/<id>.vm-*`, `recovery.json`) and
  exits nonzero. Have the agent leave its changes uncommitted, then commit,
  push and open the pull request on the host (`gild pr create … --agent <label>`).
- No token, gild key or `gild` binary enters a Firecracker guest; the clone's
  credential helper points at the host's gild and is not usable inside.

Multipass on macOS and Windows differs: the agent's own gild key and
repo-scoped token are copied into the VM, it has network, and the agent
pushes and opens pull requests from inside; nothing is copied back.

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
`mke2fs`; a Mac without a hypervisor). Firecracker comes with the Linux x64
package (above).

## Build it yourself

On an x86_64 Linux host with `/dev/kvm`, Firecracker (the bundled one or your
own), `mke2fs` and Docker
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

Used only when `<config dir>/isolation.json` has a `vm` block; otherwise macOS
runs `--vm` in Multipass. The Virtualization.framework backend boots an arm64 guest built by
`scripts/build-vm-guest.sh <dir>` (docker or Colima); it compiles the same
guest agent from this checkout, so the handshake below applies to both.

## Version handshake

Automatic sync protects host Git metadata and retains incomplete work instead
of deleting it at exit. See [the support and recovery matrix](ISOLATION-SUPPORT.md)
for the current interactive-mode gaps and real-agent rehearsal requirements.

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
