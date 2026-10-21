Write-Output 'START'
$paths = $env:PATH -split ';'
Write-Output 'ENV_PATH_COUNT=' + $paths.Count
foreach ($p in $paths) {
  if ($p -and (Test-Path $p)) {
    Write-Output 'PATH_ENTRY=' + $p
  }
}

$w7 = Get-WindowsOptionalFeature -Online -FeatureName 'Windows-Subsystem-Linux' -ErrorAction SilentlyContinue
if ($w7) { Write-Output 'WSL_FEATURE=' + $w7.State }

Write-Output 'SCAN_DONE'
