$paths = $env:PATH -split ';'
Write-Output 'PATH_COUNT=' + $paths.Count
foreach ($p in $paths) {
  $pn = $p.TrimEnd('\')
  if ($pn -and (Test-Path $pn)) {
    $m = Join-Path $pn 'magick.exe'
    if (Test-Path $m) {
      Write-Output 'MAGICK_IN_PATH=' + $m
    }
  }
}

Write-Output 'DONE'
