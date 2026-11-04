# go.ps1 - start the phone agent + a Cloudflare tunnel, test it, print the Twilio webhook.
# Run:  powershell -ExecutionPolicy Bypass -File .\go.ps1
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`nPROBLEM: $m" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

Step "Checking tools"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js not found. Install LTS from nodejs.org." }
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) { Fail "cloudflared not found. Run: winget install Cloudflare.cloudflared  then open a new window." }
if (-not (Test-Path .\server.js)) { Fail "server.js not found in $dir" }
Write-Host "OK"

Step "Stopping old copies (port 3000 + old tunnels)"
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

Step "Groq key"
$sec = Read-Host "Paste your Groq key (hidden), or just press Enter to skip" -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $sec).Password
if ($key) { $env:GROQ_API_KEY = $key.Trim(); Write-Host "Key set." }
else { Write-Host "No key: callers will only hear 'please email us'." -ForegroundColor Yellow }

Step "Starting server (new window - leave it open)"
Start-Process node -ArgumentList 'server.js' -WorkingDirectory $dir
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep 1
  try { if ((Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 2).Content -match 'running') { $ok = $true; break } } catch {}
}
if (-not $ok) { Fail "Server did not start. Look at the server window for an error." }
Write-Host "Server OK on http://localhost:3000"

Step "Starting tunnel (new window - leave it open)"
$log = Join-Path $env:TEMP 'cloudflared-phone.log'
Remove-Item $log -ErrorAction SilentlyContinue
Start-Process $cf.Source -ArgumentList 'tunnel','--protocol','http2','--url','http://localhost:3000','--logfile',"`"$log`""
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) { Fail "Tunnel did not give an address. Check the cloudflared window." }
Write-Host "Tunnel address: $url"

Step "Testing public address (can take up to a minute)"
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 2
  try { if ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5).Content -match 'running') { $ok = $true; break } } catch {}
}
if (-not $ok) { Fail "Public address not reachable yet ($url). Leave both windows open and try it in Chrome in a minute." }

$hook = "$url/voice"
try { Set-Clipboard $hook } catch {}
Write-Host "`nSUCCESS. Twilio webhook (copied to clipboard):" -ForegroundColor Green
Write-Host "  $hook" -ForegroundColor Green
Write-Host "  Method: HTTP POST"
Write-Host "`nKeep the server and tunnel windows open. Closing either one breaks the phone line."
Read-Host "Press Enter to close this window (the other two keep running)"
