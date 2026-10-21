Add-Type -AssemblyName System.Drawing

$configName = 'logo-prep-config.txt'
$configPath = Join-Path (Get-Location).Path $configName
if (-not (Test-Path $configPath)) {
  Write-Output "CONFIG MISSING: $configPath"
  exit 1
}
$configLines = Get-Content $configPath
$config = @{}
foreach ($line in $configLines) {
  if ($line -match '^\s*([^=]+)=\s*(.*)$') {
    $config[$Matches[1].Trim()] = $Matches[2].Trim()
  }
}

$sources = @()
if ($config['SOURCE_LIST'] -match '^\s*\[\s*(.+)\s*\]\s*$') {
  $items = $Matches[1] -split ','
  foreach ($i in $items) {
    $p = $i.Trim().Trim('"\').Trim("'")
    if ($p) { $sources += $p }
  }
}

$boxW = [int]$config['BOX_W']
$boxH = [int]$config['BOX_H']
$outDir = $config['OUTPUT_DIR'] -replace '\\\\','\'

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
  Write-Output "SAVED $dst  size=$($st.Length)  box=$boxW,$boxH  src=$w,$h  fit=$fitW,$fitH"
}

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
Write-Output "OUTDIR $outDir"

foreach ($s in $sources) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($s)
  Save-Fit $s (Join-Path $outDir "$name-fit.png") $boxW $boxH
}
