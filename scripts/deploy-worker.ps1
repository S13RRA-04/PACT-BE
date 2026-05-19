param(
  [ValidateSet("staging", "production")]
  [string]$Target,
  [switch]$RestartProductionOrigin
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $projectRoot

function Invoke-CheckedCommand([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

Invoke-CheckedCommand "npm" @("run", "build")
Invoke-CheckedCommand "npm" @("test")
if ($RestartProductionOrigin) {
  if ($Target -ne "production") {
    throw "-RestartProductionOrigin can only be used with the production target."
  }
  Invoke-CheckedCommand "powershell" @("-ExecutionPolicy", "Bypass", "-File", ".\scripts\restart-production-origin.ps1")
}
Invoke-CheckedCommand "npx" @("wrangler", "deploy", "--env", $Target)
