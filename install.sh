#!/bin/bash
set -euo pipefail

# DeskyPi Installer
# Sets up a Raspberry Pi as a USB drive server with NFS, NBD, Samba, and a web dashboard.

INSTALL_DIR="/opt/deskypi"
SERVICE_USER="pi"

red()   { echo -e "\033[1;31m$*\033[0m"; }
green() { echo -e "\033[1;32m$*\033[0m"; }
blue()  { echo -e "\033[1;34m$*\033[0m"; }

if [ "$EUID" -ne 0 ]; then
  red "Please run as root: sudo ./install.sh"
  exit 1
fi

blue "=== DeskyPi Installer ==="

# ---------- 1. Dependencies ----------
blue "Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  nfs-kernel-server \
  nbd-server \
  samba \
  apfs-dkms \
  apfsprogs \
  > /dev/null

# Install Bun if not present
if ! command -v bun &>/dev/null; then
  blue "Installing Bun..."
  su - "$SERVICE_USER" -c 'curl -fsSL https://bun.sh/install | bash' > /dev/null
fi

BUN_PATH=$(su - "$SERVICE_USER" -c 'which bun')

# ---------- 2. Directory structure ----------
blue "Setting up directories..."
mkdir -p /srv/nfs/drives
mkdir -p /etc/nbd-server/conf.d
mkdir -p "$INSTALL_DIR"

# ---------- 3. Application files ----------
blue "Installing application files..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/server.ts" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/index.html" "$INSTALL_DIR/"

if [ ! -f "$INSTALL_DIR/defaults.json" ]; then
  cat > "$INSTALL_DIR/defaults.json" << 'DEFAULTS'
{
  "hostname": "",
  "username": "pi",
  "enableSsh": true,
  "sshKeys": [],
  "wifiNetworks": []
}
DEFAULTS
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ---------- 4. Drive handler scripts ----------
blue "Installing drive handler scripts..."
cp "$SCRIPT_DIR/nfs-drive-handler.sh" /usr/local/bin/
cp "$SCRIPT_DIR/nfs-drive-mount.sh" /usr/local/bin/
chmod +x /usr/local/bin/nfs-drive-handler.sh
chmod +x /usr/local/bin/nfs-drive-mount.sh

# ---------- 5. Udev rules ----------
blue "Installing udev rules..."
cp "$SCRIPT_DIR/90-nfs-drive-export.rules" /etc/udev/rules.d/
udevadm control --reload-rules

# ---------- 6. NFS exports ----------
if ! grep -q '/srv/nfs' /etc/exports 2>/dev/null; then
  blue "Configuring NFS exports..."
  echo '/srv/nfs  *(ro,fsid=0,no_subtree_check,root_squash,crossmnt)' >> /etc/exports
fi

# ---------- 7. NBD server ----------
if ! grep -q 'includedir = /etc/nbd-server/conf.d' /etc/nbd-server/config 2>/dev/null; then
  blue "Configuring NBD server..."
  cat > /etc/nbd-server/config << 'NBD'
[generic]
        allowlist = true
	user = root
	group = root
	includedir = /etc/nbd-server/conf.d
NBD
fi

# ---------- 8. Samba ----------
if ! grep -q '\[drives\]' /etc/samba/smb.conf 2>/dev/null; then
  blue "Configuring Samba share..."
  cat >> /etc/samba/smb.conf << 'SMB'

[drives]
   comment = USB Drives
   path = /srv/nfs/drives
   browseable = yes
   read only = yes
   guest ok = yes
   force user = root
SMB
fi

# ---------- 9. APFS module ----------
blue "Configuring APFS support..."
echo "apfs" > /etc/modules-load.d/apfs.conf
modprobe apfs 2>/dev/null || true

# ---------- 10. Systemd service ----------
blue "Installing systemd service..."
cat > /etc/systemd/system/deskypi-web.service << EOF
[Unit]
Description=DeskyPi Web Interface
After=network.target nfs-server.service nbd-server.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_PATH run server.ts
Restart=always
RestartSec=5
Environment=PATH=$(dirname "$BUN_PATH"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

# ---------- 11. Enable and start ----------
blue "Enabling services..."
systemctl daemon-reload
systemctl enable --now nfs-kernel-server
systemctl enable --now nbd-server
systemctl enable --now smbd nmbd
systemctl enable --now deskypi-web.service

green "=== DeskyPi installed ==="
green "Web dashboard: http://$(hostname).local"
green "Config file:   $INSTALL_DIR/defaults.json"
green ""
green "Plug in a USB drive to get started."
