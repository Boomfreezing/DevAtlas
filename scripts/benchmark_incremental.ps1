param(
    [Parameter(Mandatory = $true)]
    [int]$ProjectId,
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [ValidateRange(1, 20)]
    [int]$FullRuns = 3,
    [ValidateRange(1, 50)]
    [int]$IncrementalRuns = 5
)

$ErrorActionPreference = "Stop"

function Measure-PostEndpoint {
    param(
        [string]$Path,
        [int]$Runs
    )

    $samples = @()
    for ($index = 1; $index -le $Runs; $index++) {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $response = Invoke-WebRequest -Method Post -Uri "$BaseUrl$Path" -UseBasicParsing
        $watch.Stop()
        if ($response.StatusCode -ne 200) {
            throw "Benchmark request failed with HTTP $($response.StatusCode)."
        }
        $samples += [math]::Round($watch.Elapsed.TotalMilliseconds, 2)
    }
    return $samples
}

function Get-SampleSummary {
    param([double[]]$Samples)

    $sorted = @($Samples | Sort-Object)
    $middle = [math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2 -eq 0) {
        ($sorted[$middle - 1] + $sorted[$middle]) / 2
    } else {
        $sorted[$middle]
    }
    return [ordered]@{
        runs = $Samples.Count
        samples_ms = $Samples
        median_ms = [math]::Round($median, 2)
        average_ms = [math]::Round(($Samples | Measure-Object -Average).Average, 2)
        minimum_ms = [math]::Round(($Samples | Measure-Object -Minimum).Minimum, 2)
        maximum_ms = [math]::Round(($Samples | Measure-Object -Maximum).Maximum, 2)
    }
}

$project = Invoke-RestMethod -Uri "$BaseUrl/api/projects/$ProjectId"
$fullSamples = Measure-PostEndpoint -Path "/api/projects/$ProjectId/reanalyze" -Runs $FullRuns
$incrementalSamples = Measure-PostEndpoint -Path "/api/projects/$ProjectId/incremental-reanalyze" -Runs $IncrementalRuns
$fullSummary = Get-SampleSummary -Samples $fullSamples
$incrementalSummary = Get-SampleSummary -Samples $incrementalSamples

[ordered]@{
    measured_at = (Get-Date).ToUniversalTime().ToString("o")
    project = [ordered]@{
        id = $project.id
        name = $project.name
        file_count = $project.file_count
        code_line_count = $project.code_line_count
    }
    full_reanalysis = $fullSummary
    unchanged_incremental = $incrementalSummary
    median_speedup = [math]::Round($fullSummary.median_ms / $incrementalSummary.median_ms, 2)
} | ConvertTo-Json -Depth 6
