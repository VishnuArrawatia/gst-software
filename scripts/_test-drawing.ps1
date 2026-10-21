Add-Type -AssemblyName System.Drawing
Write-Output 'LOADED'
$bmp = New-Object System.Drawing.Bitmap(4, 4)
Write-Output 'BITMAP_OK=' + $bmp.Width
$bmp.Dispose()
Write-Output 'DONE'
