#!/bin/bash
# Mount a drive for NFS export — called via systemd-run from udev handler
DEVNAME="$1"
MOUNTPOINT="$2"
LOGFILE="/var/log/nfs-drive-handler.log"

sleep 1

if mount -o ro "$DEVNAME" "$MOUNTPOINT" 2>>"$LOGFILE"; then
  echo "$(date -Is) MOUNTED $DEVNAME at $MOUNTPOINT" >> "$LOGFILE"
  exportfs -ra 2>>"$LOGFILE"
else
  echo "$(date -Is) FAILED to mount $DEVNAME at $MOUNTPOINT" >> "$LOGFILE"
  rmdir "$MOUNTPOINT" 2>/dev/null
fi
