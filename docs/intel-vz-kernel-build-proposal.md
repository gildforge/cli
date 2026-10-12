# Intel VZ kernel-only candidate and approval packet

The current VZ backend accepts an x86 Linux bzImage, but the existing all-in-one
recipe only builds an ARM VZ kernel. The new explicit entry is:

```sh
scripts/build-vm-guest.sh --kernel-only <local-archive> <NEW-output-dir> <local-sha256:image-id> <local-docker-context> [jobs=2]
```

It delegates only to scripts/build-vz-kernel.mjs. Existing guest-agent/rootfs/ARM
behavior is unchanged. This kernel entry does not pull/build/tag a container image,
install packages, download archives, build guest tools/rootfs, boot anything,
change global config or touch credentials. Actual compilation has NOT run.

The kernel fragment enables64-bit generic x86/SMP/APIC/ACPI/PCI, built-in virtio
block/console/vsock/fs/network/RNG, ext4/devtmpfs/proc/sysfs/tmpfs, executable
formats and UNIX98 PTYs. Modules and initramfs are disabled. Kconfig resolution
must retain every requested option; an unsupported/dependency-suppressed option
fails before compilation. Native container architecture, final ELF64/x86_64
vmlinux header and x86 boot-protocol bzImage are checked. This is a recipe
candidate, not proof the kernel boots or an Ubuntu agent has tools/skills.

## Inputs and destination

- Archive: [Linux6.12.112.tar.xz](https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.112.tar.xz).
  SHA256 **164dc9d1f6c93c61a15e1f071c48379b467f2b17c469cce7223471968208ed03**,
  verified against [kernel.org's checksum text](https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc).
  Upstream index reports142M. No archive downloaded. Host streaming hash and a
  second in-container hash must match. No floating KERNEL_VERSION override.
- Proposed new owned base directory on the EXISTING internal Data volume:
  **/Users/sami/Documents/Codex/gild-cli-intel-kernel-70**. Input archive under
  inputs/linux-6.12.112.tar.xz; fresh output under kernel-6.12.112-run1.
  This directory has not been created. /tmp is not selected; no data moves/deletes.
- Required builder: an already-prepared LOCAL **linux/amd64** immutable Docker
  image ID `sha256:<64hex>`, and explicit existing LOCAL Unix-socket context.
  Both are currently UNKNOWN: no Docker inspection/pull/build is authorized or
  performed. Parent must supply the existing image/context ID, or obtain specific
  approval to inspect/prepare them. A mutable debian tag is rejected. Tools:
  gcc/binutils, make, flex, bison, bc, perl, python3, tar/xz, coreutils/grep and
  the GCC/libelf development dependencies needed by Linux x86 objtool. Missing
  tools fail; the kernel path never installs them. Toolchain versions and exact
  builder ID/context/endpoint are retained in kernel-evidence.json. Remote Docker
  contexts and implicit context changes are rejected; do not use Demon.
- Rootfs is NOT an input to this kernel-only operation. No local genuine custom
  rootfs was found by the completed designated lookup. A later proposed Ubuntu
  rootfs reuse/download is a separate permission and integrity/tooling step.

Capacity checkpoint: /Volumes/Projects238GiB/223GiB used/15GiB free,94%; internal
Data volume932GiB/613GiB used/303GiB free,67%. Use the internal owned directory,
not Projects. Conservative **13GiB extra disk budget**:142M compressed archive,
up to3GiB source tree allowance, up to5GiB object/intermediate/output allowance,
and roughly4GiB reserve for container/image/daemon overhead. This is a planning
allowance, NOT measured peak for the unbuilt config/toolchain. Require20GiB free
at the output volume and Docker storage before starting. After the first approved extraction failure, container source AND objects are
under `/build/work` in ONE fresh owned case-sensitive Linux Docker local volume.
The existing Docker filesystem is physically on internal Data and its ACTUAL
free space is checked; host `/out` holds final artifacts and evidence only. This
avoids GNU tar delayed symlink placeholder permission failures on Mac virtiofs.
Do not weaken extraction safety, drop source symlinks or run the compiler as root.
The base builder layers and any Docker VM disk remain wherever that approved
local daemon stores them. Their location/free space must be confirmed during the
separately approved Docker preflight; this proposal does not move daemon storage.
No rootfs is built, so do not include a rootfs rebuild in this disk budget.

## Concrete staged actions for Sami's approval

1. **Input/preflight permission**, after source review: create only the new owned
   internal directory; download the exact archive URL into inputs; validate the
   pinned checksum. Inspect the selected existing local Docker context/image and
   its storage/free space only. If no adequate builder exists, return its exact
   bounded preparation proposal before any package/image pull/build. No global
   Docker/context install/switch, root credential, host setup or cross-machine use.
2. **Kernel build permission**, after the image/context IDs are supplied: execute
   the following command from the signed CLI worktree. Variables stand for those
   approved actual inputs, NOT invented image names:

```sh
scripts/build-vm-guest.sh --kernel-only /Users/sami/Documents/Codex/gild-cli-intel-kernel-70/inputs/linux-6.12.112.tar.xz /Users/sami/Documents/Codex/gild-cli-intel-kernel-70/kernel-6.12.112-run1 "$GILD_KERNEL_BUILDER_IMAGE_ID" "$GILD_KERNEL_DOCKER_CONTEXT" 2
```

   Build is one native x86 container,2CPUs/4GiB RAM/512PID limit, no network,
   no pulls, read-only base/capabilities dropped, unprivileged owner UID/GID.
   Archive/fragment read-only inputs, exclusive new0700 host artifact directory,
   ONE fresh owned Linux scratch volume for source/objects. Only its initially
   empty root gets0700/owner UID/GID through a separate no-network initialization
   container with ONLY CHOWN capability; compiler stays unprivileged/ALL caps
   dropped. No host root/shared ownership changes. No borrowed rootfs, shared
   Docker tag or cache cleanup. Build script and copied
   fragment are frozen under output; artifact evidence binds their hashes.
3. **Artifact/check permission**: read only this candidate's bzImage,
   bzImage.config, kernel.fragment, build.sh, vmlinux-header.txt, toolchain.txt and
   kernel-evidence.json. Source/image/config/kernel hashes and x86 format checks
   are emitted by the builder. No guest-agent protocol/boot/support inference.
   Helper source build/ad-hoc signing/check is separately approved if existing
   x86 helper provenance cannot be verified; proposed existing command:

```sh
scripts/build-vz-helper.sh /Users/sami/Documents/Codex/gild-cli-intel-kernel-70/gild-vz
```

   This command executes `check` on this hypervisor-capable Mac; disclose that
   execution when asking approval. It is not a kernel-only build side effect.
4. **Offline boot permission**, only after helper/kernel/rootfs exact inputs and
   rootfs protocol/integrity are ready: clone the approved base rootfs to an owned
   run disk, use the existing helper run syntax with `--net none`, a new empty
   owned workspace share, owned socket/serial log, fixed2vCPUs/1GiB RAM and the
   existing kernelCommandLine('none',time). No coding agent/provider/network/
   credentials/global isolation config. Fill actual rootfs/helper paths/hashes
   before proposing the final pasteable command; they are still unknown here.
5. **Real rehearsal permission**, separate: chosen task/checkout/test, same
   approved agent identity, exact HOST/GUEST coding harness versions, model/effort,
   actual skill pins/body/license and allowed provider calls/spend, explicit
   credential-use and network destinations/control. First native HOST, stop/finish,
   then fresh Ubuntu GUEST on the SAME Intel Mac; two ordered real rehearsals.
   Inspect actual guest tools before proposing an install. Never bake/copy account
   directories or secrets into rootfs/argv/public logs. Existing VZ egress: block
   disables networking; auto without owner-installed pf marker gives no network;
   allow without it fails. Any pf/filtered-network setup needs its own precise
   approved system change; do not enable unfiltered NAT.

The kernel container writes its own container.cid and uses --rm. On a failed build,
preserve ONLY this new output for diagnosis; no success evidence is emitted. On
interruption, stop/remove only the exact owned CID recorded there, never a name
pattern/shared container/image. OWNED scratch source/objects and both failed and successful output are retained;
no volume or broad workspace deletion occurs. `scratch-volume.json` and final
`kernel-evidence.json` record the exact scratch volume/owner. Future cleanup is
limited to those explicit owned resources; no shared cleanup is performed.

## Manual demo scope and focused evidence

Manual owner-authorized spawn already exists; a new central coordinator/Task/
OwnerAssignmentPolicy service is NOT a prerequisite to every manual run. Native
interactive spawn runs under the owner's ordinary UID, not dedicated-user runner
isolation. VM --vm has explicit no-host-fallback, protocol checks and existing
workspace/env/sync protections; network controls above are real constraints.
Respect any configured mandatory control and source identity/profile-label checks.
Do not claim central immutable admission, protected same-UID credentials, exact
hostname broker policy or catalog support that the manual path does not implement.
Capture separate session IDs/input hashes/results for the same identity across
HOST then GUEST; those receipts do not automatically become central admission
snapshots. Missing image/harness/real skill/provider access are runtime dependencies;
full coordinator/admin/settings/history/scale/polish are optional follow-ups under
Sami's simplified direction unless included in the video's claimed feature set.

Focused non-build evidence after scratch correction:9tests/105assertions including actual wrong-archive
rejection before any Docker call, real entrypoint dispatch, plan flags/input bounds,
config and boot-format negatives, and actual shell syntax parsing. Three temporary
source guard removals each fail an intended Bun assertion (network argument,
required config, archive digest); subjects restored. No compilation/Docker/boot/
provider test, old572test/CI repeat or performance claim. Full formatting, Node/sh
syntax and diff validation accompany the checkpoint. New source needs its own
review; previous572 acceptance stays historical/data-only. Package0.6.9/held draft
and merge/release/deploy holds remain.


Actual approved input preparation (2026-10-12): existing Colima start and pinned
archive download completed; source148648524bytes/hash verified. Separate human
approval then allowed one derived builder on EXISTING exact Rust base adding
ONLY flex,bison,bc,libelf-dev (+necessary dependencies) inside the image.
Credential-free official deb.debian.org apt sources verified. Derived local native
image SHA2561c54d59cd5d0f8579f486e38f94cf2fc80d6277b824a9276de655fe2ee5b2e45;
packages flex2.6.4-8.2,bison2:3.8.2+dfsg-1+b1,bc1.07.1-3+b1,libelf-dev0.188-2.1.
Base was cached; no new base pull or host install. First attempt failed in tar
BEFORE Kconfig/compiler. Failed work/log retained. Parent authorized the bounded
Linux scratch correction and safe retry with same verified archive/builder and
limits; no guest boot/provider/security/global/release permission inferred.

-codex
