# 平台守护脚本：由计划任务 kefu-platform-server 以系统账户在开机时启动（install-autostart.ps1 注册），一般不用手动运行。
#   - 启动 node dist\server.cjs，退出 / 崩溃后 5 秒自动重启
#   - 发现 incoming\READY（publish.ps1 放的新版本）就停掉平台、替换 app\dist、依赖变了就重装，再启动
#   - 日志：logs\server.log（平台输出，超过 20MB 滚动一次），logs\runner.log（本脚本的启动 / 升级记录）
$ErrorActionPreference = 'Continue'

$root     = $PSScriptRoot
$app      = Join-Path $root 'app'
$incoming = Join-Path $root 'incoming'
$logDir   = Join-Path $root 'logs'
$nodeDir  = 'C:\Program Files\PhpWebStudy-Data\env\node'
$node     = Join-Path $nodeDir 'node.exe'
$npm      = Join-Path $nodeDir 'npm.cmd'
$serverLog = Join-Path $logDir 'server.log'
$runnerLog = Join-Path $logDir 'runner.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# npm ci 时要能找到 node
$env:Path = "$nodeDir;$env:Path"

function Log([string]$msg) {
    Add-Content -Path $runnerLog -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
}

function Apply-Upgrade {
    if (-not (Test-Path (Join-Path $incoming 'READY'))) { return }
    Log '发现新版本，开始替换'
    try {
        $newLock = Join-Path $incoming 'package-lock.json'
        $oldLock = Join-Path $app 'package-lock.json'
        $depsChanged = -not (Test-Path $oldLock) -or ((Get-FileHash $newLock).Hash -ne (Get-FileHash $oldLock).Hash)

        # 留一份上一版的 dist，出问题可以手动换回去
        $prev = Join-Path $root 'app-prev'
        if (Test-Path $prev) { Remove-Item $prev -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $prev | Out-Null
        if (Test-Path (Join-Path $app 'dist')) { Copy-Item (Join-Path $app 'dist') (Join-Path $prev 'dist') -Recurse }

        robocopy (Join-Path $incoming 'dist') (Join-Path $app 'dist') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        Copy-Item (Join-Path $incoming 'package.json'), $newLock $app -Force
        if ($depsChanged) {
            Log '依赖有变化，重新安装（npm ci --omit=dev）'
            Push-Location $app
            & $npm ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Log "  npm: $_" }
            Pop-Location
        }
        Remove-Item $incoming -Recurse -Force
        Log '替换完成'
    } catch {
        Log "替换失败：$_（incoming 保留，下次重启再试）"
    }
}

Log '守护脚本启动'
while ($true) {
    Apply-Upgrade

    if ((Test-Path $serverLog) -and (Get-Item $serverLog).Length -gt 20MB) {
        Move-Item $serverLog "$serverLog.1" -Force
    }

    Log '启动平台'
    # 用 cmd 重定向追加写日志；退出码透传出来
    $cmdArgs = "/c `"`"$node`" dist\server.cjs >> `"$serverLog`" 2>&1`""
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs -WorkingDirectory $app -WindowStyle Hidden -PassThru
    while (-not $p.HasExited) {
        Start-Sleep -Seconds 5
        if (Test-Path (Join-Path $incoming 'READY')) {
            Log '准备升级，停止平台'
            & taskkill.exe /PID $p.Id /T /F | Out-Null
            break
        }
    }
    Log ('平台已退出（退出码 {0}），5 秒后重启' -f $p.ExitCode)
    Start-Sleep -Seconds 5
}
