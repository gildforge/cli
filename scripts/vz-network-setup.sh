#!/bin/sh
# One-time owner setup for filtered egress from macOS `vz` microVMs.
#
# VZ NAT (vmnet shared mode) puts guests on a host bridge (192.168.64.0/24 by
# default) and NATs them out of the Mac, which also reaches the Mac itself,
# its LAN, the tailnet and link-local. Only pf (root) can deny that. This:
#   1. writes the pf anchor /etc/pf.anchors/gild-vz: guests may use the
#      vmnet DNS forwarder on the gateway, and nothing else in
#      10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8, multicast;
#      everything else (the internet) passes;
#   2. loads it under com.apple/gild-vz (stock pf.conf already evaluates
#      anchor "com.apple/*", so pf.conf is not edited) and enables pf, from a
#      LaunchDaemon so it survives reboots;
#   3. writes /etc/gild/vz-network.json, which gild reads (never pfctl) to
#      decide that a VM may get a NAT device.
# Without it, `vz` VMs get no network device at all.
#   sudo scripts/vz-network-setup.sh [--dry-run]
# Undo: launchctl bootout system/gg.gild.vz-net; pfctl -a com.apple/gild-vz -F all;
#       rm /etc/pf.anchors/gild-vz /etc/gild/vz-network.json /Library/LaunchDaemons/gg.gild.vz-net.plist
set -eu
dry=0
[ "${1:-}" = --dry-run ] && dry=1
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }
if [ "$dry" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "run with sudo (or add --dry-run to see what it writes)" >&2
  exit 1
fi

plist=/Library/Preferences/SystemConfiguration/com.apple.vmnet.plist
gw=$(defaults read "$plist" Shared_Net_Address 2>/dev/null || echo 192.168.64.1)
mask=$(defaults read "$plist" Shared_Net_Mask 2>/dev/null || echo 255.255.255.0)
prefix=0
for octet in $(echo "$mask" | tr . ' '); do
  case $octet in 255) prefix=$((prefix + 8)) ;; 254) prefix=$((prefix + 7)) ;; 252) prefix=$((prefix + 6)) ;;
    248) prefix=$((prefix + 5)) ;; 240) prefix=$((prefix + 4)) ;; 224) prefix=$((prefix + 3)) ;;
    192) prefix=$((prefix + 2)) ;; 128) prefix=$((prefix + 1)) ;; esac
done
subnet="$gw/$prefix"

run() { if [ "$dry" = 1 ]; then echo "+ $*"; else "$@"; fi; }
write() { # write <path> <mode>, content on stdin
  if [ "$dry" = 1 ]; then echo "--- $1 ($2)"; cat; else
    mkdir -p "$(dirname "$1")"; cat > "$1.new"; chmod "$2" "$1.new"; chown root:wheel "$1.new"; mv "$1.new" "$1"
  fi
}

write /etc/pf.anchors/gild-vz 0644 <<PF
# gild vz guests (vmnet shared network $subnet): internet yes, LAN/host/metadata no.
pass in quick inet proto { tcp udp } from $subnet to $gw port 53
pass in quick inet proto udp from any port 68 to any port 67
block drop in quick inet from $subnet to { 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4 }
PF
run pfctl -n -a com.apple/gild-vz -f /etc/pf.anchors/gild-vz

write /Library/LaunchDaemons/gg.gild.vz-net.plist 0644 <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>gg.gild.vz-net</string>
  <key>ProgramArguments</key><array>
    <string>/sbin/pfctl</string><string>-E</string>
    <string>-a</string><string>com.apple/gild-vz</string>
    <string>-f</string><string>/etc/pf.anchors/gild-vz</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
run launchctl bootstrap system /Library/LaunchDaemons/gg.gild.vz-net.plist

write /etc/gild/vz-network.json 0644 <<JSON
{"version":1,"network":"lan-denied","gateway":"$gw","subnet":"$subnet","anchor":"com.apple/gild-vz"}
JSON
echo "gild vz network filter installed (anchor com.apple/gild-vz, guests on $subnet). Check with: gild status"
