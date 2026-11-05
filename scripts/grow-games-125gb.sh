#!/usr/bin/env bash
# With the 125 GB card plugged in. Keeps the current system untouched,
# grows GAMES (partition 7) to fill the card and formats it FAT32.
# ERASES the GAMES partition only (back it up first).
set -euo pipefail

DEV=${1:-/dev/sda}
TARGET_SECTORS=262144000      # size of the 125 GB card
GAMES_START=12650496

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
size=$(blockdev --getsz "$DEV")
[ "$size" = "$TARGET_SECTORS" ] || { echo "$DEV is $size sectors, not the 125 GB card. Aborting."; exit 1; }
[ "$(cat /sys/class/block/$(basename "$DEV")7/start)" = "$GAMES_START" ] || { echo "Unexpected layout. Aborting."; exit 1; }
[ ! -e "${DEV}8" ] || { echo "Partition 7 is not the last one. Aborting."; exit 1; }

for p in "$DEV"?*; do umount "$p" 2>/dev/null || true; done

sfdisk --relocate gpt-bak-std "$DEV"   # make sure the backup GPT sits at the real end of the card
echo ',+' | sfdisk --no-reread -N 7 "$DEV"
partprobe "$DEV"; sleep 2

mkfs.vfat -F 32 -n GAMES "${DEV}7"
sync
sfdisk -l "$DEV"
echo "Done. Unplug and replug the card so it mounts."
