"""Exercise the PowerShell entry point without launching its real tools."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "verify_project.ps1"
ENVIRONMENT_KEYS = (
    "TEMP", "TMP", "TMPDIR", "DEVATLAS_DATABASE_URL", "DEVATLAS_REPOSITORY_ROOT",
    "DEVATLAS_TEMPORARY_ROOT", "DEVATLAS_SEARCH_INDEX_ROOT",
    "DEVATLAS_PROVIDER_CONFIG_PATH", "DEVATLAS_SEMANTIC_SEARCH_ENABLED",
    "DEVATLAS_E2E_RUNTIME", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PYTHONUTF8",
    "PYTEST_ADDOPTS", "COVERAGE_FILE", "RUFF_CACHE_DIR",
)
DRIVER = r'''
param([switch]$RequestedSkipE2E, [int]$FailAt = 0)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$keys = @(
    "TEMP", "TMP", "TMPDIR", "DEVATLAS_DATABASE_URL", "DEVATLAS_REPOSITORY_ROOT",
    "DEVATLAS_TEMPORARY_ROOT", "DEVATLAS_SEARCH_INDEX_ROOT",
    "DEVATLAS_PROVIDER_CONFIG_PATH", "DEVATLAS_SEMANTIC_SEARCH_ENABLED",
    "DEVATLAS_E2E_RUNTIME", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PYTHONUTF8",
    "PYTEST_ADDOPTS", "COVERAGE_FILE", "RUFF_CACHE_DIR"
)
function Read-VerificationTestEnvironment {
    $snapshot = [ordered]@{}
    foreach ($key in $keys) {
        $snapshot[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    }
    return $snapshot
}
$before = Read-VerificationTestEnvironment
$beforeLocation = (Get-Location).Path
. (Join-Path $PSScriptRoot "scripts/verify_project.ps1")
$global:VerificationTestCalls = @()
$global:VerificationTestReads = @()
function Invoke-CheckedCommand {
    param([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
    $global:VerificationTestCalls += [ordered]@{
        command = $Command
        arguments = @($Arguments)
        working_directory = $WorkingDirectory
        environment = (Read-VerificationTestEnvironment)
    }
    if ($FailAt -gt 0 -and $global:VerificationTestCalls.Count -eq $FailAt) {
        throw "verification-test-command-failure-$FailAt"
    }
}
function Get-Content {
    param([string]$LiteralPath, [switch]$Raw)
    $global:VerificationTestReads += $LiteralPath
    if ($LiteralPath -eq $env:VERIFICATION_TEST_CALLER_DATABASE -or
        $LiteralPath -eq $env:VERIFICATION_TEST_CALLER_PROVIDER) {
        throw "verification-test-read-caller-data"
    }
    Microsoft.PowerShell.Management\Get-Content -LiteralPath $LiteralPath -Raw:$Raw
}
$failure = $null
try {
    Invoke-ProjectVerification -SkipE2E:$RequestedSkipE2E
}
catch {
    $failure = $_.Exception.Message
}
$result = [ordered]@{
    before = $before
    after = (Read-VerificationTestEnvironment)
    before_location = $beforeLocation
    after_location = (Get-Location).Path
    calls = @($global:VerificationTestCalls)
    reads = @($global:VerificationTestReads)
    error = $failure
}
[Console]::WriteLine("VERIFICATION_TEST_RESULT=" + ($result | ConvertTo-Json -Depth 8 -Compress))
if ($null -ne $failure) { exit 19 }
'''


@pytest.fixture
def verification_run(tmp_path):
    executable = shutil.which("pwsh") or shutil.which("powershell")
    if executable is None:
        pytest.skip("PowerShell is unavailable; the verification entry point is PowerShell-specific")
    project = tmp_path / "project with spaces"
    for name in ("scripts", "docs", "backend/.venv/Scripts", "frontend"):
        (project / name).mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SCRIPT, project / "scripts/verify_project.ps1")
    (project / "README.md").write_text("# Fixture\n[Guide](docs/guide.md)\n", encoding="utf-8")
    (project / "docs/guide.md").write_text("# Guide\n[Home](../README.md)\n", encoding="utf-8")
    driver = project / "verification-test-driver.ps1"
    driver.write_text(DRIVER, encoding="utf-8-sig")
    caller = tmp_path / "caller-data"
    caller.mkdir()
    caller_database = caller / "daily.db"
    caller_provider = caller / "providers.json"
    caller_database.write_bytes(b"synthetic-database-must-not-be-read")
    caller_provider.write_text('{"synthetic": "must-not-be-read"}', encoding="utf-8")
    environment = os.environ.copy()
    for key in ENVIRONMENT_KEYS:
        environment[key] = str(caller / key.lower())
    environment.update({
        "TEMP": str(caller), "TMP": str(caller), "TMPDIR": str(caller),
        "DEVATLAS_DATABASE_URL": f"sqlite:///{caller_database.as_posix()}",
        "DEVATLAS_PROVIDER_CONFIG_PATH": str(caller_provider),
        "TRANSFORMERS_OFFLINE": "0", "PYTHONUTF8": "0",
        "VERIFICATION_TEST_CALLER_DATABASE": str(caller_database),
        "VERIFICATION_TEST_CALLER_PROVIDER": str(caller_provider),
    })
    for key in ("DEVATLAS_SEMANTIC_SEARCH_ENABLED", "HF_HUB_OFFLINE", "DEVATLAS_E2E_RUNTIME"):
        environment.pop(key, None)  # Restoration must also remove previously absent variables.

    def run(*, skip_e2e=False, fail_at=0, broken_link=False, unset_runtime_environment=False,
            venv_layout="windows"):
        venv_executable = project / ("backend/.venv/bin/python" if venv_layout == "posix"
                                     else "backend/.venv/Scripts/python.exe")
        venv_executable.parent.mkdir(parents=True, exist_ok=True)
        # It is only selected and recorded by the stub, never executed.
        venv_executable.write_bytes(b"stub-only-not-executable")
        if unset_runtime_environment:
            for key in ("PYTEST_ADDOPTS", "COVERAGE_FILE", "RUFF_CACHE_DIR", "TMPDIR"):
                environment.pop(key, None)
        if broken_link:
            (project / "docs/guide.md").write_text("[Missing](missing.md)\n", encoding="utf-8")
        arguments = [executable, "-NoLogo", "-NoProfile", "-NonInteractive",
                     "-ExecutionPolicy", "Bypass", "-File", str(driver), "-FailAt", str(fail_at)]
        if skip_e2e:
            arguments.append("-RequestedSkipE2E")
        process = subprocess.run(
            arguments, cwd=project, env=environment, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=45, check=False,
        )
        records = [line.removeprefix("VERIFICATION_TEST_RESULT=") for line in process.stdout.splitlines()
                   if line.startswith("VERIFICATION_TEST_RESULT=")]
        assert len(records) == 1, f"No driver result: {process.stdout}\n{process.stderr}"
        result = json.loads(records[0])
        assert process.returncode == (19 if result["error"] else 0), process.stderr
        assert result["before"] == {key: environment.get(key) for key in ENVIRONMENT_KEYS}
        assert result["after_location"] == result["before_location"]
        assert set(result["reads"]) == {str(project / "README.md"), str(project / "docs/guide.md")}
        assert caller_database.read_bytes() == b"synthetic-database-must-not-be-read"
        assert caller_provider.read_text(encoding="utf-8") == '{"synthetic": "must-not-be-read"}'
        runtime_dirs = list((project / "data/tmp/verification").glob("run-*"))
        assert len(runtime_dirs) == 1
        runtime = runtime_dirs[0]
        assert (runtime / "tmp").is_dir()
        for call in result["calls"]:
            assert call["environment"] == {
                "TEMP": str(runtime / "tmp"), "TMP": str(runtime / "tmp"), "TMPDIR": str(runtime / "tmp"),
                "DEVATLAS_DATABASE_URL": f"sqlite:///{(runtime / 'startup.db').as_posix()}",
                "DEVATLAS_REPOSITORY_ROOT": str(runtime / "repositories"),
                "DEVATLAS_TEMPORARY_ROOT": str(runtime / "tmp"),
                "DEVATLAS_SEARCH_INDEX_ROOT": str(runtime / "indexes"),
                "DEVATLAS_PROVIDER_CONFIG_PATH": str(runtime / "unused-providers.json"),
                "DEVATLAS_SEMANTIC_SEARCH_ENABLED": "false",
                "DEVATLAS_E2E_RUNTIME": str(runtime / "e2e"),
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONUTF8": "1",
                "PYTEST_ADDOPTS": f'-o "cache_dir={(runtime / "pytest-cache").as_posix()}"',
                "COVERAGE_FILE": str(runtime / ".coverage"),
                "RUFF_CACHE_DIR": str(runtime / "ruff-cache"),
            }
        assert result["after"] == result["before"], result["error"]
        return project, result

    return run


def test_verification_isolates_runtime_and_runs_offline_checks_in_order(verification_run):
    project, result = verification_run()
    assert result["error"] is None
    calls = result["calls"]
    assert [call["arguments"] for call in calls] == [
        ["-m", "ruff", "check", "app", "tests", "evaluations"],
        ["-W", "error::ResourceWarning", "-m", "pytest", "--cov=app", "--cov-fail-under=85",
         "-W", "error::ResourceWarning", "-W", "error::pytest.PytestUnraisableExceptionWarning"],
        ["-m", "evaluations.repository_qa"],
        ["test", "--", "--run", "--maxWorkers=2"],
        ["run", "build"],
        ["run", "test:e2e"],
    ]
    assert all(call["command"] == str(project / "backend/.venv/Scripts/python.exe") for call in calls[:3])
    assert all(call["working_directory"] == str(project / "backend") for call in calls[:3])
    assert all(call["command"] in {"npm", "npm.cmd"} for call in calls[3:])
    assert all(call["working_directory"] == str(project / "frontend") for call in calls[3:])


def test_skip_e2e_still_runs_synthetic_qa_and_frontend_build(verification_run):
    _, result = verification_run(skip_e2e=True, unset_runtime_environment=True)
    assert result["error"] is None
    arguments = [call["arguments"] for call in result["calls"]]
    assert len(arguments) == 5
    assert ["-m", "evaluations.repository_qa"] in arguments
    assert ["test", "--", "--run", "--maxWorkers=2"] in arguments
    assert arguments[-1] == ["run", "build"]
    assert ["run", "test:e2e"] not in arguments


def test_failed_command_restores_environment_and_stops_remaining_checks(verification_run):
    _, result = verification_run(fail_at=3, unset_runtime_environment=True)
    assert result["error"] == "verification-test-command-failure-3"
    assert len(result["calls"]) == 3
    assert result["calls"][-1]["arguments"] == ["-m", "evaluations.repository_qa"]
    assert all(call["arguments"][0] != "test" for call in result["calls"])


def test_failed_markdown_check_restores_environment_without_launching_tools(verification_run):
    _, result = verification_run(broken_link=True)
    assert "Broken Markdown links:" in result["error"]
    assert "missing.md" in result["error"]
    assert result["calls"] == []


def test_posix_virtual_environment_is_selected_when_windows_layout_is_absent(verification_run):
    project, result = verification_run(venv_layout="posix")
    assert result["error"] is None
    assert not (project / "backend/.venv/Scripts/python.exe").exists()
    assert len(result["calls"]) == 6
    assert all(call["command"] == str(project / "backend/.venv/bin/python") for call in result["calls"][:3])
