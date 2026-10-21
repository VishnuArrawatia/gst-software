Write-Output 'BEGIN'
Write-Output ($env:PATH -split ';' -join "`r`n")
Write-Output 'DONE'
