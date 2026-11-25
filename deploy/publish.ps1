# 发布：在开发目录里打包，交给部署目录 D:\kefu-platform。不需要管理员权限。
#   - 第一次：建好 D:\kefu-platform（app、脚本、backup.cnf），装依赖；然后需要以管理员身份运行一次 D:\kefu-platform\install-autostart.ps1
#   - 以后：新版本放进 D:\kefu-platform\incoming 并写 READY，平台的守护脚本 10 秒内自动停服、替换、重启
# 用法（在 kefu-platform 目录下）：powershell -ExecutionPolicy Bypass -File deploy\publish.ps1 [-SkipBuild]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'

$repo    = Split-Path $PSScriptRoot -Parent
$target  = 'D:\kefu-platform'
$app     = Join-Path $target 'app'
$nodeDir = 'C:\Program Files\PhpWebStudy-Data\env\node'
$npm     = Join-Path $nodeDir 'npm.cmd'
$env:Path = "$nodeDir;$env:Path"

Push-Location $repo
try {
    if (-not $SkipBuild) {
        Write-Host '打包中……'
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw '打包失败' }
    }
    if (-not (Test-Path 'dist\server.cjs')) { throw '没有 dist\server.cjs，先打包' }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    # 部署脚本每次都更新
    Copy-Item 'deploy\run-server.ps1', 'deploy\install-autostart.ps1', 'deploy\backup.ps1' $target -Force

    if (-not (Test-Path (Join-Path $app 'dist\server.cjs'))) {
        Write-Host "首次部署到 $app"
        New-Item -ItemType Directory -Force -Path $app | Out-Null
        robocopy 'dist' (Join-Path $app 'dist') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        Copy-Item 'package.json', 'package-lock.json' $app -Force
        if (-not (Test-Path (Join-Path $app '.env'))) { Copy-Item '.env' (Join-Path $app '.env') }
        Push-Location $app
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw '安装依赖失败' }
        Pop-Location

        # 备份用的数据库账号：按 app\.env 生成 backup.cnf
        $cnf = Join-Path $target 'backup.cnf'
        if (-not (Test-Path $cnf)) {
            $kv = @{}
            Get-Content (Join-Path $app '.env') | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $kv[$Matches[1]] = $Matches[2].Trim() }
            "[client]`r`nhost=$($kv['MYSQL_HOST'])`r`nport=$($kv['MYSQL_PORT'])`r`nuser=$($kv['MYSQL_USER'])`r`npassword=$($kv['MYSQL_PASSWORD'])`r`n" |
                Set-Content -Path $cnf -Encoding ASCII
        }
        Write-Host '首次部署的文件已就绪。请右键 D:\kefu-platform\install-autostart.ps1 →「使用 PowerShell 运行」（会弹窗要管理员权限）。' -ForegroundColor Yellow
    } else {
        $incoming = Join-Path $target 'incoming'
        if (Test-Path $incoming) { Remove-Item $incoming -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $incoming | Out-Null
        robocopy 'dist' (Join-Path $incoming 'dist') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        Copy-Item 'package.json', 'package-lock.json' $incoming -Force
        Set-Content -Path (Join-Path $incoming 'READY') -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        Write-Host '新版本已放进 incoming，平台会在 10 秒内自动切换（看 D:\kefu-platform\logs\runner.log）。' -ForegroundColor Green
    }
} finally {
    Pop-Location
}
