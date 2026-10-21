try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
  $drives = if ($cs) { @($cs | ForEach-Object { $_.SystemDrive }) } else { @('C:') }
  $found = @()
  foreach ($drive in $drives) {
    $base = Join-Path $drive 'Program Files'
    if (-not (Test-Path $base)) { continue }
    try {
      $dirs = Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue
    } catch {
      continue
    }
    foreach ($d in $dirs) {
      if ($d.Name -like '*ImageMagick*') {
        $found += 'DIR=' + $d.FullName
        $exe = Get-ChildItem -Path $d.FullName -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq 'magick.exe' -or $_.Name -eq 'convert.exe' } |
          Select-Object -First 2
        foreach ($e in $exe) {
          $found += '  EXE=' + $e.FullName
        }
      }
    }
  }
  if ($found) { $found | ForEach-Object { Write-Output $_ } }
  else { Write-Output 'NONE' }
} catch {
  Write-Output 'CIM_ERROR=' + $_.Exception.Message
}
Write-Output 'SCAN_DONE'
