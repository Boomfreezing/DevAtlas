param(
    [switch]$SkipE2E
)

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

function Invoke-ProjectVerification {
    param([switch]$SkipE2E)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
    $backendRoot = Join-Path $projectRoot "backend"
    $frontendRoot = Join-Path $projectRoot "frontend"
    $venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
    $posixVenvPython = Join-Path $backendRoot ".venv/bin/python"
    $pythonCommand = if (Test-Path -LiteralPath $venvPython) { $venvPython }
        elseif (Test-Path -LiteralPath $posixVenvPython) { $posixVenvPython }
        else { "python" }
    $npmCommand = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }

    # Keep verification away from daily data, provider settings and the system temp
    # directory. Restore the caller's environment on success AND on failure.
    $runtimeRoot = Join-Path $projectRoot ("data/tmp/verification/run-" + [guid]::NewGuid().ToString("N"))
    $temporaryRoot = Join-Path $runtimeRoot "tmp"
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $verificationEnvironment = @{
        TEMP = $temporaryRoot
        TMP = $temporaryRoot
        TMPDIR = $temporaryRoot
        DEVATLAS_DATABASE_URL = "sqlite:///" + (Join-Path $runtimeRoot "startup.db").Replace("\", "/")
        DEVATLAS_REPOSITORY_ROOT = (Join-Path $runtimeRoot "repositories")
        DEVATLAS_TEMPORARY_ROOT = $temporaryRoot
        DEVATLAS_SEARCH_INDEX_ROOT = (Join-Path $runtimeRoot "indexes")
        DEVATLAS_PROVIDER_CONFIG_PATH = (Join-Path $runtimeRoot "unused-providers.json")
        DEVATLAS_SEMANTIC_SEARCH_ENABLED = "false"
        DEVATLAS_E2E_RUNTIME = (Join-Path $runtimeRoot "e2e")
        HF_HUB_OFFLINE = "1"
        TRANSFORMERS_OFFLINE = "1"
        PYTHONUTF8 = "1"
        PYTEST_ADDOPTS = '-o "cache_dir=' + (Join-Path $runtimeRoot "pytest-cache").Replace("\", "/") + '"'
        COVERAGE_FILE = (Join-Path $runtimeRoot ".coverage")
        RUFF_CACHE_DIR = (Join-Path $runtimeRoot "ruff-cache")
    }
    $savedEnvironment = @{}
    foreach ($name in $verificationEnvironment.Keys) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    try {
        foreach ($name in $verificationEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $verificationEnvironment[$name], "Process")
        }
        Write-Host "Verification runtime: $runtimeRoot"
        Write-Host "[1/6] Checking local Markdown links..." -ForegroundColor Cyan
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

        Write-Host "[2/6] Running backend lint checks..." -ForegroundColor Cyan
        Invoke-CheckedCommand -Command $pythonCommand -Arguments @("-m", "ruff", "check", "app", "tests", "evaluations") -WorkingDirectory $backendRoot

        Write-Host "[3/6] Running backend tests and coverage..." -ForegroundColor Cyan
        Invoke-CheckedCommand -Command $pythonCommand -Arguments @("-W", "error::ResourceWarning", "-m", "pytest", "--cov=app", "--cov-fail-under=85", "-W", "error::ResourceWarning", "-W", "error::pytest.PytestUnraisableExceptionWarning") -WorkingDirectory $backendRoot

        Write-Host "[4/6] Running synthetic QA evidence regression (offline)..." -ForegroundColor Cyan
        Invoke-CheckedCommand -Command $pythonCommand -Arguments @("-m", "evaluations.repository_qa") -WorkingDirectory $backendRoot

        Write-Host "[5/6] Running frontend tests and production build..." -ForegroundColor Cyan
        Invoke-CheckedCommand -Command $npmCommand -Arguments @("test", "--", "--run", "--maxWorkers=2") -WorkingDirectory $frontendRoot
        Invoke-CheckedCommand -Command $npmCommand -Arguments @("run", "build") -WorkingDirectory $frontendRoot

        if (-not $SkipE2E) {
            Write-Host "[6/6] Running Playwright end-to-end tests..." -ForegroundColor Cyan
            Invoke-CheckedCommand -Command $npmCommand -Arguments @("run", "test:e2e") -WorkingDirectory $frontendRoot
        }
        else {
            Write-Host "[6/6] Playwright end-to-end tests skipped." -ForegroundColor Yellow
        }

        Write-Host "DevAtlas verification completed successfully." -ForegroundColor Green
    }
    finally {
        foreach ($name in $savedEnvironment.Keys) {
            if ($null -eq $savedEnvironment[$name]) {
                # PowerShell can coerce $null into an empty string for .NET;
                # remove an originally absent variable instead of leaving it set.
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
            else {
                [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
            }
        }
    }
}

# Dot-sourcing exposes the entry point for isolated script regression tests.
if ($MyInvocation.InvocationName -ne ".") {
    Invoke-ProjectVerification -SkipE2E:$SkipE2E
}
