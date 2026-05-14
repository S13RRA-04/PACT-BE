param(
  [string]$ConfigPath = "$HOME\.cloudflared\cetu-pact-api-staging.yml"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Missing Cloudflared tunnel config: $ConfigPath"
}

cloudflared tunnel --config $ConfigPath run
