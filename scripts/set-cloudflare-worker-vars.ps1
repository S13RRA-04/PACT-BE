param(
  [string]$Origin,
  [string]$CorsOrigins = "https://cetu-pact-web-staging.pages.dev,https://pact-staging.cetu.online"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Origin)) {
  throw "Origin is required. Pass the real HTTPS PACT Node API origin."
}

$uri = $null
if (-not [System.Uri]::TryCreate($Origin, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
  throw "Origin must be an absolute HTTPS URL."
}

npx wrangler deploy --var "PACT_API_ORIGIN:$Origin" --var "CORS_ORIGINS:$CorsOrigins"
