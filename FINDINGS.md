# gild microVM isolation: findings (first slice)

Status: Firecracker and OCI-container isolation for `gild runner`, and `gild spawn --vm`, work end to end on demon. Egress is written but needs one root command to switch on. macOS (`vz`), Colima detection and the `host` tier are NOT done (see "Next steps").

## What the old gild code gave us, and what was rewritten

Found (all read-only copies under `demon:~/Projects/claude/microvm-spike/`):

- **Old deka monorepo crates** (`gild`, `gild-virt`, `gild-agent`, `gild-chain`, `gild-vault-client`): they `cargo check --workspace --all-targets` clean on demon (65 s, no sccache configured there). But there is **no Rust Firecracker backend in them**: `gild/src/backend.rs` is only the 34-line `VmBackend` trait, and `gild-agent` is a systemd unit manager, not an exec agent. `gild-virt/src/macos.rs` is a Virtualization.framework prototype (objc2) that boots a kernel plus initramfs and runs commands by parsing the console; it has no disk, no vsock, and was written against arm64. It is the starting point for the `vz` backend, not a finished one.
- **The Linux path that worked was TypeScript** (`demon:/var/lib/git-server/repos/gild/gild.git`: `core/firecracker/real-client.ts`, `docs/vsock-protocol.md`, `deploy/nftables/gild.rules`, `deploy/rootfs/`). Ported: the Firecracker API call sequence, the vsock `CONNECT <port>` handshake and length-prefixed JSON framing, the read-only rootfs + tmpfs layout, the kernel args. The old guest (`/init.js` in `agent-rootfs-v8.ext4`) executes one command per connection with no streaming and injected credentials as base64 env vars.
- **Rewritten:** the guest agent (Rust, static musl, 566 KB) with streamed stdout/stderr, process-group kill on timeout or cancel, per-step env over the channel, and a `put` op; the runner integration; the policy layer; the OCI backend.

## Architecture in this PR

One interface (`src/isolation/session.ts: Isolation`), backends behind it, selected by `--isolation vm|container|host|none`. The runner's single exec point (`run`) either spawns locally (`none`, unchanged) or calls `session.exec`. The runner never branches on the backend.

- `vm` -> `firecracker`: shared read-only rootfs, per-job ext4 drive built with `mke2fs -d` from the job work dir (no root), vsock to the guest agent.
- `container` -> `oci:docker|podman`: hardened (`--cap-drop ALL`, `no-new-privileges`, `--read-only`, tmpfs `/tmp`, pids/memory/cpu limits, `--network none` by default, non-root uid), work dir bind-mounted at `/workspace`, same agent over `docker exec -i ... --stdio`. A FreeBSD jail backend slots in as another `container` implementation; bhyve as another `vm` one.
- `host` (dedicated unprivileged OS user per runner, old `sandbox = "host"`): declared in the policy, NOT implemented; a request for it is refused as unavailable.
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

Runtime behaviour (`src/isolation/network.ts`): `egress: auto` (default) gives a VM a tap when the bridge and taps exist and are owned by this user, otherwise no network device; `block` never; `allow` refuses to start with "Needs Sami" if not set up. Containers follow the same rule with the `gild-egress` network (never the default bridge). The state is printed in `gild status` and in every job log. Tested both ways (`network.test.ts`: state detection, slot locks incl. dead-pid takeover, auto/block/allow, container network). **Not tested live:** the nftables ruleset itself (`nft -c` needs root) and a VM actually using a tap.

## gild spawn --vm

`gild spawn --vm claude` (fixture agent in tests): the host worker keeps the terminal, session socket, hooks, injection queue and report path; only the agent process runs on a pty inside a Firecracker VM (`guest-agent` op `pty`, forkpty, frames for input and resize). Hook commands inside the guest are `gild-guest-agent hook ...`, which forward over vsock (guest port 9100, host `<vsock uds>_9100`) to the host, accepted only for this session's id, and then delivered to the session socket exactly as before, so state, `gild send` gating and `gild events` behave the same. The guest env is a fixed baseline plus adapter additions and allowlisted names, never the host env. The current directory is packed into the VM (limit 2 GiB); changes inside the guest are not synced back yet. Script agents (the fixture) are copied into the guest; native agents must exist in the guest image. `--vm` never falls back to running on the host: no terminal, no Firecracker, or a failed boot is an error.

Proof (`scripts/fixtures/vm-spawn-harness.py`, via `src/spawn-vm.test.ts`, on demon): agent cwd is `/workspace`, host env var absent in the guest, `gild send` delivered through the queue, hook-driven state idle -> busy -> idle, `gild events` stream, outer-terminal typing, resize 24x80 -> 40x120 seen by the guest pty, clean exit 0, no leftover firecracker process. Ready in 1.1 s including bun start-up.

## Needs Sami

- Egress allowed with LAN/metadata denied needs a tap device per VM (or a docker bridge) plus nftables rules, which need root. Rules to base on `deploy/nftables/gild.rules` (old) with the destination set `10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16` rejected on the guest bridge. Exact commands to be written with the tap manager (next steps 1). Until then `egress: allow` is refused with a clear error.
- macOS: Colima must be installed by Sami for the `container` backend on Mac (`brew install colima docker`, `colima start --vm-type vz --mount-type virtiofs`); we only detect it. Not tried here.

## Real agent login inside a VM (spawn --vm, design only)

Never copy credential files into the image. Options, best first: (1) host-side broker: the host keeps the login, the VM gets a per-session short-lived token or a vsock proxy that adds the credential on the way out (the model API call is the only thing that needs it); (2) inject at spawn over vsock into a tmpfs path in the guest (`put` op, mode 0600), removed with the VM, never on a disk image (this is what the old gild did with env base64); (3) per-VM login done once interactively inside the guest, stored on a per-agent persistent drive. Recommend (1) for hosted pools and (2) for local `--vm`.

## Recommended architecture

- Local Linux: Firecracker as built here; needs `/dev/kvm` access and a kernel+rootfs (`scripts/build-vm-rootfs.sh`). Local Mac: Virtualization.framework (`vz`) via the revived `gild-virt` pattern with the same agent over vsock (VZVirtioSocketDevice); containers via Colima as the fallback tier.
- Gild-hosted pool: our own KVM hosts first (a 4-core/26 GB box runs dozens of 0.3 s, ~100 MB VMs; cost is the box, flat), Fly Machines as burst (Firecracker underneath, per-second billing, ~0.3 s start, but egress/LAN policy is theirs and per-job cost scales). Decide with real job volume; the `Isolation` interface is the same for both.

## Server side, for gild-site (not implemented here)

Org/repo isolation floor in settings; runners report their capability set (levels available) at registration and on poll; the queue only offers a job to a runner whose levels satisfy `max(floor, job isolation)`; the actual level used is recorded per job and shown on the run page; the workflow job `isolation:` key is sent in the assignment (already accepted by `Assignment.isolation`).

## Next steps (issue-sized)

1. Run `sudo scripts/vm-network-setup.sh` on demon, then prove LAN/metadata denied and internet allowed from a VM and a container (and `nft -c` the ruleset).
2. `spawn --vm`: sync guest changes back to the working directory; native agents in the guest image; model-login broker.
3. macOS `vz` backend: port `gild-virt/macos.rs`, add disk + vsock, entitlement + ad-hoc codesign, Intel and arm64.
4. Colima detection for `container` on macOS; `host` tier (unprivileged OS user).
5. `actions/setup-*` and upload-artifact inside a guest (tools preinstalled today; artifacts are no-ops already).
6. Guest image build in CI; agent version check on boot; persistent per-agent drive.
7. Server side above.
