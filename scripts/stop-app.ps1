# Stops Poultry Farm Manager and the local MySQL server started by start-app.ps1.
$root = Split-Path -Parent $PSScriptRoot
foreach ($port in 3000) {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
# A clean MySQL shutdown, so no data is lost.
$admin = Join-Path $root 'data\mysql-server\bin\mysqladmin.exe'
if (Get-NetTCPConnection -State Listen -LocalPort 3306 -ErrorAction SilentlyContinue) { & $admin --host=127.0.0.1 --port=3306 --user=root shutdown }
Write-Host 'Stopped.'
