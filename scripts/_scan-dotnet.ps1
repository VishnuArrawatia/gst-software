$found = Get-Command dotnet -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found) {
  Write-Output 'DOTNET=' + $found.Source + ' ' + $found.Version
} else {
  Write-Output 'NO_DOTNET'
}

$cs후보 = [Environment]::GetEnvironmentVariable('PATH','Machine').Split(';') |
  Where-Object { Test-Path (Join-Path $_ 'dotnet-script.exe') } |
  Select-Object -First 1
if ($cs후보) {
  Write-Output 'DOTNET_SCRIPT=' + (Join-Path $cs후보 'dotnet-script.exe')
} else {
  Write-Output 'NO_DOTNET_SCRIPT'
}
