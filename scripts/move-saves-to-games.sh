#!/usr/bin/env bash
# With the K36 card (50 GB original) plugged in.
# Makes Batocera keep /userdata/saves on the GAMES (FAT32) partition so
# Windows can back them up, and copies the existing saves there.
# The old saves stay on SHARE untouched as a fallback.
set -euo pipefail

DEV=${1:-/dev/sda}
LINE='sharedevice_part4=SAVES@/dev/mmcblk0p7:saves'

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
[ "$(lsblk -no LABEL "${DEV}5")" = BATOCERA ] || { echo "${DEV}5 is not BATOCERA. Aborting."; exit 1; }
[ "$(lsblk -no LABEL "${DEV}6")" = SHARE ]    || { echo "${DEV}6 is not SHARE. Aborting."; exit 1; }
[ "$(lsblk -no LABEL "${DEV}7")" = GAMES ]    || { echo "${DEV}7 is not GAMES. Aborting."; exit 1; }

BOOT=$(findmnt -no TARGET "${DEV}5"); SHARE=$(findmnt -no TARGET "${DEV}6"); GAMES=$(findmnt -no TARGET "${DEV}7")
[ -n "$BOOT" ] && [ -n "$SHARE" ] && [ -n "$GAMES" ] || { echo "Mount all card partitions first (replug the card)."; exit 1; }
CONF="$BOOT/batocera-boot.conf"

# 1. Config: back up, then add the SAVES mapping next to the other sharedevice lines
backup_dir="/home/${SUDO_USER:-root}/k36-work"
mkdir -p "$backup_dir"
install -m 600 -o "${SUDO_UID:-0}" "$CONF" "$backup_dir/batocera-boot.conf.bak"
cp -p "$CONF" "$CONF.bak-before-saves"
if grep -qE '^[ ]*sharedevice_part[0-9]+=SAVES@' "$CONF"; then
    echo "SAVES mapping already present, config left as is."
else
    sed -i "/^sharedevice_part3=/a $LINE" "$CONF"
    grep -qxF "$LINE" "$CONF" || { echo "Could not add the line. Restoring."; cp -p "$CONF.bak-before-saves" "$CONF"; exit 1; }
    echo "Added: $LINE"
fi
grep -nE '^sharedevice' "$CONF"

# 2. Copy existing saves to GAMES/saves (FAT32 keeps no owners/permissions)
mkdir -p "$GAMES/saves"
rsync -rt --modify-window=2 "$SHARE/saves/" "$GAMES/saves/"
echo "Copied $(find "$SHARE/saves" -type f | wc -l) files to $GAMES/saves"

sync
echo "Done. Eject the card, boot the console and check that a game still finds its save."
