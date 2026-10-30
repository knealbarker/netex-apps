# Shared settings for the Windows dev scripts. Dot-sourced by the others.
$ErrorActionPreference = 'Stop'
$Repo  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# The local database and wrangler's saved state live OUTSIDE OneDrive: OneDrive syncing a live SQLite file
# can corrupt it, and a copy of production (pay rates, customers) shouldn't sit in the cloud.
$State = Join-Path $env:LOCALAPPDATA 'netex-dev\wrangler-state'
$Exports = Join-Path $env:LOCALAPPDATA 'netex-dev\exports'
$DevEmail = 'neal@towncountryclean.com'

# app -> worker folders (first one is served; the others run alongside for service bindings) and port
$Apps = [ordered]@{
  planner  = @{ Workers = @('planner','sync','sms'); Port = 8787; Note = 'Production Planner (with netex-sync for Check now, netex-sms for texts)' }
  retail   = @{ Workers = @('retail','sms');   Port = 8788; Note = 'Retail Snapshot (with netex-sms for texts)' }
  supplies = @{ Workers = @('supplies');       Port = 8789; Note = 'Supplies' }
  sms      = @{ Workers = @('sms');            Port = 8790; Note = 'Texts' }
  mcp      = @{ Workers = @('mcp');            Port = 8791; Note = 'Claude connector' }
  auth     = @{ Workers = @('auth');           Port = 8792; Note = 'Text-me-a-code sign-in' }
  sync     = @{ Workers = @('sync');           Port = 8793; Note = 'SMRT/Rippling sync (no pages; trigger crons by hand)' }
}

function Update-PathFromRegistry {
  $m = [Environment]::GetEnvironmentVariable('Path','Machine'); $u = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$m;$u"
}
function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }
function Invoke-Checked([scriptblock]$b, $what) { & $b; if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }
