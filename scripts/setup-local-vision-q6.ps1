[CmdletBinding()]
param(
  [string]$ProfilePath = "",
  [string]$AssetRoot = $env:BLACKCAT_VISION_ROOT,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ([enum]::GetNames([Net.SecurityProtocolType]) -contains "Tls12") {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = Join-Path $ProjectRoot "config\local-vision-q6-benchmark.json"
}
$ProfilePath = [IO.Path]::GetFullPath($ProfilePath)

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-VisionAssetRoot {
  param([string]$Root, [string]$Override)
  if ([string]::IsNullOrWhiteSpace($Override)) {
    return [IO.Path]::GetFullPath((Join-Path $Root ".local\vision"))
  }
  Assert-Condition ([IO.Path]::IsPathRooted($Override) -and $Override -notmatch '^[A-Za-z]:[^\\/]') `
    "AssetRoot must be an absolute folder"
  $resolved = [IO.Path]::GetFullPath($Override).TrimEnd('\', '/')
  Assert-Condition ($resolved -ne [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') -and
    $resolved -ne [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')) `
    "AssetRoot must be a dedicated asset folder"
  return $resolved
}

function Resolve-ContainedPath {
  param([string]$Base, [string]$Relative, [string]$Label)
  Assert-Condition (-not [string]::IsNullOrWhiteSpace($Relative)) "$Label must not be empty"
  Assert-Condition (-not [IO.Path]::IsPathRooted($Relative)) "$Label must be relative"
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath((Join-Path $baseFull $Relative))
  Assert-Condition $candidate.StartsWith(
    $baseFull + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  ) "$Label escapes its allowed root"
  return $candidate
}

function Assert-ScopedPath {
  param([string]$Path, [string]$AllowedRoot)
  $root = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath($Path)
  Assert-Condition $candidate.StartsWith(
    $root + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  ) "Refusing to change a path outside the local vision root"
  Assert-Condition ($candidate -ne $root) "Refusing to change the local vision root"
}

function Assert-PinnedQ6Profile {
  param($Profile)
  Assert-Condition ([int]$Profile.schemaVersion -eq 1) "Unsupported Q6 profile schemaVersion"
  Assert-Condition ([string]$Profile.kind -eq "blackcat-local-vision-benchmark-profile") `
    "Unexpected Q6 profile kind"
  Assert-Condition ([string]$Profile.id -eq "qwen3.5-4b-q6-k-l") "Unexpected Q6 profile id"
  Assert-Condition ([string]$Profile.sourceRepository -eq "bartowski/Qwen_Qwen3.5-4B-GGUF") `
    "Unexpected Q6 source repository"
  Assert-Condition ([string]$Profile.revision -eq "4168f45a16a1290d65a4ec0fa312ae917a4c15d6") `
    "Q6 revision must remain immutable"
  Assert-Condition ([string]$Profile.directory -eq "models/qwen3.5-4b-q6-k-l") `
    "Unexpected Q6 model directory"

  $expected = @{
    weights = @{
      Name = "Qwen_Qwen3.5-4B-Q6_K_L.gguf"
      Url = "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q6_K_L.gguf?download=true"
      Sha256 = "0d7931a7f143ccfdf675c0d84d542c387cd9255af94ee9c8fb5fa6f6df7c08a0"
      Size = [int64]3959316448
    }
    projector = @{
      Name = "mmproj-Qwen_Qwen3.5-4B-bf16.gguf"
      Url = "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/mmproj-Qwen_Qwen3.5-4B-bf16.gguf?download=true"
      Sha256 = "463f39bd1c291c1186c319a8c90ff8640aafa678b14cbee2232d695113dfbb66"
      Size = [int64]675569216
    }
  }
  foreach ($role in @("weights", "projector")) {
    $artifact = $Profile.$role
    $pin = $expected[$role]
    Assert-Condition ([string]$artifact.name -eq $pin.Name) "$role filename drift"
    Assert-Condition ([string]$artifact.url -eq $pin.Url) "$role URL drift"
    Assert-Condition ([string]$artifact.sha256 -eq $pin.Sha256) "$role SHA256 drift"
    Assert-Condition ([int64]$artifact.size -eq $pin.Size) "$role size drift"
  }
}

function Test-VerifiedFile {
  param($Artifact, [string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if ([int64](Get-Item -LiteralPath $Path).Length -ne [int64]$Artifact.size) { return $false }
  return (Get-Sha256 $Path) -eq ([string]$Artifact.sha256).ToLowerInvariant()
}

function Install-VerifiedArtifact {
  param($Artifact, [string]$Destination, [string]$AllowedRoot)
  if (Test-VerifiedFile $Artifact $Destination) {
    Write-Host "Verified existing $([string]$Artifact.name)" -ForegroundColor Green
    return
  }
  $parent = Split-Path -Parent $Destination
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Destination.download-$([Guid]::NewGuid().ToString('N')).part"
  $backup = "$Destination.replace-$([Guid]::NewGuid().ToString('N')).bak"
  Assert-ScopedPath $temporary $AllowedRoot
  Assert-ScopedPath $backup $AllowedRoot
  try {
    Write-Host "Downloading pinned $([string]$Artifact.name)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri ([string]$Artifact.url) -OutFile $temporary -UseBasicParsing -TimeoutSec 3600
    Assert-Condition (Test-VerifiedFile $Artifact $temporary) `
      "Downloaded $([string]$Artifact.name) failed size or SHA-256 verification"
    $hadDestination = Test-Path -LiteralPath $Destination -PathType Leaf
    if ($hadDestination) { Move-Item -LiteralPath $Destination -Destination $backup }
    try {
      Move-Item -LiteralPath $temporary -Destination $Destination
      if ($hadDestination) { Remove-Item -LiteralPath $backup -Force }
    } catch {
      if ($hadDestination -and (Test-Path -LiteralPath $backup -PathType Leaf) -and
          -not (Test-Path -LiteralPath $Destination)) {
        Move-Item -LiteralPath $backup -Destination $Destination
      }
      throw
    }
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Assert-ScopedPath $temporary $AllowedRoot
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

Assert-Condition (Test-Path -LiteralPath $ProfilePath -PathType Leaf) `
  "Q6 benchmark profile not found: $ProfilePath"
$Profile = Get-Content -LiteralPath $ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-PinnedQ6Profile $Profile
$AssetRoot = Resolve-VisionAssetRoot $ProjectRoot $AssetRoot
if ($ValidateOnly) {
  Write-Host "Q6 benchmark profile is valid and fully pinned." -ForegroundColor Green
  return
}

$ModelDirectory = Resolve-ContainedPath $AssetRoot ([string]$Profile.directory) "Q6 model directory"
[IO.Directory]::CreateDirectory($ModelDirectory) | Out-Null
foreach ($role in @("weights", "projector")) {
  $artifact = $Profile.$role
  $destination = Resolve-ContainedPath $ModelDirectory ([string]$artifact.name) "$role destination"
  Install-VerifiedArtifact $artifact $destination $AssetRoot
}
Write-Host "Pinned Q6 benchmark assets are ready under $ModelDirectory" -ForegroundColor Green
