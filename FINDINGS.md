# gild microVM isolation: findings

Status:
- First slice (#32): Firecracker and OCI-container isolation for `gild runner`, and `gild spawn --vm`, work end to end on demon, filtered egress proven live.
- Second slice (this branch, `claude/microvm-2`):
  - `spawn --vm` working-directory sync back to the host, at exit and on demand (`gild sync <id>`);
  - the `host` tier (a dedicated unprivileged OS user, set up once by the owner);
  - `container` on macOS through Colima, proven with a real runner job on the Intel iMac.
- The macOS `vz` microVM backend is NOT built; what porting it takes is written up below.

## What the old gild code gave us, and what was rewritten

Found (all read-only copies under `demon:~/Projects/claude/microvm-spike/`):

- **Old deka monorepo crates** (`gild`, `gild-virt`, `gild-agent`, `gild-chain`, `gild-vault-client`): they `cargo check --workspace --all-targets` clean on demon (65 s, no sccache configured there). But there is **no Rust Firecracker backend in them**: `gild/src/backend.rs` is only the 34-line `VmBackend` trait, and `gild-agent` is a systemd unit manager, not an exec agent. `gild-virt/src/macos.rs` is a Virtualization.framework prototype (objc2) that boots a kernel plus initramfs and runs commands by parsing the console; it has no disk, no vsock, and was written against arm64. It is the starting point for the `vz` backend, not a finished one.
- **The Linux path that worked was TypeScript** (`demon:/var/lib/git-server/repos/gild/gild.git`: `core/firecracker/real-client.ts`, `docs/vsock-protocol.md`, `deploy/nftables/gild.rules`, `deploy/rootfs/`). Ported: the Firecracker API call sequence, the vsock `CONNECT <port>` handshake and length-prefixed JSON framing, the read-only rootfs + tmpfs layout, the kernel args. The old guest (`/init.js` in `agent-rootfs-v8.ext4`) executes one command per connection with no streaming and injected credentials as base64 env vars.
- **Rewritten:** the guest agent (Rust, static musl, 566 KB) with streamed stdout/stderr, process-group kill on timeout or cancel, per-step env over the channel, and a `put` op; the runner integration; the policy layer; the OCI backend.

## Architecture in this PR

One interface (`src/isolation/session.ts: Isolation`), backends behind it, selected by `--isolation vm|container|host|none`. The runner's single exec point (`run`) either spawns locally (`none`, unchanged) or calls `session.exec`. The runner never branches on the backend.

- `vm` -> `firecracker`: shared read-only rootfs, per-job ext4 drive built with `mke2fs -d` from the job work dir (no root), vsock to the guest agent.
- `container` -> `oci:docker|podman`: hardened (`--cap-drop ALL`, `no-new-privileges`, `--read-only`, tmpfs `/tmp`, pids/memory/cpu limits, `--network none` by default, non-root uid), work dir bind-mounted at `/workspace`, same agent over `docker exec -i ... --stdio`. A FreeBSD jail backend slots in as another `container` implementation; bhyve as another `vm` one.
- `host` -> `os-user`: a dedicated unprivileged OS user (old `sandbox = "host"`), same agent over `sudo -n -u <user> -- <agent> --stdio --shared` (see "host tier" below).
- macOS `container` -> `oci:docker@colima`: the same hardened `docker run`, against Colima's socket (see "Colima" below).
- Secrets: the token-bearing `git clone` stays on the host. Step env (including secrets) travels only inside the exec frame; checked that the secret string is absent from the VM image, the serial log, the job log and `/proc/cmdline`.
- Policy (`src/isolation/policy.ts`, 9-case matrix test): flag, then job `isolation:`, then agent profile, then host default (`isolation.json`), most specific wins; a request below the host `floor` is refused, never changed; a requested level that is unavailable is refused, never downgraded. With no request: strongest available of vm, container, host, else refuse; `none` is only ever explicit and is labelled unisolated. `gild runner start` refuses to start on a host with no backend unless `--isolation none` is given, and says how to fix it.
- Level is shown in job logs (`[gild: isolation: vm (vm), requested by flag]`, `steps run in vm (firecracker)`) and by `gild status` with no id (backends available, floor, default, outcome).

## Measurements (demon, 4 cores, shared; Firecracker 1.15.1, kernel 5.10.245, Ubuntu rootfs v8)

| figure | value |
|---|---|
| cold boot to vsock-answering guest agent, original boot args (3 runs) | 1212 / 1196 / 1192 ms |
| same, with `i8042.noaux i8042.nokbd i8042.nopnp i8042.dumbkbd quiet` (3 runs) | 308 / 312 / 309 ms |
| packing the checkout into the per-job ext4 | ~48 ms (small repo) |
| microVM ready inside `executeJob` (2 runs) | 327 / 301 ms |
| whole 7-step probe job in a VM (clone + boot + steps + teardown) | ~620 ms |
| same job with `--isolation none` / container | 3.5 s / 2.0 s (includes first-run git warmup) |
| firecracker process RSS, idle guest, 256 MiB configured | 97 MB |
| exec round trip over vsock (`echo hi`) | 4.7 - 7.0 ms |

The 1 s target is met by cold boot alone: the stock 5.10 kernel spends ~500 ms probing a PS/2 keyboard that does not exist; the kernel args above remove it. No snapshot or warm pool is needed for the runner. Revisit for `spawn --vm` interactivity only if 0.3 s feels slow.

## Isolation proof (real `executeJob`, fake forge, same 7 steps per level)

Run: `GILD_ISOLATION_E2E=<dir> bun test src/runner-isolation.e2e.test.ts` (see test header). "ok" = the step succeeded, "blocked" = it failed.

| step | none (host) | container | vm |
|---|---|---|---|
| checkout present, build in it | ok | ok | ok |
| write inside the checkout | ok | ok | ok |
| write outside the checkout (a host dir) | ok | blocked | blocked |
| read a file in the host user's home tree | ok | blocked | blocked |
| connect to a listener on the host LAN address (192.168.1.107) | ok | blocked | blocked |
| connect to 169.254.169.254 | blocked (no route on demon) | blocked | blocked |
| secret in step env reaches the step, not argv/log/cmdline | ok | ok | ok |

Caveat, stated plainly: the LAN and metadata results for container and vm are "blocked" because, on demon today, both run with **no network at all** (the network is not set up there). The filtered-egress mode is implemented and unit-tested, but NOT proven live because it needs root (below).

## Egress (`scripts/vm-network-setup.sh`)

One idempotent script, run once as root: bridge `gildbr0` plus a pool of 16 tap devices owned by the runner user and isolated from each other, a docker network `gild-egress` on bridge `gildbr1`, and an nftables table `inet gild_vm`: guests may reach the internet (masqueraded) but not the host (input from the bridges is dropped), nor 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 (metadata), loopback or multicast; all guest IPv6 is dropped; nothing initiates connections toward guests. The rules are installed before any bridge or tap exists. `down` removes everything; `--persist` writes a systemd unit.

### Live proof on demon (after `sudo scripts/vm-network-setup.sh`)

`src/isolation/network.e2e.test.ts`; same probes in a guest, and a control that the host itself reaches every blocked target (listener on 0.0.0.0:18099 plus real LAN hosts), so "blocked" is the isolation.

| probe | host (control) | container (gild-egress) | vm |
|---|---|---|---|
| https://gild.gg (any HTTP answer; 403 to non-browsers) | n/a | reachable | reachable |
| DNS `getent hosts gild.gg` | n/a | reachable | reachable |
| demon IPs 192.168.1.107, 192.168.1.79, 172.30.0.1, 172.19.0.1, 172.18.0.1, 10.139.0.1 (LAN, bridges) | reachable | blocked | blocked |
| demon tailnet IP 100.98.66.98 | reachable | blocked | blocked |
| LAN hosts 192.168.1.254:80, 192.168.1.29:80 | reachable | blocked | blocked |
| 100.100.100.100:80 (100.64/10) | reachable | blocked | blocked |
| bridge gateway 172.31.255.1 | reachable | blocked | blocked |
| 169.254.169.254:80 | no route on this host | blocked | blocked |

Two VMs cannot reach each other (`two VMs cannot reach each other`): VM A (172.31.255.10) listens and reaches itself; VM B (172.31.255.11) cannot connect to it (tap ports are bridge-isolated).

Found while proving this: (1) docker's iptables FORWARD policy is DROP and accepts only its own bridges, so the script now also accepts `gildbr0` in `DOCKER-USER` (our nft drops run first and are final); (2) the guest had no loopback, so `lo` is now brought up in `init-gild.sh`.

Runtime behaviour (`src/isolation/network.ts`): `egress: auto` (default) gives a VM a tap when the bridge and taps exist and are owned by this user, otherwise no network device; `block` never; `allow` refuses to start with "Needs Sami" if not set up. Containers follow the same rule with the `gild-egress` network (never the default bridge). The state is printed in `gild status` and in every job log. Tested both ways (`network.test.ts`: state detection, slot locks incl. dead-pid takeover, auto/block/allow, container network). **Not tested live:** the nftables ruleset itself (`nft -c` needs root) and a VM actually using a tap.

## gild spawn --vm

`gild spawn --vm claude` (fixture agent in tests): the host worker keeps the terminal, session socket, hooks, injection queue and report path; only the agent process runs on a pty inside a Firecracker VM (`guest-agent` op `pty`, forkpty, frames for input and resize). Hook commands inside the guest are `gild-guest-agent hook ...`, which forward over vsock (guest port 9100, host `<vsock uds>_9100`) to the host, accepted only for this session's id, and then delivered to the session socket exactly as before, so state, `gild send` gating and `gild events` behave the same. The guest env is a fixed baseline plus adapter additions and allowlisted names, never the host env. The current directory is packed into the VM (limit 2 GiB); changes come back at exit and with `gild sync <id>` (below). Script agents (the fixture) are copied into the guest; native agents must exist in the guest image. `--vm` never falls back to running on the host: no terminal, no Firecracker, or a failed boot is an error.

Proof (`scripts/fixtures/vm-spawn-harness.py`, via `src/spawn-vm.test.ts`, on demon): agent cwd is `/workspace`, host env var absent in the guest, `gild send` delivered through the queue, hook-driven state idle -> busy -> idle, `gild events` stream, outer-terminal typing, resize 24x80 -> 40x120 seen by the guest pty, clean exit 0, no leftover firecracker process. Ready in 1.1 s including bun start-up.

## spawn --vm: working-directory sync (second slice)

**Why not virtio-fs.** The old gild mounted workspaces with virtio-fs (`docs/virtiofs.md`), but that needs a Firecracker with `PUT /vhost-user-fs`. Stock Firecracker 1.15.1 on demon has only `vhost-user-blk` (checked in the binary's strings), and the old setup also ran virtiofsd as root (`--inode-file-handles=mandatory` needs `CAP_DAC_READ_SEARCH`). So the guest keeps working on its ext4 copy, and the sync is defined as follows.

**When.** On demand with `gild sync <id>` (a new session-socket request), and always when the session ends: the agent exits, or gild gets SIGHUP/SIGTERM. The last sync runs before the VM is stopped.

**What.** Three-way, per path, against a baseline. The baseline is the host tree hashed just before boot, then moved forward after each sync.
- Changed only in the guest: applied to the host. This covers files, directories, symlinks, deletes and mode changes.
- Changed on both sides: the host copy is kept. The guest's version is saved under `~/.gild/sessions/<id>.conflicts/<path>` and reported. Nothing is merged and nothing is dropped silently.
- Changed only on the host: never touched.

**The guest is untrusted.**
- Paths with `..`, absolute paths and empty components are rejected.
- Nothing is written through a symlink: every ancestor must be a real directory on the host, and writes go to a temp name and are renamed over the target.
- File bytes must match the sha256 the guest listed.
- A sync over 2 GiB is refused.

**How it works.**
- Guest-agent ops `list` (walk without following links, sha256 per file) and `get` (stream one file).
- Host side: `src/isolation/sync.ts`. `hostManifest` produces the same entry shape the agent produces.

**Proof.**
- `scripts/fixtures/vm-sync-harness.py` (via `src/spawn-vm.test.ts`) on demon, fixture agent only:
  - the guest edits, creates, deletes, chmods, makes a nested dir and a symlink, and edits a file the host also edited;
  - before `gild sync` the host is unchanged (it really is a copy);
  - after it, every change is on the host and the both-sides file keeps the host version, with the guest copy saved outside the project;
  - a second sync carries nothing;
  - a later change arrives at agent exit.
- `gild sync` took 0.30 s for that project.
- **Revert proof:** with `syncBack` made a no-op, the harness fails (`AssertionError: vmsync: 0 written, 0 deleted, 0 conflicts`).
- Unit tests (`sync.test.ts`, 6 cases) include a hostile guest that lists `evil -> <outside dir>` plus `evil/pwned`, replaces `src/` with a link, and sends `../escape`, `/abs` and `a/./b`. Nothing lands outside the root. **Revert proof:** with the ancestor check removed, that test fails.

## host tier (second slice)

`host` is the third level in the order vm, container, host, refuse. Steps run as a dedicated unprivileged OS user, `gild-<name>`, one per runner or agent. The old fleet already worked this way on demon (`sudo -n -u agent-<slug>`).

**One-time owner setup:** `scripts/host-user-setup.sh <user> <owner> --agent <gild-guest-agent>`, with Linux and macOS variants. `--dry-run` prints every command.
- Creates the user and group: no shell and no password; `dscl` on macOS, a hidden 401-499 id.
- Adds the owner to the group.
- Creates `<base>/home` (0700) and `<base>/work` (2770, owner:group). `<base>` is `/var/lib/gild-host/<user>` on Linux and `/Users/Shared/gild-host/<user>` on macOS.
- Installs the agent root-owned at `/usr/local/libexec/gild/gild-guest-agent`.
- Writes one sudoers rule, `<owner> ALL=(<user>) NOPASSWD: /usr/local/libexec/gild/gild-guest-agent --stdio --shared`, checked with `visudo -cf` first.
- Firewall for that uid. Linux: nftables `meta skuid` rejects 127/8 (except the 127.0.0.53 resolver), 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 and the IPv6 equivalents, via a systemd unit. macOS: a pf rule with the `user` match in anchor `com.apple/gild-host-<user>`, loaded by a LaunchDaemon, so `pf.conf` is not edited.
- Writes `/etc/gild/host-users/<user>.json`.

**Detection** (`src/isolation/host-user.ts`) reads that marker and never runs sudo. It requires all of the following:
- the uid matches the marker, and is neither 0 nor the runner's own uid;
- the owner matches the current user, and the current user is already in the group (otherwise the fix shown is "log out and in");
- the agent is root-owned and not group- or other-writable;
- the work root is mode 2770 in that group.

`gild status` prints `host tier: configured, steps run as gild-runner (uid N), LAN denied`, or `not configured (...); Needs Sami: sudo scripts/host-user-setup.sh ...`.

**Run:**
1. The job directory is moved under the shared work root, with a symlink left at the old path so the runner's own code is unchanged.
2. It is chgrp'd and made group read/write.
3. The agent runs with `--shared` (umask 007), so files the step creates stay usable by the runner.
4. At close the directory is moved back.

The guest path mapping is the same `guestPath` every backend has.

**What it isolates:** the owner's home and every other checkout, plus the LAN via the uid firewall. **What it does not isolate:** the kernel, world-readable files, CPU and memory. It is labelled `host (dedicated OS user)`, never VM or container.

**Proof:**
- The detection matrix (16 cases, incl. the script's own marker parsed by the detector for both OSes).
- The resolution order with fake machines: vm > container > host > refuse. A host-only machine under a `container` floor is refused, not downgraded.
- The real staging + exec + group-share + restore path, run as the current user (`runAs = []`), on the iMac and on demon.
- **Revert proofs:** offering `host` without the setup makes 5 detect tests fail; dropping the "not the runner's own uid" check fails its case.
- **Not proven:** the privilege switch itself, because it needs Sami's one-time setup (below).

Spawn on the host tier is not wired: hooks from a different uid need a relay into the owner's 0700 session directory, which is a follow-up.

## Colima: macOS container (second slice)

Colima 0.10.3 is installed and running on the iMac: vz, x86_64, virtiofs, docker runtime, socket `~/.colima/default/docker.sock`, default mount `$HOME` writable.

- **Detection** (`src/isolation/colima.ts`): `colima status --json` plus the `mounts:` list of `colima.yaml`, where an empty list means `$HOME` writable. Not installed gives `Needs Sami: brew install colima docker && colima start --vm-type vz --mount-type virtiofs`. Stopped, a non-docker runtime, or a missing socket each give their own reason and fix. 6 unit tests are built on the real `status --json` from the iMac.
- **Backend:** on macOS the `container` level always means Colima. It runs the same hardened `docker run` and `docker exec` with `--host unix://…/docker.sock`. The job directory and the agent must be inside a Colima mount. A job directory outside one, such as `/Volumes/Projects`, is refused before any container starts, with the fix: add the path to `mounts:` and restart Colima. Labels: `isolation: container (oci in Colima VM)` and `steps run in container (docker in Colima vz VM)`.
- **Network:** same policy, inside Colima's VM. With no `gild-egress` network there, a container gets no network, and the log says to run `colima ssh -- sudo sh -s up < scripts/vm-network-setup.sh`.
- **Live proof on the iMac:** a real `executeJob`, `GILD_ISOLATION_LEVELS=container`, against a fake forge, with a listener on the Mac's LAN address 192.168.1.185 that the host itself reaches (HTTP 200).

| step | container in Colima |
|---|---|
| checkout present, build in it | ok |
| write inside the checkout | ok |
| write outside the checkout | blocked |
| read a file next to the probe dir in the host home | blocked |
| connect to 192.168.1.185:18099 (Mac LAN) | blocked |
| connect to 169.254.169.254 | blocked |
| secret in step env, not in argv/log | ok |

The whole test run takes 7.5 s wall clock: bun, a git server, clone, container start and 7 steps. LAN and metadata are blocked here because the container has no network. Filtered egress inside Colima needs the root command above.
- **Revert proof:** treating a stopped Colima as running fails `Colima down means no container level`.

## macOS `vz` microVM: what porting gild-virt/macos.rs takes (not built)

`gild-virt/src/macos.rs` (594 lines, objc2) is a prototype:
- It builds `VZVirtualMachineConfiguration` with `VZLinuxBootLoader` (kernel plus initrd, `console=hvc0`) and a virtio console to a file.
- It runs commands by writing to the console and parsing it.
- There is no disk, no vsock and no network, and the test boots an Alpine initramfs from `/tmp`.

Needed on both Intel and Apple silicon:
1. **A helper binary, not in-process.** VZ objects need a run loop and callbacks, and the host side of vsock is `VZVirtioSocketDevice.connectToPort` (an objc callback), not a unix socket.
   - Build a small `gild-vz` Rust binary from macos.rs.
   - It should expose a unix socket that speaks Firecracker's `CONNECT <port>\n` handshake, and the reverse direction for hooks (`<uds>_<port>`).
   - Then `firecracker.ts`'s `vsockChannel`, `guestExec`, `guestPty` and the hook relay are reused unchanged. Only the launcher differs.
2. **Devices:**
   - `VZVirtioBlockDeviceConfiguration` (read-only rootfs plus the per-job ext4, `VZDiskImageStorageDeviceAttachment`);
   - `VZVirtioSocketDeviceConfiguration`;
   - `VZVirtioFileSystemDeviceConfiguration` (virtio-fs is built into macOS 12+). With virtio-fs, `spawn --vm` on a Mac can share the directory live and skip the copy and sync.
   - Network: `VZNATNetworkDeviceAttachment` (no entitlement) or none. NAT reaches the Mac's LAN, so filtered egress needs a root pf rule on the vmnet bridge ("Needs Sami"); until then use no network.
3. **Guest kernel:** VZ is virtio-PCI, while the Firecracker kernel boots with `pci=off` on virtio-MMIO. The kernel needs `VIRTIO_PCI`, `VIRTIO_BLK`, `VIRTIO_VSOCKETS`, `VIRTIO_CONSOLE` (hvc0) and `VIRTIO_FS`. Plan on a separate kernel build. `init-gild.sh` and the guest agent are unchanged.
4. **Signing:** the `com.apple.security.virtualization` entitlement with an ad-hoc signature (`codesign -s - --entitlements …`). This needs no developer account and shows no dialog. Add it to `bun run pack` for the darwin packages.

Per architecture:
- **Intel (this iMac, macOS 26.7, `kern.hv_support=1`):** an x86_64 guest, so the existing rootfs and musl agent are reused. The kernel must be in a form VZLinuxBootLoader accepts on x86 (bzImage). Whether it accepts the uncompressed vmlinux Firecracker uses has to be tried.
- **Apple silicon:**
  - an arm64 guest: an uncompressed arm64 `Image` (VZ refuses compressed kernels there), an arm64 rootfs and an `aarch64-unknown-linux-musl` agent;
  - x86_64 toolchains in jobs would need Rosetta for Linux (`VZLinuxRosettaDirectoryShare`, macOS 13+).
  - Both images should come out of the same rootfs build in CI.
- **Estimate:** the helper is about 600-800 lines (most of macos.rs is reusable bindings), plus the kernel config, the arm64 image build and the codesign step. Boot time has to be measured. Firecracker's 0.3 s came from the i8042 boot arguments, which do not apply to VZ.

## Needs Sami

- Egress allowed with LAN/metadata denied needs a tap device per VM (or a docker bridge) plus nftables rules, which need root. Rules to base on `deploy/nftables/gild.rules` (old) with the destination set `10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16` rejected on the guest bridge. Exact commands to be written with the tap manager (next steps 1). Until then `egress: allow` is refused with a clear error.
- macOS Colima is installed and running on the iMac; nothing needed for `container` there. For filtered egress (instead of no network) inside Colima: `colima ssh -- sudo sh -s up < scripts/vm-network-setup.sh` (from this checkout). For job directories outside `$HOME`, add them under `mounts:` in `~/.colima/default/colima.yaml` and `colima restart` (this restarts the other containers on it).
- host tier, per machine and per dedicated user: `sudo scripts/host-user-setup.sh gild-runner <owner> --agent <gild-guest-agent built for that OS>`, then log out and in once. Review first with `--dry-run`. Then add `"host": {"user": "gild-runner"}` to `isolation.json`.

## Real agent login inside a VM (spawn --vm, design only)

Never copy credential files into the image. Options, best first: (1) host-side broker: the host keeps the login, the VM gets a per-session short-lived token or a vsock proxy that adds the credential on the way out (the model API call is the only thing that needs it); (2) inject at spawn over vsock into a tmpfs path in the guest (`put` op, mode 0600), removed with the VM, never on a disk image (this is what the old gild did with env base64); (3) per-VM login done once interactively inside the guest, stored on a per-agent persistent drive. Recommend (1) for hosted pools and (2) for local `--vm`.

## Recommended architecture

- Local Linux: Firecracker as built here; needs `/dev/kvm` access and a kernel+rootfs (`scripts/build-vm-rootfs.sh`). Local Mac: Virtualization.framework (`vz`) via the revived `gild-virt` pattern with the same agent over vsock (VZVirtioSocketDevice); containers via Colima as the fallback tier.
- Gild-hosted pool: our own KVM hosts first (a 4-core/26 GB box runs dozens of 0.3 s, ~100 MB VMs; cost is the box, flat), Fly Machines as burst (Firecracker underneath, per-second billing, ~0.3 s start, but egress/LAN policy is theirs and per-job cost scales). Decide with real job volume; the `Isolation` interface is the same for both.

## Server side, for gild-site (not implemented here)

Org/repo isolation floor in settings; runners report their capability set (levels available) at registration and on poll; the queue only offers a job to a runner whose levels satisfy `max(floor, job isolation)`; the actual level used is recorded per job and shown on the run page; the workflow job `isolation:` key is sent in the assignment (already accepted by `Assignment.isolation`).

## Next steps (issue-sized)

1. Run `sudo scripts/vm-network-setup.sh` on demon, then prove LAN/metadata denied and internet allowed from a VM and a container (and `nft -c` the ruleset).
2. `spawn --vm`: native agents in the guest image; model-login broker. (Sync back: done in the second slice.)
3. macOS `vz` backend: `gild-vz` helper per the write-up above (Intel first, then arm64 image + kernel).
4. Host tier: prove the privilege switch live after Sami's setup (same 7 probes as the isolation table); wire `spawn` onto it with a hook relay across uids. Colima: prove filtered egress after the in-VM network setup.
5. `actions/setup-*` and upload-artifact inside a guest (tools preinstalled today; artifacts are no-ops already).
6. Guest image build in CI; agent version check on boot; persistent per-agent drive.
7. Server side above.
