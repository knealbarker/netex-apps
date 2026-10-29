# Runs every app's test suite (Node's SQLite stands in for D1; no network). Exit code 1 if any fail.
. (Join-Path $PSScriptRoot 'common.ps1')
Update-PathFromRegistry
Set-Location $Repo
$failed = @()
foreach ($run in Get-ChildItem -Path (Join-Path $Repo 'workers\*\test\run.mjs')) {
  $name = $run.Directory.Parent.Name
  $log = Join-Path $env:TEMP "netex-test-$name.log"
  cmd /c "node `"$($run.FullName)`" > `"$log`" 2>&1"
  if ($LASTEXITCODE -eq 0) { Ok "$name passed" } else { $failed += $name; Warn "$name FAILED - see $env:TEMP\netex-test-$name.log" }
}
if ($failed.Count) { exit 1 }
