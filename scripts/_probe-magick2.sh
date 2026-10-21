#!/bin/bash
set -euo pipefail
echo BEGIN
for d in \
  "/c/Program Files/ImageMagick-7" \
  "/c/Program Files/ImageMagick" \
  "/c/Program Files/ImageMagick-6" \
  "/c/Program Files/LGPL ImageMagick" \
  "/c/ProgramData/chocolatey/bin" \
  "/c/Program Files/Git/usr/bin" \
  "/c/Program Files/Git/mingw64/bin" \
  "/c/Program Files/Python314/Scripts" \
  "/c/Users/SAKAR/AppData/Local/Programs/Ollama" \
  "/c/Users/SAKAR/bin"; do
  if [ -x "$d/magick.exe" ]; then
    echo "MAGICK=$d/magick.exe"
  elif [ -x "$d/convert.exe" ]; then
    echo "CONVERT=$d/convert.exe"
  fi
done
echo DONE
