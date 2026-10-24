# Starts the local MySQL server (kept in .\data) and Poultry Farm Manager in the background,
# independent of this window. Then open http://localhost:3000
#   Start:  powershell -ExecutionPolicy Bypass -File scripts\start-app.ps1
#   Stop:   powershell -ExecutionPolicy Bypass -File scripts\stop-app.ps1
# Logs: data\logs\server.log and data\logs\mysql.log
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Listening($port) { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) }

# Started through WMI so the processes keep running after this window (or any parent program) closes.
function StartDetached($commandLine) {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $root }
  if ($r.ReturnValue -ne 0) { throw "Could not start: $commandLine (error $($r.ReturnValue))" }
}

if (-not (Listening 3306)) {
  $mysqld = Join-Path $root 'data\mysql-server\bin\mysqld.exe'
  StartDetached "`"$mysqld`" --basedir=`"$root\data\mysql-server`" --datadir=`"$root\data\mysql-data`" --port=3306 --bind-address=127.0.0.1 --mysqlx=OFF --log-error=`"$logs\mysql.log`""
  for ($i = 0; $i -lt 60 -and -not (Listening 3306); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Listening 3306)) { throw "MySQL did not start; see $logs\mysql.log" }
}
Write-Host 'MySQL: running on 127.0.0.1:3306'

if (-not (Listening 3000)) {
  $node = (Get-Command node).Source
  StartDetached "cmd /c `"`"$node`" --env-file-if-exists=.env dist\server\index.js >> `"$logs\server.log`" 2>&1`""
  for ($i = 0; $i -lt 60 -and -not (Listening 3000); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Listening 3000)) { throw "The app did not start; see $logs\server.log" }
}
Write-Host 'Poultry Farm Manager: http://localhost:3000'
