param(
  [switch]$StartNow,
  [string]$CloudflaredConfigPath = "$env:USERPROFILE\.cloudflared\cetu-pact-api-staging.yml"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$nssmCommand = Get-Command nssm -ErrorAction SilentlyContinue
$nssm = if ($nssmCommand) { $nssmCommand.Source } else { $null }

if (-not $nssm) {
  throw "NSSM is required to install PACT staging as Windows services. Install NSSM, then rerun this script."
}

if (-not (Test-Path -LiteralPath $CloudflaredConfigPath)) {
  throw "Missing Cloudflared tunnel config: $CloudflaredConfigPath"
}

function Quote-Arguments([string[]]$Arguments) {
  return $Arguments | ForEach-Object {
    if ($_ -match "\s") {
      "'$_'"
    } else {
      $_
    }
  }
}

$logDir = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$servicesToRemove = @("PACT-Staging-Webhook-Sink")
foreach ($serviceName in $servicesToRemove) {
  $existingTask = Get-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName $serviceName -Confirm:$false
  }

  $existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($existingService) {
    if ($existingService.Status -ne "Stopped") {
      & $nssm stop $serviceName | Out-Null
    }
    & $nssm remove $serviceName confirm | Out-Null
  }
}

$services = @(
  @{
    Name = "PACT-Staging-Origin"
    Script = Join-Path $scriptDir "start-staging-origin.ps1"
    Arguments = @()
    Description = "Starts the PACT staging API origin on localhost for the Cloudflare tunnel."
    Stdout = Join-Path $logDir "pact-origin-staging-service.out.log"
    Stderr = Join-Path $logDir "pact-origin-staging-service.err.log"
  },
  @{
    Name = "PACT-Staging-Tunnel"
    Script = Join-Path $scriptDir "start-staging-tunnel.ps1"
    Arguments = @("-ConfigPath", $CloudflaredConfigPath)
    Description = "Starts the Cloudflare tunnel for the PACT staging API origin."
    Stdout = Join-Path $logDir "pact-staging-tunnel-service.out.log"
    Stderr = Join-Path $logDir "pact-staging-tunnel-service.err.log"
  }
)

foreach ($service in $services) {
  $existingTask = Get-ScheduledTask -TaskName $service.Name -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName $service.Name -Confirm:$false
  }

  $existingService = Get-Service -Name $service.Name -ErrorAction SilentlyContinue
  if ($existingService) {
    if ($existingService.Status -ne "Stopped") {
      & $nssm stop $service.Name | Out-Null
    }
    & $nssm remove $service.Name confirm | Out-Null
  }

  $scriptCommand = "& '$($service.Script)'"
  $quotedServiceArguments = Quote-Arguments $service.Arguments
  if ($quotedServiceArguments) {
    $scriptCommand = "$scriptCommand $($quotedServiceArguments -join " ")"
  }

  $argumentParts = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`"$scriptCommand`""
  )
  $argumentString = $argumentParts -join " "

  & $nssm install $service.Name $powerShell | Out-Null
  & $nssm set $service.Name AppParameters $argumentString | Out-Null
  & $nssm set $service.Name AppDirectory $projectRoot | Out-Null
  & $nssm set $service.Name DisplayName $service.Name | Out-Null
  & $nssm set $service.Name Description $service.Description | Out-Null
  & $nssm set $service.Name Start SERVICE_AUTO_START | Out-Null
  & $nssm set $service.Name AppStdout $service.Stdout | Out-Null
  & $nssm set $service.Name AppStderr $service.Stderr | Out-Null
  & $nssm set $service.Name AppRotateFiles 1 | Out-Null
  & $nssm set $service.Name AppRotateOnline 1 | Out-Null
  & $nssm set $service.Name AppRotateBytes 10485760 | Out-Null
  & $nssm set $service.Name AppExit Default Restart | Out-Null
  & $nssm set $service.Name AppThrottle 1500 | Out-Null

  if ($StartNow) {
    & $nssm start $service.Name | Out-Null
  }
}

Write-Output "Registered PACT staging origin and tunnel Windows services."
