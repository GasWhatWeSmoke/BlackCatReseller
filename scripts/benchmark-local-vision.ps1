[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BenchmarkArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$candidates = @(
  (Join-Path $projectRoot "worker\.venv\Scripts\python.exe"),
  (Join-Path $projectRoot "worker\python\python\python.exe")
)
$python = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $python) {
  throw "No repo-local worker Python found. Run npm.cmd run worker:setup first."
}
& $python (Join-Path $PSScriptRoot "benchmark_vision.py") @BenchmarkArgs
exit $LASTEXITCODE
