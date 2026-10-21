$d = 'src/server/public/assets'
$hits = Get-ChildItem $d -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'hero-hologram|calendar-2027|gst-blocks-cart' }
if (-not $hits) {
  Write-Output 'NO_MATCH_IN_ASSETS'
} else {
  foreach ($h in $hits) {
    Write-Output "$($h.FullName)  bytes=$($h.Length)"
  }
}
