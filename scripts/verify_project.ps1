param(
    [switch]$SkipE2E
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$backendRoot = Join-Path $projectRoot "backend"
$frontendRoot = Join-Path $projectRoot "frontend"
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
$pythonCommand = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { "python" }

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

Write-Host "[1/4] Checking local Markdown links..." -ForegroundColor Cyan
$markdownFiles = @((Get-Item -LiteralPath (Join-Path $projectRoot "README.md"))) + @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot "docs") -Filter "*.md" -File -Recurse
)
$brokenLinks = @()
foreach ($markdownFile in $markdownFiles) {
    $content = Get-Content -LiteralPath $markdownFile.FullName -Raw
    foreach ($match in [regex]::Matches($content, '\[[^\]]*\]\(([^)]+)\)')) {
        $link = $match.Groups[1].Value.Trim()
        if ($link -match '^(https?://|mailto:|#)') { continue }
        $pathOnly = ($link -split '#', 2)[0]
        if (-not $pathOnly) { continue }
        $resolvedTarget = Join-Path $markdownFile.DirectoryName $pathOnly
        if (-not (Test-Path -LiteralPath $resolvedTarget)) {
            $brokenLinks += "$($markdownFile.FullName): $link"
        }
    }
}
if ($brokenLinks.Count -gt 0) {
    throw "Broken Markdown links:`n$($brokenLinks -join "`n")"
}

Write-Host "[2/4] Running backend tests and coverage..." -ForegroundColor Cyan
Invoke-CheckedCommand -Command $pythonCommand -Arguments @("-m", "pytest", "--cov=app", "--cov-fail-under=85") -WorkingDirectory $backendRoot

Write-Host "[3/4] Running frontend tests and production build..." -ForegroundColor Cyan
Invoke-CheckedCommand -Command "npm" -Arguments @("test", "--", "--run") -WorkingDirectory $frontendRoot
Invoke-CheckedCommand -Command "npm" -Arguments @("run", "build") -WorkingDirectory $frontendRoot

if (-not $SkipE2E) {
    Write-Host "[4/4] Running Playwright end-to-end test..." -ForegroundColor Cyan
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "test:e2e") -WorkingDirectory $frontendRoot
}
else {
    Write-Host "[4/4] Playwright end-to-end test skipped." -ForegroundColor Yellow
}

Write-Host "DevAtlas verification completed successfully." -ForegroundColor Green
