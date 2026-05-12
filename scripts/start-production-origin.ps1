param(
  [string]$EnvFile = ".env.pact-origin-runtime",
  [int]$Port = 4200,
  [string]$PublicBaseUrl = "https://pact2-api.cetu.online",
  [string]$PactWebBaseUrl = "https://pact2.cetu.online",
  [string]$LmsApiBaseUrl = "https://lms-api.cetu.online",
  [string]$FrontendOrigins = "https://pact2.cetu.online,https://lms.cetu.online"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $projectRoot

function Import-DotEnv([string]$Path) {
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $separator = $line.IndexOf("=")
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Missing $EnvFile."
}

Import-DotEnv $EnvFile

$env:NODE_ENV = "production"
$env:PORT = $Port.ToString()
$env:APP_BASE_URL = $PublicBaseUrl
$env:PACT_WEB_BASE_URL = $PactWebBaseUrl
$env:LMS_API_BASE_URL = $LmsApiBaseUrl
$env:LMS_PLATFORM_ISSUER = $LmsApiBaseUrl
$env:LMS_PLATFORM_JWKS_URI = "$LmsApiBaseUrl/api/v1/lti/jwks"
$env:LMS_DEEP_LINK_RETURN_URL = "$LmsApiBaseUrl/api/v1/lti/deep-linking/return"
$env:CORS_ORIGINS = $FrontendOrigins
$env:MONGO_COLLECTION_PREFIX = ""

npm run start
