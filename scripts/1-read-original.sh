#!/usr/bin/env bash
# Step 1: with the ORIGINAL 50 GB card plugged in.
# Reads the system area (everything before the GAMES partition) into an image.
# Only reads from the card; never writes to it.
set -euo pipefail

DEV=${1:-/dev/sda}
OUT=${2:-$HOME/k36-work/original-system.img}
GAMES_START=12650496          # first sector of partition 7 on both cards
ORIGINAL_SECTORS=104960000    # size of the original 50 GB card

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
size=$(blockdev --getsz "$DEV")
[ "$size" = "$ORIGINAL_SECTORS" ] || { echo "$DEV is $size sectors, not the original 50 GB card. Aborting."; exit 1; }
[ "$(cat /sys/class/block/$(basename "$DEV")7/start)" = "$GAMES_START" ] || { echo "Unexpected layout. Aborting."; exit 1; }

mkdir -p "$(dirname "$OUT")"
dd if="$DEV" of="$OUT" bs=1M count=$((GAMES_START / 2048)) iflag=fullblock status=progress
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$OUT" "$(dirname "$OUT")"
sha256sum "$OUT" | tee "$OUT.sha256"
echo "Done: $OUT"
