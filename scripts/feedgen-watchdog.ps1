# FeedGen watchdog: recover after repeated localhost HTTP failures
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:USERPROFILE 'feedgen-watchdog.log'
$failStreak = 0
$recoverCooldownUntil = Get-Date

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-HttpOk([string]$Url) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -ge 200 -and $code -lt 500)
  } catch {
    return $false
  }
}

function Ensure-Keepalive {
  $marker = 'C:\Users\Administrator\feedgen-keepalive.flag'
  $procs = @(Get-Process -Name 'wsl' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0 -or -not (Test-Path $marker)) {
    New-Item -ItemType File -Path $marker -Force | Out-Null
    Start-Process -FilePath 'wsl.exe' -ArgumentList @(
      '-d', 'Ubuntu', '-u', 'root', '--',
      'bash', '-lc',
      "touch /tmp/feedgen-keepalive; while true; do sleep 3600; done"
    ) -WindowStyle Hidden
    Write-Log 'started WSL keepalive'
  }
}

function Ensure-Services {
  Write-Log 'recover: start-and-verify'
  & wsl.exe -d Ubuntu -u root -- bash /mnt/c/pro/feedgen/scripts/start-and-verify.sh *>$null
  $script:recoverCooldownUntil = (Get-Date).AddSeconds(60)
  $script:failStreak = 0
}

Write-Log 'watchdog started'
Ensure-Keepalive
# 不强制 restart，避免抖动；仅在探测失败时恢复
Start-Service Redis -ErrorAction SilentlyContinue | Out-Null

while ($true) {
  Start-Service Redis -ErrorAction SilentlyContinue | Out-Null
  Ensure-Keepalive

  if ((Get-Date) -lt $recoverCooldownUntil) {
    Start-Sleep -Seconds 10
    continue
  }

  $be = Test-HttpOk 'http://127.0.0.1:3000/api/health'
  $fe = Test-HttpOk 'http://127.0.0.1:3001/login.html'
  if ($be -and $fe) {
    $failStreak = 0
  } else {
    $failStreak++
    Write-Log ("health fail streak=$failStreak backend=$be frontend=$fe")
    if ($failStreak -ge 3) {
      Ensure-Services
    }
  }
  Start-Sleep -Seconds 15
}
