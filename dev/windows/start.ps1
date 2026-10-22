# Runs one app locally:  start.ps1 planner | retail | supplies | sms | mcp | auth | sync
param([Parameter(Mandatory = $true)][ValidateSet('planner','retail','supplies','sms','mcp','auth','sync')][string]$App)
. (Join-Path $PSScriptRoot 'common.ps1')
Update-PathFromRegistry
Set-Location $Repo
$a = $Apps[$App]
$cfg = @(); foreach ($w in $a.Workers) { $cfg += '-c'; $cfg += "workers/$w/wrangler.toml" }
$host.UI.RawUI.WindowTitle = "netex $App - http://localhost:$($a.Port)"
Write-Host "$($a.Note)" -ForegroundColor Cyan
Write-Host "  http://localhost:$($a.Port)   (signed in as $DevEmail via DEV_EMAIL; local database only)" -ForegroundColor Green
Write-Host "  Run a scheduled job:  http://localhost:$($a.Port)/__scheduled?cron=<the cron from wrangler.toml>   Stop: Ctrl+C" -ForegroundColor DarkGray
npx wrangler dev @cfg --port $a.Port --inspector-port ($a.Port + 1442) --persist-to "$State" --test-scheduled
