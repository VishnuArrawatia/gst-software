Write-Output 'START'
Write-Output ('A LAST=' + (Get-Item scripts\_logo-fit.csx).LastWriteTime.ToString('o') + ' BYTES=' + (Get-Item scripts\_logo-fit.csx).Length)
Write-Output ('B LAST=' + (Get-Item scripts\_prep-logos-systemdrawing.csx).LastWriteTime.ToString('o') + ' BYTES=' + (Get-Item scripts\_prep-logos-systemdrawing.csx).Length)
Write-Output 'DONE'
