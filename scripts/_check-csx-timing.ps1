$a = 'scripts\_logo-fit.csx'
$b = 'scripts\_prep-logos-systemdrawing.csx'

$da = Get-Item $a -ErrorAction SilentlyContinue
$db = Get-Item $b -ErrorAction SilentlyContinue

Write-Output "A=$a  last=$($da.LastWriteTime.ToString('o'))  bytes=$($da.Length)"
Write-Output "B=$b  last=$($db.LastWriteTime.ToString('o'))  bytes=$($db.Length)"
