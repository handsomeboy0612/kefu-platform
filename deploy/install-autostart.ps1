# 部署平台（在 DESKTOP-81HRUPD 上运行一次，需要管理员权限，会自动弹窗提权）：
#   1. 平台设为开机自启：系统账户运行，不用登录 Windows；由 run-server.ps1 守护，崩溃后 5 秒自动重启
#   2. 防火墙放行 8092 端口（其他电脑访问 http://DESKTOP-81HRUPD:8092）
#   3. 每天 03:40 运行 backup.ps1 备份 kefu_platform 库，保留 14 天
# 以后升级不用再运行本脚本：开发机上运行 publish.ps1，平台会在 10 秒内自动换成新版本。
# 只改了 app\.env 时，重新运行本脚本即可让新配置生效。
$ErrorActionPreference = 'Stop'

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$dir    = $PSScriptRoot
$runner = Join-Path $dir 'run-server.ps1'
$backup = Join-Path $dir 'backup.ps1'
$port   = 8092

try {
    if (-not (Test-Path (Join-Path $dir 'app\dist\server.cjs'))) { throw '找不到 app\dist\server.cjs，请先在开发机上运行 publish.ps1' }
    if (-not (Test-Path (Join-Path $dir 'app\.env'))) { throw '找不到 app\.env（数据库账号密码）' }

    # 停掉旧的：计划任务、守护脚本，以及占着 8092 端口的进程（比如开发时手动启动的那个）
    Stop-ScheduledTask -TaskName 'kefu-platform-server' -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like '*run-server.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    # ExecutionTimeLimit = 0：不限运行时长；守护脚本自己也挂了的话，计划任务 1 分钟后重新拉起
    $serverSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'kefu-platform-server' -Force -Principal $principal -Settings $serverSettings `
        -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $dir `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`"") `
        -Trigger (New-ScheduledTaskTrigger -AtStartup) | Out-Null

    $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'kefu-platform-backup' -Force -Principal $principal -Settings $backupSettings `
        -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $dir `
            -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backup`"") `
        -Trigger (New-ScheduledTaskTrigger -Daily -At '03:40') | Out-Null

    Remove-NetFirewallRule -DisplayName 'kefu-platform' -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName 'kefu-platform' -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $port -Profile Any | Out-Null

    Start-ScheduledTask -TaskName 'kefu-platform-server'

    Write-Host '正在等平台启动……'
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/api/health"
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
    }
    if ($ok) {
        Write-Host "完成：平台已设为开机自启并启动，其他电脑访问 http://$($env:COMPUTERNAME):$port" -ForegroundColor Green
        Write-Host '每天 03:40 自动备份 kefu_platform 库到 backup 目录（保留 14 天）。'
    } else {
        Write-Host "计划任务已注册，但 60 秒内平台没有响应，请看日志：$(Join-Path $dir 'logs')" -ForegroundColor Yellow
    }
    if (-not (Test-Path (Join-Path $dir 'backup.cnf'))) {
        Write-Host '提醒：还没有 backup.cnf，备份任务会失败。' -ForegroundColor Yellow
    }
} catch {
    Write-Host "部署失败：$_" -ForegroundColor Red
}
Read-Host '按回车关闭'
