Write-Output 'START'

$envPaths = $env:PATH -split ';'
Write-Output 'ENV_PATH_COUNT=' + $envPaths.Count
foreach ($p in $envPaths) {
  if ($p -and (Test-Path (Join-Path $p 'magick.exe'))) {
    Write-Output 'MAGICK_IN_PATH=' + (Join-Path $p 'magick.exe')
  }
}

$pfHits = Get-ChildItem -Path 'C:\Program Files' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*ImageMagick*' }
if ($pfHits) {
  Write-Output 'PF_DIR_COUNT=' + $pfHits.Count
  foreach ($h in $pfHits) {
    Write-Output 'PF_DIR=' + $h.FullName
  }
} else {
  Write-Output 'NO_PF_IMAGEMAGICK_DIR'
}

$pfSub = Get-ChildItem -Path 'C:\Program Files' -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*ImageMagick*' }
if ($pfSub) {
  Write-Output 'PF_RECURSE_DIR_COUNT=' + $pfSub.Count
  foreach ($h in $pfSub) {
    Write-Output 'PF_RECURSE_DIR=' + $h.FullName
  }
} else {
  Write-Output 'NO_PF_RECURSE_IMAGEMAGICK_DIR'
}

$userHits = Get-ChildItem -Path $HOME -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*ImageMagick*' }
if ($userHits) {
  Write-Output 'USER_DIR_COUNT=' + $userHits.Count
  foreach ($h in $userHits) {
    Write-Output 'USER_DIR=' + $h.FullName
  }
} else {
  Write-Output 'NO_USER_IMAGEMAGICK_DIR'
}

Write-Output 'SCAN_DONE'
