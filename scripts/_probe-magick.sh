#!/bin/bash
set -euo pipefail
echo BEGIN
IFS=':' read -ra PARTS <<< "$PATH"
for p in "${PARTS[@]}"; do
  if [ -n "$p" ] && [ -x "$p/magick" ]; then
    echo "MAGICK_IN_PATH=$p/magick"
  elif [ -n "$p" ] && [ -x "$p/magick.exe" ]; then
    echo "MAGICK_IN_PATH=$p/magick.exe"
  fi
done
echo DONE
