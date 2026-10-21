$root = 'C:\Program Files'
$dirs = Get-ChildItem -Path $root -Recurse -Directory -ErrorAction SilentlyContinue
$imDir = @()
foreach ($d in $dirs) {
  if ($d.Name -like '*ImageMagick*') {
    $imDir += $d
  }
}

if ($imDir) {
  Write-Output 'DIR_COUNT=' + $imDir.Count
  foreach ($d in $imDir) {
    Write-Output 'DIR=' + $d.FullName
    $exe = Get-ChildItem -Path $d.FullName -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'magick.exe' } |
      Select-Object -First 1
    if ($exe) {
      Write-Output 'MAGICK=' + $exe.FullName
    }
  }
} else {
  Write-Output 'NO_IMAGEMAGICK_DIR'
}

Write-Output 'SCAN_DONE'
