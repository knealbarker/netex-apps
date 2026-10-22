# Wipes the LOCAL database and rebuilds it empty from db/migrations (Neal is seeded as Owner).
. (Join-Path $PSScriptRoot 'common.ps1')
Update-PathFromRegistry
if ((Read-Host "Erase your LOCAL database? Production is not touched. (y/N)") -notmatch '^[yY]') { return }
$d1 = Join-Path $State 'v3\d1'; if (Test-Path $d1) { Remove-Item -Recurse -Force $d1 }
Push-Location (Join-Path $Repo 'workers\planner')
try { Invoke-Checked { npx wrangler d1 migrations apply netex-apps --local --persist-to "$State" } 'migrations' } finally { Pop-Location }
Ok "Empty local database ready."
