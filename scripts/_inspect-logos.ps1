Add-Type -AssemblyName System.Drawing

$sources = @(
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487107068-122664.png',
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487130466-122664.png',
  'src\server\public\logos\sakar.png'
)

foreach ($src in $sources) {
  $abs = (Resolve-Path $src -ErrorAction SilentlyContinue).Path
  if (-not (Test-Path $abs)) {
    Write-Output "MISSING $src"
    continue
  }
  $img = [System.Drawing.Image]::FromFile($abs)
  Write-Output "FILE $src"
  Write-Output "  EXISTING W=$($img.Width) H=$($img.Height) DPI_X=$($img.HorizontalResolution) DPI_Y=$($img.VerticalResolution) RAW=$($img.RawFormat)"
  $img.Dispose()
}
