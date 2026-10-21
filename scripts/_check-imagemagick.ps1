param([switch]$Verbose)

function Find-Magick() {
  foreach ($cand in @(
      'C:\Program Files\ImageMagick-7\magick.exe',
      'C:\Program Files\ImageMagick\magick.exe',
      'C:\Program Files\ImageMagick-6\magick.exe'
    )) {
    if (Test-Path $cand) {
      Write-Output $cand
      return
    }
  }
  $hits = Get-ChildItem -Path 'C:\Program Files' -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object Name -eq 'magick.exe' | Select-Object -First 1
  if ($hits) { Write-Output $hits.FullName }
}

$found = Find-Magick
if ($found) {
  Write-Output "MAGICK_EXE=$found"
  Write-Output "MAGICK_EXISTS=true"
} else {
  Write-Output "MAGICK_EXE="
  Write-Output "MAGICK_EXISTS=false"
}
