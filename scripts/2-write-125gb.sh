#!/usr/bin/env bash
# Step 2: with the 125 GB card plugged in.
# Writes the original system onto it, drops the unused 8th partition,
# grows GAMES (partition 7) to fill the card and formats it FAT32.
# ERASES the 125 GB card.
set -euo pipefail

DEV=${1:-/dev/sda}
IMG=${2:-$HOME/k36-work/original-system.img}
TARGET_SECTORS=262144000      # size of the 125 GB card

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
size=$(blockdev --getsz "$DEV")
[ "$size" = "$TARGET_SECTORS" ] || { echo "$DEV is $size sectors, not the 125 GB card. Aborting."; exit 1; }
sha256sum -c "$IMG.sha256"

for p in "$DEV"?*; do umount "$p" 2>/dev/null || true; done

dd if="$IMG" of="$DEV" bs=1M conv=fsync status=progress

sfdisk --relocate gpt-bak-std "$DEV"   # move backup GPT to the end of the bigger card
sfdisk --delete "$DEV" 8 || true
echo ',+' | sfdisk --no-reread -N 7 "$DEV"
partprobe "$DEV"; sleep 2

mkfs.vfat -F 32 -n GAMES "${DEV}7"
sync
parted -s "$DEV" unit s print
echo "Done. Replug the card so it mounts, then copy the games back."
