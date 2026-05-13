$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "deploy-worker.ps1"
try {
  & $script -Target production
} catch {
  Write-Error $_
  exit 1
}
