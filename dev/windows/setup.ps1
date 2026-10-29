# One-time setup of this copy of netex-apps for local development. Safe to run again.
. (Join-Path $PSScriptRoot 'common.ps1')
Update-PathFromRegistry
foreach ($c in 'git','node','npx') { if (-not (Test-Cmd $c)) { throw "$c isn't installed. Run '1 - Install tools.cmd' first, then open a new window." } }
Set-Location $Repo

Step "OneDrive: keep these files on this laptop"
# Files On-Demand can turn files into cloud-only placeholders; git and wrangler need them local.
$root = Split-Path $Repo -Parent
attrib +P -U "$root" | Out-Null
attrib +P -U "$root\*" /S /D | Out-Null
Ok "pinned $root (Always keep on this device)"

Step "Git settings"
git config core.autocrlf false; git config core.filemode false
if (-not (git config --global user.name))  { git config --global user.name  'Neal Barker' }
if (-not (git config --global user.email)) { git config --global user.email $DevEmail }
Ok ("branch: " + (git branch --show-current) + "; you are " + (git config user.name) + " <" + (git config user.email) + ">")

Step "Packages"
Push-Location (Join-Path $Repo 'workers\sync'); Invoke-Checked { npm install --no-audit --no-fund } 'npm install (sync)'; Pop-Location
Invoke-Checked { npx --yes wrangler --version } 'wrangler'
Ok "wrangler ready"

Step "Local settings (.dev.vars - git ignores these)"
$devVars = @{
  planner  = "DEV_EMAIL=$DevEmail`r`n# CF_API_TOKEN=   leave empty: it would change the REAL 'Netex users' Access group`r`n"
  retail   = "DEV_EMAIL=$DevEmail`r`n"
  supplies = "DEV_EMAIL=$DevEmail`r`n"
  _template = "DEV_EMAIL=$DevEmail`r`n"
  mcp      = "DEV_EMAIL=$DevEmail`r`n# SMRT_KEY=   only for smrt_order/smrt_report; reads live SMRT`r`n"
  sms      = "DEV_EMAIL=$DevEmail`r`n# Leave the Twilio keys empty: with them, local runs send REAL texts from (903) 689-9487.`r`n# TWILIO_ACCOUNT_SID=`r`n# TWILIO_AUTH_TOKEN=`r`n"
  sync     = "# SMRT_KEY=   only if you want the local sync to read live SMRT (it writes to your LOCAL database only)`r`n"
  auth     = "# TWILIO_API_KEY_SID=  TWILIO_API_KEY_SECRET=  OIDC_CLIENT_SECRET=   (sign-in codes are real texts; usually leave empty)`r`n"
}
foreach ($w in $devVars.Keys) {
  $f = Join-Path $Repo "workers\$w\.dev.vars"
  if (Test-Path $f) { Ok "$w - kept existing .dev.vars" } else { Set-Content -Path $f -Value $devVars[$w] -NoNewline -Encoding ascii; Ok "$w - created .dev.vars" }
}

Step "Local database (empty, with the current schema)"
New-Item -ItemType Directory -Force -Path $State | Out-Null
Push-Location (Join-Path $Repo 'workers\planner')
Invoke-Checked { npx wrangler d1 migrations apply netex-apps --local --persist-to "$State" } 'migrations'
Pop-Location
Ok "database at $State"

Step "Tests"
& (Join-Path $PSScriptRoot 'test.ps1')

Step "Cloudflare sign-in (only needed to copy production data)"
$a = Read-Host "Sign in to Cloudflare now? (y/N)"
if ($a -match '^[yY]') { npx wrangler login } else { Ok "skipped; run 'npx wrangler login' later if you need it" }

Write-Host ""
Write-Host "Ready. Double-click 'Start planner.cmd', then open http://localhost:8787" -ForegroundColor Green
