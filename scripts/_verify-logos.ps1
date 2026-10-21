Add-Type -AssemblyName System.Drawing
$img1=[System.Drawing.Image]::FromFile('src/server/public/logos/companies/svn-group.png')
Write-Output ('svn-group: W=' + $img1.Width + ' H=' + $img1.Height)
$img1.Dispose()
$img2=[System.Drawing.Image]::FromFile('src/server/public/logos/companies/sakar-zeto-flare.png')
Write-Output ('sakar-zeto-flare: W=' + $img2.Width + ' H=' + $img2.Height)
$img2.Dispose()