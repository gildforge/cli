#!/bin/sh
/bin/mount -t tmpfs tmpfs /tmp
/bin/mount -t tmpfs tmpfs /run
/bin/mount -t devtmpfs none /dev
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t tmpfs tmpfs /root
/bin/mount -t tmpfs tmpfs /artifacts
/bin/mount /dev/vdb /workspace || echo "gild: no workspace drive"
[ -e /sys/class/net/eth0 ] && /bin/ip link set eth0 up
exec /usr/local/bin/gild-guest-agent --vsock 9002
