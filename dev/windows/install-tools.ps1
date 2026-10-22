# Installs the tools for working on netex-apps: Git, Node.js LTS, VS Code, GitHub CLI, and two VS Code extensions.
# Safe to run again; anything already installed is skipped. Windows may ask for permission (UAC) per installer.
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Cmd winget)) { throw "winget isn't available. Install 'App Installer' from the Microsoft Store, then run this again." }

$tools = @(
  @{ Id = 'Git.Git';                   Cmd = 'git';  Name = 'Git' },
  @{ Id = 'OpenJS.NodeJS.LTS';         Cmd = 'node'; Name = 'Node.js LTS (runs wrangler and the tests)' },
  @{ Id = 'Microsoft.VisualStudioCode'; Cmd = 'code'; Name = 'VS Code' },
  @{ Id = 'GitHub.cli';                Cmd = 'gh';   Name = 'GitHub CLI (sign in to push)' }
)
foreach ($t in $tools) {
  Step $t.Name
  if (Test-Cmd $t.Cmd) { Ok "already installed"; continue }
  winget install --id $t.Id -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Warn "winget returned $LASTEXITCODE - check the message above" } else { Ok "installed" }
  Update-PathFromRegistry
}

Step "Node.js version"
$v = (node --version) -replace '^v',''
if ([int]($v.Split('.')[0]) -lt 22) { Warn "Node $v is too old; the tests need Node 22 or newer. Run: winget upgrade OpenJS.NodeJS.LTS" } else { Ok "Node $v" }

Step "VS Code extensions"
if (Test-Cmd code) {
  foreach ($ext in @('qwtel.sqlite-viewer', 'anthropic.claude-code')) { code --install-extension $ext --force | Out-Null; Ok $ext }
} else { Warn "VS Code not on PATH yet; close this window, open a new one and run this again for the extensions" }

Write-Host ""
Write-Host "Done. Close this window, then run '2 - Set up.cmd'." -ForegroundColor Green
