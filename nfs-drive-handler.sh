#!/bin/bash
# Auto-mount/unmount USB drives under NFS export tree + manage NBD exports
# Called by udev on block device add/remove

ACTION="$1"
DEVNAME="$2"
DEVTYPE="$3"  # "disk" or "partition"

EXPORT_BASE="/srv/nfs/drives"
NBD_CONF_DIR="/etc/nbd-server/conf.d"
LOGFILE="/var/log/nfs-drive-handler.log"

log() { echo "$(date -Is) $*" >> "$LOGFILE"; }

nbd_export_name() {
  basename "$1"
}

add_nbd_export() {
  local dev="$1"
  local name
  name=$(nbd_export_name "$dev")
  cat > "${NBD_CONF_DIR}/${name}.conf" <<EOF
[${name}]
  exportname = ${dev}
  readonly = true
EOF
  log "NBD export added: ${name} -> ${dev}"
}

remove_nbd_export() {
  local dev="$1"
  local name
  name=$(nbd_export_name "$dev")
  rm -f "${NBD_CONF_DIR}/${name}.conf"
  log "NBD export removed: ${name}"
}

reload_nbd() {
  systemctl restart nbd-server 2>>"$LOGFILE" && log "NBD server restarted"
}

case "$ACTION" in
  add)
    sleep 1

    # NBD: export the raw block device (whole disk or partition)
    add_nbd_export "$DEVNAME"

    # Only mount partitions with filesystems, not whole disks
    if [ "$DEVTYPE" = "partition" ]; then
      FSTYPE=$(lsblk -no FSTYPE "$DEVNAME" 2>/dev/null | head -1)
      if [ -n "$FSTYPE" ]; then
        LABEL=$(lsblk -no LABEL "$DEVNAME" 2>/dev/null | head -1 | tr -s ' ' '_' | tr -d '/')
        if [ -z "$LABEL" ]; then
          LABEL=$(basename "$DEVNAME")
        fi

        MOUNTPOINT="${EXPORT_BASE}/${LABEL}"

        if mountpoint -q "$MOUNTPOINT" 2>/dev/null; then
          log "SKIP $DEVNAME already mounted at $MOUNTPOINT"
        else
          mkdir -p "$MOUNTPOINT"
          # Defer mount to systemd to escape udev's restricted mount namespace
          systemd-run --no-block \
            --unit="nfs-drive-mount-$(basename "$DEVNAME")" \
            --property="Type=oneshot" \
            /usr/local/bin/nfs-drive-mount.sh "$DEVNAME" "$MOUNTPOINT" \
            2>>"$LOGFILE"
        fi
      fi
    fi

    reload_nbd
    ;;

  remove)
    # NBD: remove export
    remove_nbd_export "$DEVNAME"

    # NFS: unmount if it was a mounted partition
    grep "$DEVNAME" /proc/mounts 2>/dev/null | awk '{print $2}' | while read -r MP; do
      umount -l "$MP" 2>>"$LOGFILE" && log "UNMOUNTED $MP ($DEVNAME)"
      rmdir "$MP" 2>/dev/null
    done

    for dir in "${EXPORT_BASE}"/*/; do
      [ -d "$dir" ] || continue
      if ! mountpoint -q "$dir" 2>/dev/null; then
        rmdir "$dir" 2>/dev/null
      fi
    done

    exportfs -ra 2>>"$LOGFILE"
    reload_nbd
    ;;
esac
