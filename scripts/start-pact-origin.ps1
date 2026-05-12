$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env.pact-origin-runtime"

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing $envFile. Create it with the staging runtime values before starting the origin."
}

Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith("#")) {
    return
  }

  $idx = $line.IndexOf("=")
  if ($idx -lt 1) {
    return
  }

  $name = $line.Substring(0, $idx).Trim()
  $value = $line.Substring($idx + 1)
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

npm run dev
