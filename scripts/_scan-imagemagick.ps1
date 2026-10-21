$cs = 'C:\Program Files'
$hits = Get-ChildItem $cs -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'ImageMagick' }

if (-not $hits) {
  Write-Output 'NO_IMAGEMAGICK_DIR'
} else {
  foreach ($h in $hits) {
    Write-Output $h.FullName
    $img = Get-ChildItem $h.FullName -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'magick.exe' } |
      Select-Object -First 1
    if ($img) {
      Write-Output '  MAGICK=' + $img.FullName
    }
  }
}
Write-Output 'SCAN_DONE'
