$pfs = @('C:\Program Files', 'C:\Program Files (x86)', 'C:\ProgramData')
$found = @()
foreach ($base in $pfs) {
  if (-not (Test-Path $base)) { continue }
  $exe = Get-ChildItem -Path $base -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'magick.exe' -or $_.Name -eq 'convert.exe' } |
    Select-Object -First 5
  foreach ($e in $exe) {
    $found += $e.FullName
  }
}
if ($found) {
  Write-Output 'FOUND=' + ($found -join ';')
} else {
  Write-Output 'NONE'
}
Write-Output 'DONE'
