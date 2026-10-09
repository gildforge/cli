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
for kv in $(cat /proc/cmdline); do
  case $kv in
    gild.ip=*) ip=${kv#gild.ip=} ;;
    gild.gw=*) gw=${kv#gild.gw=} ;;
    gild.dns=*) dns=${kv#gild.dns=} ;;
    gild.net=*) net=${kv#gild.net=} ;;
    gild.time=*) now=${kv#gild.time=} ;;
  esac
done
# vz has no clock source the guest trusts at boot; the host passes its time.
[ -n "${now:-}" ] && /bin/date -s "@$now" >/dev/null
# Firecracker: the per-job ext4 drive. vz: a virtio-fs share of a per-VM clone.
if [ -b /dev/vdb ]; then
  /bin/mount /dev/vdb /workspace
else
  /bin/mount -t virtiofs workspace /workspace 2>/dev/null || echo "gild: no workspace"
fi
/bin/ip link set lo up
if [ -e /sys/class/net/eth0 ]; then
  /bin/ip link set eth0 up
  if [ -n "${ip:-}" ]; then
    /bin/ip addr add "$ip" dev eth0
    /bin/ip route add default via "$gw"
    echo "nameserver ${dns:-1.1.1.1}" > /run/resolv.conf
    /bin/mount --bind /run/resolv.conf /etc/resolv.conf
  elif [ "${net:-}" = dhcp ]; then
    # vz NAT hands out addresses over DHCP.
    printf '%s\n' '#!/bin/sh' \
      'case $1 in bound|renew) ;; *) exit 0 ;; esac' \
      '/bin/ip addr add "$ip/${mask:-24}" dev "$interface"' \
      'set -- $router; /bin/ip route add default via "$1"' \
      'set -- $dns; echo "nameserver ${1:-1.1.1.1}" > /run/resolv.conf' > /run/udhcpc.sh
    chmod 700 /run/udhcpc.sh
    /bin/busybox udhcpc -i eth0 -q -n -t 5 -T 1 -s /run/udhcpc.sh >/dev/null 2>&1
    /bin/mount --bind /run/resolv.conf /etc/resolv.conf 2>/dev/null
  fi
fi
exec /usr/local/bin/gild-guest-agent --vsock 9002
