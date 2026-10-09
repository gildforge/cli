#!/bin/sh
/bin/mount -t tmpfs tmpfs /tmp
/bin/mount -t tmpfs tmpfs /run
/bin/mount -t devtmpfs none /dev
/bin/mkdir -p /dev/pts
/bin/mount -t devpts devpts /dev/pts
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t tmpfs tmpfs /root
/bin/mount -t tmpfs tmpfs /artifacts
/bin/mount /dev/vdb /workspace || echo "gild: no workspace drive"
/bin/ip link set lo up
if [ -e /sys/class/net/eth0 ]; then
  /bin/ip link set eth0 up
  for kv in $(cat /proc/cmdline); do
    case $kv in
      gild.ip=*) ip=${kv#gild.ip=} ;;
      gild.gw=*) gw=${kv#gild.gw=} ;;
      gild.dns=*) dns=${kv#gild.dns=} ;;
    esac
  done
  if [ -n "${ip:-}" ]; then
    /bin/ip addr add "$ip" dev eth0
    /bin/ip route add default via "$gw"
    echo "nameserver ${dns:-1.1.1.1}" > /run/resolv.conf
    /bin/mount --bind /run/resolv.conf /etc/resolv.conf
  fi
fi
exec /usr/local/bin/gild-guest-agent --vsock 9002
