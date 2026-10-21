param(
  [Parameter(Mandatory=$true)]
  [string]$Src,
  [Parameter(Mandatory=$true)]
  [string]$Bmp
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($Src)
$bmp2 = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp2)
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($img, 0, 0, $img.Width, $img.Height)
$g.Dispose()
$img.Dispose()
$bmp2.Save($Bmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp2.Dispose()
Write-Output "BMP_OK $Bmp"
