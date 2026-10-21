$probes = @(
  'C:\ProgramData\chocolatey\lib\imagemagick'
  'C:\ProgramData\chocolatey\lib\imagemagick7'
  'C:\ProgramData\chocolatey\lib\imagemagick.portable'
  'C:\ProgramData\chocolatey\lib\imagemagick.tool'
  'C:\Users\SAKAR\AppData\Local\ImageMagick'
  'C:\Users\SAKAR\AppData\Local\Programs\ImageMagick'
  'C:\Program Files\ImageMagick'
  'C:\Program Files (x86)\ImageMagick'
)
foreach ($p in $probes) {
  if (Test-Path $p) {
    Write-Output 'DIR=' + $p
    $exe = Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'magick.exe' -or $_.Name -eq 'convert.exe' } |
      Select-Object -First 2
    foreach ($e in $exe) {
      Write-Output 'EXE=' + $e.FullName
    }
  }
}
Write-Output 'DONE'
