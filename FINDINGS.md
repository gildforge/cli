# gild microVM isolation: findings (first slice)

Status: Firecracker and OCI-container isolation for `gild runner` work end to end on demon. `spawn --vm`, macOS (`vz`), the `host` tier and tap/nftables egress are NOT done in this PR (see "Next steps").

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
- Policy (`src/isolation/policy.ts`, 9-case matrix test): flag, then job `isolation:`, then agent profile, then host default (`isolation.json`), most specific wins; a request below the host `floor` is refused, never changed; a requested level that is unavailable is refused, never downgraded. With no request: strongest available of vm, container, host, else refuse; `none` is only ever explicit. **Decision for review:** when nothing asks for a level and there is no floor, the runner keeps its old unisolated behaviour (`legacyDefault`), labelled "unisolated" in logs and `gild status`, so existing runners do not break on upgrade. Remove it to make isolation mandatory.
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

Caveat, stated plainly: the LAN and metadata results for container and vm are "blocked" because both run with **no network at all** (`egress: block`). That is not yet the brief's "egress allowed by default, LAN denied" mode.

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

1. `egress allow` for vm: tap manager + nftables rules, root setup command, test that LAN/metadata are denied while the internet works.
2. `gild spawn --vm <agent>`: PTY bridge over vsock with resize; host keeps socket/hooks/queue; test with `scripts/fixtures/events-agent.py`.
3. macOS `vz` backend: port `gild-virt/macos.rs`, add disk + vsock, entitlement + ad-hoc codesign, Intel and arm64.
4. Colima detection for `container` on macOS; `host` tier (unprivileged OS user).
5. `actions/setup-*` and upload-artifact inside a guest (tools preinstalled today; artifacts are no-ops already).
6. Guest image build in CI; agent version check on boot; persistent per-agent drive.
7. Server side above.
