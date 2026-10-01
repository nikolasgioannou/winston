#!/usr/bin/env bash
# What only a real EC2 VM needs (docs/design.md §10, §18). The Docker build
# skips this script entirely (WINSTON_TARGET=docker).
set -euo pipefail

if [ "${WINSTON_TARGET:-}" != "ec2" ]; then
  echo "ec2.sh: not an EC2 build, skipping"
  exit 0
fi

# Admin access is SSM Session Manager only, never SSH (§10). Canonical's
# Ubuntu AMIs ship the agent as a snap; fail the build if that ever changes.
snap list amazon-ssm-agent >/dev/null
systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service

# A 2 GB swap file, so memory pressure restarts Chrome (it has a memory limit)
# instead of the kernel killing winstond (§10).
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# Ubuntu security updates, unattended, at a quiet hour: 08:00 UTC is 3–4 am
# in New York. No automatic reboots; Chrome's apt repository joins in M8.
apt-get install -y --no-install-recommends unattended-upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat >/etc/apt/apt.conf.d/52winston-unattended-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
CONF
install -d /etc/systemd/system/apt-daily-upgrade.timer.d
cat >/etc/systemd/system/apt-daily-upgrade.timer.d/quiet-hour.conf <<'CONF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 08:00 UTC
RandomizedDelaySec=30m
CONF

# The data volume at /home/winston (§10). The instance has two EBS disks, the
# root and the data volume; NVMe names (nvme0n1, nvme1n1) aren't stable, so
# the data disk is "the disk that doesn't hold /". It's formatted only when
# blank (a new user), labelled winston-home, and mounted by label, so a volume
# restored from a snapshot mounts as it is.
install -d /usr/local/lib/winston
cat >/usr/local/lib/winston/mount-home.sh <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
for _ in $(seq 1 60); do
  data_disk=$(lsblk -dno NAME,TYPE | awk -v root="$root_disk" '$2 == "disk" && $1 != root { print $1; exit }')
  [ -n "$data_disk" ] && break
  sleep 1
done
if [ -z "${data_disk:-}" ]; then
  echo "mount-home: no data volume attached" >&2
  exit 1
fi
device="/dev/$data_disk"
if [ -z "$(blkid -o value -s TYPE "$device" || true)" ]; then
  echo "mount-home: formatting the new data volume $device"
  mkfs.ext4 -q -L winston-home "$device"
fi
mountpoint -q /home/winston || mount -o defaults,noatime "$device" /home/winston
chown winston:winston /home/winston
chmod 0755 /home/winston
# The home layout lives on the volume, so create it once it's mounted.
systemd-tmpfiles --create /etc/tmpfiles.d/winston-home.conf
SCRIPT
chmod 0755 /usr/local/lib/winston/mount-home.sh
cat >/etc/systemd/system/winston-home.service <<'UNIT'
[Unit]
Description=Mount the data volume at /home/winston
After=local-fs.target
Before=winstond.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/winston/mount-home.sh

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable winston-home.service

# The agent's shell runs as winston, which mustn't reach the instance metadata
# service: it serves the instance role's credentials and the user data (with
# the one-time registration token). Invariant 1: no externally usable
# credential on the VM. winstond and root still can.
apt-get install -y --no-install-recommends nftables
cat >/etc/nftables-winston.conf <<'NFT'
table inet winston_imds {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid "winston" ip daddr 169.254.169.254 reject
    meta skuid "winston" ip6 daddr fd00:ec2::254 reject
  }
}
NFT
cat >/etc/systemd/system/winston-imds-block.service <<'UNIT'
[Unit]
Description=Keep the winston user away from the instance metadata service
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables-winston.conf

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable winston-imds-block.service
