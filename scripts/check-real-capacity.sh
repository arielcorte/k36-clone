#!/usr/bin/env bash
# Detects fake-capacity SD cards. Writes 1 MiB random markers every 4 GiB inside
# the GAMES partition (which is about to be formatted anyway), then reads them all
# back. On a fake card, markers past the real capacity wrap around and overwrite
# earlier ones, so they stop matching.
# A fake card may wrap writes onto the system partitions; the system can be reflashed.
set -euo pipefail

DEV=${1:-/dev/sda}
TARGET_SECTORS=262144000      # size of the 125 GB card
GIB=$((1024*1024*1024))

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
size=$(blockdev --getsz "$DEV")
[ "$size" = "$TARGET_SECTORS" ] || { echo "$DEV is $size sectors, not the 125 GB card. Aborting."; exit 1; }
for p in "$DEV"?*; do umount "$p" 2>/dev/null || true; done

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
offsets=$(seq 8 4 124)        # GiB; GAMES starts at ~6 GiB

# write high-to-low so markers inside the real capacity win any wrap-around
for g in $(echo $offsets | tr ' ' '\n' | sort -rn); do
    head -c 1M /dev/urandom > "$tmp/$g"
    dd if="$tmp/$g" of="$DEV" bs=1M seek=$((g * 1024)) oflag=direct conv=fsync status=none
done
sync; echo 3 > /proc/sys/vm/drop_caches

bad=0; last_good=0
for g in $offsets; do
    if dd if="$DEV" bs=1M skip=$((g * 1024)) count=1 iflag=direct status=none | cmp -s - "$tmp/$g"; then
        echo "  ${g} GiB: OK"; [ $bad = 0 ] && last_good=$g
    else
        echo "  ${g} GiB: MISMATCH"; bad=$((bad + 1))
    fi
done

if [ $bad = 0 ]; then
    echo "RESULT: card looks genuine (all markers up to 124 GiB read back correctly)."
else
    echo "RESULT: FAKE CARD. Real capacity is roughly ${last_good}-$((last_good + 4)) GiB."
fi
