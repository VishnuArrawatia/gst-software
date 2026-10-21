Add-Type -AssemblyName System.Drawing

$sources = @(
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487107068-122664.png',
  'C:\Users\SAKAR\AppData\Local\Temp\freebuff-desktop-pastes\paste-1792487130466-122664.png'
)

$boxW = 400
$boxH = 400

function Save-Fit([string]$src, [string]$dst, [int]$boxW, [int]$boxH) {
  if (-not (Test-Path $src)) { Write-Output "MISSING $src"; return }
  $img = [System.Drawing.Image]::FromFile($src)
  $w = $img.Width
  $h = $img.Height
  $scale = [Math]::Max(1, [Math]::Min($w / $boxW, $h / $boxH))
  $srcW = [Math]::Max($boxW, [int]($w / $scale))
  $srcH = [Math]::Max($boxH, [int]($h / $scale))
  $scaleF = $srcW / $w
  $fitW = [int][Math]::Round($w * $scaleF)
  $fitH = [int][Math]::Round($h * $scaleF)

  $bmp = New-Object System.Drawing.Bitmap($boxW, $boxH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $dx = ($boxW - $fitW) / 2
  $dy = ($boxH - $fitH) / 2
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle($dx, $dy, $fitW, $fitH)), 0, 0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $img.Dispose()

  $st = Get-Item $dst
  Write-Output "SAVED $dst  size=$($st.Length)  box=$boxW,$boxH"
}

$outDir = Join-Path (Get-Location).Path 'output\_logo-fit'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
Write-Output "OUTDIR $outDir"

foreach ($s in $sources) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($s)
  Save-Fit $s (Join-Path $outDir "$name-fit.png") $boxW $boxH
}
