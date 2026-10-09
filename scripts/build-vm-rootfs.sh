#!/bin/sh
# Build the guest rootfs for `gild runner --isolation vm` without root:
# copy a base Ubuntu ext4 image (bash, git, node, bun) and write the guest
# agent and its init into the COPY with debugfs. The base is never modified.
#   scripts/build-vm-rootfs.sh <base.ext4> <out.ext4> <gild-guest-agent (musl)>
set -eu
base=$1 out=$2 agent=$3
here=$(cd "$(dirname "$0")/.." && pwd)
[ "$base" = "$out" ] || cp --reflink=auto "$base" "$out"
chmod u+w "$out"
debugfs -w -f - "$out" <<CMDS
rm /init-gild.sh
rm /usr/local/bin/gild-guest-agent
write $here/guest-agent/init-gild.sh /init-gild.sh
set_inode_field /init-gild.sh mode 0100755
write $agent /usr/local/bin/gild-guest-agent
set_inode_field /usr/local/bin/gild-guest-agent mode 0100755
CMDS
