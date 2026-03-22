param(
  [string]$ApiKey = "",
  [string]$ResponsesUrl = "",
  [string]$Model = "",
  [string]$Port = ""
)

$repoRoot = Split-Path -Parent $PSScriptRoot

if ($ApiKey) {
  $env:OPENAI_API_KEY = $ApiKey
}

if ($ResponsesUrl) {
  $env:OPENAI_RESPONSES_URL = $ResponsesUrl
}

if ($Model) {
  $env:OPENAI_PLANNER_MODEL = $Model
  $env:OPENAI_SYNTHESIS_MODEL = $Model
  $env:OPENAI_EVALUATOR_MODEL = $Model
  $env:OPENAI_DOCUMENT_MODEL = $Model
  $env:OPENAI_MULTIMODAL_DOCUMENT_MODEL = $Model
  $env:OPENAI_LAYOUT_MODEL = $Model
}

if ($Port) {
  $env:PORT = $Port
}

Write-Host "Starting Deep Web Search Console"
Write-Host ("OPENAI_API_KEY configured: " + [bool]($null -ne $env:OPENAI_API_KEY -and $env:OPENAI_API_KEY -ne ""))
Write-Host ("OPENAI_RESPONSES_URL: " + $(if ($env:OPENAI_RESPONSES_URL) { $env:OPENAI_RESPONSES_URL } else { "(auto/default)" }))
Write-Host ("OPENAI_PLANNER_MODEL: " + $(if ($env:OPENAI_PLANNER_MODEL) { $env:OPENAI_PLANNER_MODEL } else { "(auto/default)" }))
Write-Host ("PORT: " + $(if ($env:PORT) { $env:PORT } else { "3000" }))

Push-Location $repoRoot
try {
  node server.js
} finally {
  Pop-Location
}
