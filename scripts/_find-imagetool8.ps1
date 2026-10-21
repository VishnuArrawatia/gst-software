$drives = @('C:', 'D:', 'E:', 'F:')
$found = @()
foreach ($d in $drives) {
  if (-not (Test-Path $d)) { continue }
  try {
    $dirs = Get-ChildItem -Path $d -Directory -ErrorAction SilentlyContinue
  } catch {
    continue
  }
  foreach ($root in $dirs) {
    $candidates = Get-ChildItem -Path $root.FullName -Recurse -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '*ImageMagick*' }
    foreach ($c in $candidates) {
      $found += 'DIR=' + $c.FullName
      $exe = Get-ChildItem -Path $c.FullName -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'magick.exe' -or $_.Name -eq 'convert.exe' } |
        Select-Object -First 2
      foreach ($e in $exe) {
        $found += '  EXE=' + $e.FullName
      }
    }
  }
}
if ($found) {
  $found | ForEach-Object { Write-Output $_ }
} else {
  Write-Output 'NONE'
}
Write-Output 'SCAN_DONE'
