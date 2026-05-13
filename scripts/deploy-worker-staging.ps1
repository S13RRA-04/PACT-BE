$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "deploy-worker.ps1"
try {
  & $script -Target staging
} catch {
  Write-Error $_
  exit 1
}
