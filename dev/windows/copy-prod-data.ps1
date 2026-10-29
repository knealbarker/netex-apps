# Replaces the LOCAL database with a copy of production (netex-apps D1). Production is only read, never changed.
. (Join-Path $PSScriptRoot 'common.ps1')
Update-PathFromRegistry
Write-Host "This copies the live database to this laptop: pay rates, customer names, phone numbers." -ForegroundColor Yellow
Write-Host "It is stored in $State (not OneDrive). Keep BitLocker on." -ForegroundColor Yellow
Write-Host "While Cloudflare exports, the live database pauses other requests (the apps and the sync wait)." -ForegroundColor Yellow
$h = (Get-Date).Hour
if ($h -ge 4 -and $h -lt 21) { Warn "It's during work hours (4am-9pm). Running it after 9pm is kinder to the crew." }
if ((Read-Host "Replace your local database with production now? (y/N)") -notmatch '^[yY]') { return }

New-Item -ItemType Directory -Force -Path $Exports | Out-Null
$file = Join-Path $Exports ("netex-apps-" + (Get-Date -Format 'yyyyMMdd-HHmm') + ".sql")
Push-Location (Join-Path $Repo 'workers\planner')
try {
  Step "Exporting production (read-only)"
  Invoke-Checked { npx wrangler d1 export netex-apps --remote --output "$file" } 'export'
  Step "Loading it into the local database"
  $d1 = Join-Path $State 'v3\d1'
  if (Test-Path $d1) { Remove-Item -Recurse -Force $d1 }
  Invoke-Checked { npx wrangler d1 execute netex-apps --local --persist-to "$State" --file "$file" --yes } 'import'
} finally { Pop-Location }
Get-ChildItem $Exports -Filter '*.sql' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Force
Ok "Local database now matches production as of $(Get-Date -Format 'g'). Export kept at $file"
