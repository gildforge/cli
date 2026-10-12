# Same Intel Mac: host to Ubuntu VM demo plan

Required video path: native host mode on Sami's Intel Mac, stop/finish that
execution, then explicitly select Ubuntu guest VM mode for the same agent identity
on that same Mac, with real pinned skill instructions and coding/development tools.
A VM selection is a fresh immutable admitted execution; it is not migration of an
already running host process. This planning checkpoint authorizes no build, image
or global install, boot, credential/provider call, network change or publication.

## Current evidence and first prerequisite

Read-only inventory: uname x86_64; kern.hv_support=1. Existing
/Volumes/Projects/codex/gild-cli-r/.tmp/gild-vz is132,320-byte Mach-O x86_64 with
com.apple.security.virtualization entitlement. It has not been executed or tied to
current source by this checkpoint. Global /usr/local/bin/gild reports0.6.8; released
source base/held package0.6.9. Host Codex reports0.160.1, Node26.3.1, Bun1.4.0.
These host versions do not establish guest installation or compatibility.

Published0.6.9 VM manifest: protocol2/ca5d606; linux-x64 and darwin-arm64 only.
No architecture substitution. Current VZ loader is native Virtualization.framework
with virtio PCI block/console/vsock/filesystem/network; it needs a matching Intel
Linux bzImage. Published Firecracker vmlinux is not proven a compatible VZ kernel.
The same existing VZ backend/helper is retained; no alternative hypervisor.

The designated lookup is now complete: no genuine custom rootfs was found in the
checked local Gild checkout/cache/VZ locations; apparent ext4 files were fixtures.
This is scoped absence, not a scan of every device or machine. Historical
/Volumes/Projects/claude/gild-cli-microvm2/FINDINGS.md mentions
agent-rootfs-v8.ext4 on Demon; its exact remote path/content is unverified. Do not
wait for or duplicate that lookup, contact another machine, or assume that image
contains particular tools. Published Linux-x64 Ubuntu24.04 rootfs is a possible
input requiring separately approved download/integrity/protocol/tool validation.
Existing helper x86_64 provenance/execution remains unverified. See the concrete
[kernel-only proposal](intel-vz-kernel-build-proposal.md) for the source patch and
separate build/check/boot/rehearsal approval boundaries.

## Smallest source/build proposal after reconciliation

1. Keep existing vz/gild-vz.swift and src/isolation/vz.ts. Validate the existing
helper's architecture, entitlement and source/provenance; rebuilding/signing or
executing its check remains a separately authorized action. Keep the current
protocol2 guest agent/init/vsock/workspace contract. The existing handshake checks
protocol only; exact guest/helper/harness version and artifact provenance must be
verified separately for admission, not inferred from diagnostic version text. Reuse a verified Ubuntu x64 rootfs if compatible; preserve the original
image and record any changes as a new independently digested candidate.

2. Add only the missing x86 VZ kernel recipe/config to the existing
scripts/build-vm-guest.sh path. Current script compiles a VZ kernel only on arm64.
Candidate uses existing Linux6.12.112 recipe, with explicit upstream tarball
checksum recorded before any build. Select by actual Docker/build architecture;
for x86 use ARCH=x86, bzImage target and copy arch/x86/boot/bzImage. Do not label
an ARM Image or Firecracker MMIO kernel as Intel VZ support. Keep the ARM path.

3. x86 fragment must enable64-bit x86/required CPU/APIC/ACPI/PCI discovery and
virtio-pci/MSI, ext4/block, virtio console with hvc0, virtio-vsock, fuse/virtio-fs,
virtio networking/RNG, devtmpfs/tmpfs/proc/sysfs, ELF/scripts and UNIX98 PTYs as
built-ins. Translate ARM-only PCI_HOST_GENERIC/RTC_PL031 to the actual x86
requirements, not copied ARM options. No initramfs/modules unless an explicit
revised boot recipe requires them. Fail build if any requested built-in option
is missing, and retain complete final.config plus kernel/image checksums.
init-gild.sh mounts the workspace share, sets the supplied clock and serves port9002;
these actual capabilities must be present. Exact x86 Kconfig/build source requires
review before invoking a heavy kernel/rootfs build; this document is not that patch.

4. Use existing owner-supplied vm.kernel/vm.rootfs/vm.vz settings for the demo
before any new published darwin-x64 release. Preparing concrete configuration is
reversible, but do not install/write shared owner configuration under this plan.
Local candidate manifest must record architecture, source/base-image digests,
kernel config/artifact digests, rootfs digest, guest protocol and agent/CLI version.
A version string or an ext4 filename is not compatibility evidence.

## Tooling and real skill evidence

First reuse versions actually found in the older image. A minimum smoke task can
be a small JavaScript regression in an explicitly approved demo checkout, using
its existing test command; the final repository/task choice must be recorded.
No compiler/toolchain expansion is needed until that choice demands it.

If the chosen image lacks the required coding CLI, the bounded candidate is Linux
x64 Codex0.160.1, matching the read-only host metadata evidence. Record the exact
upstream package/binary integrity and dependencies before any approved image edit;
it is not installed, a verified support tuple or mandatory upgrade from an adequate
existing Claude/Codex. For a Bun/Node-based task, an absent-runtime fallback can
reuse the repository's existing Linux recipe pins: Node24.21.0 (tarball SHA256
fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6) and
Bun1.3.14 (zip SHA256
951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f), with bash,
git, CA certificates, curl and required guest utilities. These are proposed reuse
pins from guest-agent/image/Dockerfile, not new downloaded artifacts or claims
that the old image needs them. Preserve existing adequate versions when evidenced.
An exact base-image/package-lock/artifact inventory and digested rootfs are required
before calling a rebuilt image reproducible; moving apt mirrors are not pinned.
Never bake credential/account directories, tokens, secrets or user-global skill
registrations into a rootfs. Real model/credential/spending permission and delivery
transport must be explicitly resolved before calls; do not work around auth.

Selected skill remains exact ECC verification-loop immutable pin, bundle digest
8642aec70aefee472151de8b27fc97a08ff9bb85bf927fb69afc53a4ae499d6c, preserving
SKILL.md and original MIT LICENSE. Byte/cache/materialization proofs only prepare
content. Real acceptance must separately demonstrate native on-demand instructions
in the admitted host and VM executions, a task effect/test result attributable to
the selected skill, pinned snapshot/report/version/identity binding and honest mode
limits. Metadata skills/list, an echo/PTy fixture, prepared files or synthetic
verified catalog values cannot stand in for that demonstration.

## Admission and staged verification prerequisites

Separate owner-initiated manual execution from the optional new central assignment
service. The existing manual spawn mode does not inherently require new Task/
OwnerAssignmentPolicy/claim APIs for a truthful owner-authorized demonstration.
Do not describe manual runs as centrally admitted or centrally permission-enforced.
Current native interactive spawn is the owner's ordinary OS user, not the dedicated
OS-user isolation runner; its sockets/private files do not provide same-user secret
protection. Existing configured mandatory isolation/network/identity controls must
hold; a missing control cannot be relabeled enforced. An exact harness/model/skill
support claim still requires actual measured delivery/effects, not catalog fixtures.

For the manual video, preserve the same approved agent identity, finish/stop HOST,
then start a distinct fresh GUEST session with captured immutable input/artifact
hashes and independently recorded result. Raw session ID alone does not prove the
new central immutable admission protocol. Coordinator delegation, automatic grants,
foreign approval and full Settings CRUD/rollback may remain explicitly unavailable
under Sami's simplified demo direction. They become dependencies only if those
specific features are included in the video's actual claims. Do not invent a local
consent service or bypass current configured mandatory controls to show them.

Once separately authorized, first boot/handshake/device tests are local/offline with
owned disposable paths and exact owned PID cleanup. Verify x86_64/Ubuntu version,
protocol2/guest version, workspace copy boundaries, PTY/lifecycle/sync/recovery and
base image integrity before any coding agent. Then use approved authenticated
provider/tooling delivery and demonstrate actual skill-bearing task execution, with
bounded cancellation/results and no duplicated launch or secret persistence.
Do not silently fall back to host/container when VM is required.

/etc/gild/vz-network.json is absent here. Existing source defaults to no VM NIC
without approved filtered egress and refuses explicit allow. This plan does not
install pf/network rules or enable unfiltered NAT; record the appropriate network
and credential decision separately before provider-dependent guest execution.
Website retains the serial timing/heavy slot. No local pack/installed matrix,
kernel/rootfs build, boot or provider rehearsal runs until separately coordinated.
No release is necessary to review the source/design plan; draft/package0.6.9
and merge/release/deploy/permission holds remain.

-codex
