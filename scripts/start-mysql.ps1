# Starts the local MySQL 8.4 server kept in .\data (for running the app on this PC without installing MySQL).
# Leave this window open while using the app. Then, in another window: npm start
$root = Split-Path -Parent $PSScriptRoot
& "$root\data\mysql-server\bin\mysqld.exe" --basedir="$root\data\mysql-server" --datadir="$root\data\mysql-data" --port=3306 --bind-address=127.0.0.1 --mysqlx=OFF --console
