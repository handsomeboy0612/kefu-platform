# 每日备份平台数据库 kefu_platform（install-autostart.ps1 会把它注册为每天 03:40 的计划任务，也可以手动运行）
# backup.cnf 里是数据库账号密码（publish.ps1 首次部署时按 app\.env 生成）
$ErrorActionPreference = 'Stop'

$dir       = $PSScriptRoot
$mysqldump = 'C:\Program Files\PhpWebStudy-Data\env\mysql\bin\mysqldump.exe'
$db        = 'kefu_platform'
$keepDays  = 14
$cnf       = Join-Path $dir 'backup.cnf'
$outDir    = Join-Path $dir 'backup'

if (-not (Test-Path $mysqldump)) { throw "找不到 mysqldump：$mysqldump" }
if (-not (Test-Path $cnf)) { throw "缺少 $cnf" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$file = Join-Path $outDir ('{0}_{1}.sql' -f $db, (Get-Date -Format 'yyyyMMdd_HHmmss'))
# 用 --result-file 而不是 > 重定向：PowerShell 5 的重定向会把文件写成 UTF-16
& $mysqldump "--defaults-extra-file=$cnf" --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF "--result-file=$file" $db
if ($LASTEXITCODE -ne 0) {
    Remove-Item $file -ErrorAction SilentlyContinue
    throw "mysqldump 失败，退出码 $LASTEXITCODE"
}

Get-ChildItem -Path $outDir -Filter "${db}_*.sql" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$keepDays) } |
    Remove-Item

Write-Host "备份完成：$file"
