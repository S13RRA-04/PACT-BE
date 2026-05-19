param(
  [string]$EnvFile = ".env.pact-origin-runtime",
  [int]$Port = 4200,
  [int]$HealthTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$startScript = Resolve-Path (Join-Path $scriptDir "start-production-origin.ps1")
$outLog = Join-Path $projectRoot "pact-origin-production.out.log"
$errLog = Join-Path $projectRoot "pact-origin-production.err.log"

Set-Location $projectRoot

function Stop-PortListeners([int]$Port) {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $processIds = $listeners |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne $PID }

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping PACT production origin PID $processId on port $Port."
      Stop-Process -Id $processId -Force
    }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Port $Port is still in use after stopping existing PACT origin listeners."
}

function Wait-OriginHealth([int]$Port, [int]$TimeoutSeconds, [System.Diagnostics.Process]$StartedProcess) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $healthUrl = "http://127.0.0.1:$Port/health"

  do {
    if ($StartedProcess.HasExited) {
      throw "PACT production origin startup process exited with code $($StartedProcess.ExitCode). Check $errLog."
    }

    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        Write-Host "PACT production origin is healthy on $healthUrl."
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "PACT production origin did not become healthy at $healthUrl within $TimeoutSeconds seconds. Check $errLog."
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Missing $EnvFile."
}

Stop-PortListeners -Port $Port

$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$($startScript.Path)`"",
  "-EnvFile", "`"$EnvFile`"",
  "-Port", $Port.ToString()
)

Write-Host "Starting PACT production origin on port $Port."
$process = Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList $arguments `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Wait-OriginHealth -Port $Port -TimeoutSeconds $HealthTimeoutSeconds -StartedProcess $process
