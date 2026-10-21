Add-Type -AssemblyName System.Drawing
$files = @(
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487107068-122664.png',
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487130466-122664.png'
)
foreach ($f in $files) {
  Write-Output 'FILE: ' + $f
  if (-not (Test-Path $f)) {
    Write-Output '  MISSING'
    continue
  }
  $s = Get-Item $f
  Write-Output '  SIZE=' + $s.Length + ' MOD=' + $s.LastWriteTime
  try {
    $img = [System.Drawing.Image]::FromFile($f)
    Write-Output '  FORMAT=' + $img.RawFormat
    Write-Output '  W=' + $img.Width + ' H=' + $img.Height
    Write-Output '  DPIX=' + $img.HorizontalResolution + ' DPIY=' + $img.VerticalResolution
    $img.Dispose()
  } catch {
    Write-Output '  ERR=' + $_
  }
}
