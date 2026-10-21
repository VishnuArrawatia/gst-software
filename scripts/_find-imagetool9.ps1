Add-Type -AssemblyName System.Core
$found = @()
try {
  $searcher = New-Object System.IO.DirectoryInfo('C:\Program Files')
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($searcher)
  $scanned = 0
  while ($queue.Count -gt 0 -and $scanned -lt 2000) {
    $dir = $queue.Dequeue()
    $scanned++
    try {
      foreach ($sub in $dir.GetDirectories()) {
        if ($sub.Name -like '*ImageMagick*') {
          $found += 'DIR=' + $sub.FullName
          $exe = Get-ChildItem -Path $sub.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'magick.exe' -or $_.Name -eq 'convert.exe' } |
            Select-Object -First 2
          foreach ($e in $exe) {
            $found += '  EXE=' + $e.FullName
          }
        } else {
          $queue.Enqueue($sub)
        }
      }
    } catch {
      continue
    }
  }
} catch {
  Write-Output 'SCAN_ERROR=' + $_.Exception.Message
}
if ($found) {
  $found | ForEach-Object { Write-Output $_ }
} else {
  Write-Output 'NONE'
}
Write-Output 'SCAN_DONE'
