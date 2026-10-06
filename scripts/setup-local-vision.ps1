[CmdletBinding()]
param(
  [string]$ConfigPath = "",
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
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $ProjectRoot "config\local-vision.json"
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

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
  param(
    [Parameter(Mandatory = $true)][string]$Base,
    [Parameter(Mandatory = $true)][string]$Relative,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-Condition (-not [string]::IsNullOrWhiteSpace($Relative)) "$Label must not be empty"
  Assert-Condition (-not [IO.Path]::IsPathRooted($Relative)) "$Label must be relative: $Relative"
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $candidate = [IO.Path]::GetFullPath((Join-Path $baseFull $Relative))
  $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
  Assert-Condition ($candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) `
    "$Label escapes its allowed root: $Relative"
  return $candidate
}

function Assert-ScopedTemporaryPath {
  param([string]$Path, [string]$AllowedRoot)
  $rootFull = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\', '/')
  $pathFull = [IO.Path]::GetFullPath($Path)
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  Assert-Condition ($pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) `
    "Refusing to remove a path outside the local vision root: $pathFull"
  Assert-Condition ($pathFull -ne $rootFull) "Refusing to remove the local vision root"
}

function Get-ContainedRelativePath {
  param([string]$Base, [string]$Path)
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $pathFull = [IO.Path]::GetFullPath($Path)
  $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
  Assert-Condition ($pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) `
    "Path is outside the local vision root: $pathFull"
  return $pathFull.Substring($prefix.Length).Replace('\', '/')
}

function Get-RuntimeFileInventory {
  param([Parameter(Mandatory = $true)][string]$RuntimeDirectory)
  Assert-Condition (Test-Path -LiteralPath $RuntimeDirectory -PathType Container) `
    "Runtime directory is missing: $RuntimeDirectory"

  $items = @(Get-ChildItem -LiteralPath $RuntimeDirectory -Force -Recurse)
  foreach ($item in $items) {
    Assert-Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
      "Runtime contains a reparse point: $($item.FullName)"
  }

  $inventory = @($items | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    [ordered]@{
      name = Get-ContainedRelativePath $RuntimeDirectory $_.FullName
      size = [int64]$_.Length
      sha256 = Get-Sha256 $_.FullName
    }
  } | Sort-Object { [string]$_.name })
  Assert-Condition ($inventory.Count -gt 0) "Runtime directory contains no files"
  return $inventory
}

function Remove-ScopedFile {
  param([string]$Path, [string]$AllowedRoot)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  Assert-ScopedTemporaryPath $Path $AllowedRoot
  Remove-Item -LiteralPath $Path -Force
}

function Remove-ScopedDirectory {
  param([string]$Path, [string]$AllowedRoot)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  Assert-ScopedTemporaryPath $Path $AllowedRoot
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Read-JsonFile {
  param([string]$Path)
  Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) "Missing JSON file: $Path"
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Assert-ArtifactShape {
  param($Artifact, [string]$Role)
  $name = [string]$Artifact.name
  $url = [string]$Artifact.url
  $sha256 = [string]$Artifact.sha256
  $size = [int64]$Artifact.size
  Assert-Condition (-not [string]::IsNullOrWhiteSpace($name)) "$Role name is missing"
  Assert-Condition ([IO.Path]::GetFileName($name) -eq $name) "$Role name must be a filename"
  Assert-Condition ($url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) `
    "$Role URL must use HTTPS"
  Assert-Condition ($sha256 -match '^[0-9a-fA-F]{64}$') "$Role SHA256 is invalid"
  Assert-Condition ($size -gt 0) "$Role size must be positive"
}

function Assert-PinnedManifest {
  param($Config)

  Assert-Condition ([int]$Config.schemaVersion -eq 1) "Unsupported local vision schemaVersion"
  Assert-Condition ([string]$Config.assetRoot -eq ".local/vision") `
    "assetRoot must remain .local/vision"
  Assert-Condition ([string]$Config.runtime.id -eq "llama-b10218-win-cuda-13.3-x64") `
    "Unexpected llama.cpp runtime id"
  Assert-Condition ([string]$Config.runtime.releaseTag -eq "b10218") `
    "llama.cpp must remain pinned to b10218"
  Assert-Condition ([string]$Config.runtime.cudaVersion -eq "13.3") `
    "CUDA runtime must remain pinned to 13.3"
  Assert-Condition ([string]$Config.runtime.executable -eq "llama-server.exe") `
    "Unexpected llama.cpp server executable"
  Assert-Condition ([string]$Config.runtime.directory -eq "runtime/llama-b10218-win-cuda-13.3-x64") `
    "Unexpected llama.cpp runtime directory"
  Assert-Condition ([string]$Config.model.id -eq "qwen3.5-4b-q4-k-m") `
    "Unexpected local vision model id"
  Assert-Condition ([string]$Config.model.revision -eq "f9f88ac3e234be915e23811a6d28ea287bdb927e") `
    "Unexpected local vision model revision"
  Assert-Condition ([string]$Config.model.directory -eq "models/qwen3.5-4b-q4-k-m") `
    "Unexpected local vision model directory"
  Assert-Condition ([string]$Config.server.host -eq "127.0.0.1") `
    "The vision server may only bind to 127.0.0.1"
  Assert-Condition ([int]$Config.server.port -eq 1235) "The vision server port must be 1235"
  Assert-Condition ([string]$Config.server.alias -eq "blackcat-vision") `
    "The vision server alias must be blackcat-vision"
  Assert-Condition ([string]$Config.server.apiKeyFile -eq "api-key.txt") `
    "The vision server API key path must remain api-key.txt"
  Assert-Condition ([int]$Config.server.maxRestarts -eq 1) `
    "The supervisor restart cap must remain exactly one"
  Assert-Condition ([string]$Config.receipts.setup -eq "setup-receipt.json" -and
    [string]$Config.receipts.state -eq "server-state.json" -and
    [string]$Config.receipts.log -eq "logs/llama-server.log") `
    "Unexpected local vision receipt paths"

  $approvedArguments = @(
    "-ngl", "all", "-c", "8192", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
    "--parallel", "1", "-b", "512", "-ub", "256", "-t", "12", "--reasoning", "off",
    "--image-min-tokens", "1024", "--image-max-tokens", "1024", "--cache-ram", "0",
    "--cors-origins", "http://127.0.0.1", "--no-cors-credentials",
    "--offline", "--no-webui", "-lv", "4"
  )
  $actualArguments = @($Config.server.arguments | ForEach-Object { [string]$_ })
  Assert-Condition ($actualArguments.Count -eq $approvedArguments.Count) `
    "The local vision argument list is not the approved baseline"
  for ($index = 0; $index -lt $approvedArguments.Count; $index += 1) {
    Assert-Condition ($actualArguments[$index] -eq $approvedArguments[$index]) `
      "The local vision argument list differs at index $index"
  }

  $pinned = @{
    "llama-b10218-bin-win-cuda-13.3-x64.zip" = @{
      Url = "https://github.com/ggml-org/llama.cpp/releases/download/b10218/llama-b10218-bin-win-cuda-13.3-x64.zip"
      Sha256 = "c275a6a5923e1d665d0b1d2b32ae266241a83936e9a5c2f0453b99d21877c88f"
      Size = [int64]146509386
    }
    "cudart-llama-bin-win-cuda-13.3-x64.zip" = @{
      Url = "https://github.com/ggml-org/llama.cpp/releases/download/b10218/cudart-llama-bin-win-cuda-13.3-x64.zip"
      Sha256 = "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e"
      Size = [int64]390970417
    }
    "Qwen3.5-4B-Q4_K_M.gguf" = @{
      Url = "https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/resolve/f9f88ac3e234be915e23811a6d28ea287bdb927e/Qwen3.5-4B-Q4_K_M.gguf?download=true"
      Sha256 = "25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c"
      Size = [int64]2707513696
    }
    "mmproj-Qwen3.5-4B-BF16.gguf" = @{
      Url = "https://huggingface.co/lmstudio-community/Qwen3.5-4B-GGUF/resolve/f9f88ac3e234be915e23811a6d28ea287bdb927e/mmproj-Qwen3.5-4B-BF16.gguf?download=true"
      Sha256 = "ae08d9d7eceb8f2d0672d61b5e6aa78b611f2942b55ed71d21414980cc454b91"
      Size = [int64]675568768
    }
  }

  $artifacts = @($Config.runtime.archives) + @($Config.model.weights, $Config.model.projector)
  Assert-Condition (@($Config.runtime.archives).Count -eq 2) `
    "Expected exactly two pinned runtime archives"
  Assert-Condition ($artifacts.Count -eq 4) "Expected exactly four pinned artifacts"
  Assert-Condition (@($artifacts | ForEach-Object { [string]$_.name } | Select-Object -Unique).Count -eq 4) `
    "Pinned artifact names must be unique"
  foreach ($artifact in $artifacts) {
    Assert-ArtifactShape $artifact ([string]$artifact.name)
    $name = [string]$artifact.name
    Assert-Condition $pinned.ContainsKey($name) "Unexpected artifact in manifest: $name"
    $expected = $pinned[$name]
    Assert-Condition ([string]$artifact.url -eq $expected.Url) "URL drift for $name"
    Assert-Condition ([string]$artifact.sha256 -eq $expected.Sha256) "SHA256 drift for $name"
    Assert-Condition ([int64]$artifact.size -eq $expected.Size) "Size drift for $name"
  }
}

function Test-VerifiedFile {
  param($Artifact, [string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path
  if ([int64]$item.Length -ne [int64]$Artifact.size) { return $false }
  return (Get-Sha256 $Path) -eq ([string]$Artifact.sha256).ToLowerInvariant()
}

function Move-FileAtomically {
  param([string]$Source, [string]$Destination, [string]$AllowedRoot)
  Assert-ScopedTemporaryPath $Source $AllowedRoot
  Assert-ScopedTemporaryPath $Destination $AllowedRoot
  $backup = "$Destination.replace-$([Guid]::NewGuid().ToString('N')).bak"
  $hadDestination = Test-Path -LiteralPath $Destination -PathType Leaf
  if ($hadDestination) { Move-Item -LiteralPath $Destination -Destination $backup }
  try {
    Move-Item -LiteralPath $Source -Destination $Destination
    if ($hadDestination) { Remove-ScopedFile $backup $AllowedRoot }
  } catch {
    if ($hadDestination -and (Test-Path -LiteralPath $backup -PathType Leaf) -and
        -not (Test-Path -LiteralPath $Destination)) {
      Move-Item -LiteralPath $backup -Destination $Destination
    }
    throw
  }
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
  try {
    Write-Host "Downloading $([string]$Artifact.name)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri ([string]$Artifact.url) -OutFile $temporary -UseBasicParsing -TimeoutSec 3600
    Assert-Condition (Test-VerifiedFile $Artifact $temporary) `
      "Downloaded artifact failed size or SHA256 verification: $([string]$Artifact.name)"
    Move-FileAtomically $temporary $Destination $AllowedRoot
    Assert-Condition (Test-VerifiedFile $Artifact $Destination) `
      "Installed artifact verification failed: $([string]$Artifact.name)"
  } finally {
    Remove-ScopedFile $temporary $AllowedRoot
  }
}

function Assert-SafeZip {
  param([string]$Archive, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
  $prefix = $destinationFull + [IO.Path]::DirectorySeparatorChar
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($entry in $zip.Entries) {
      $entryPath = [string]$entry.FullName
      Assert-Condition (-not [IO.Path]::IsPathRooted($entryPath)) `
        "Archive contains a rooted path: $entryPath"
      $resolved = [IO.Path]::GetFullPath((Join-Path $destinationFull $entryPath))
      Assert-Condition ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) `
        "Archive entry escapes the staging directory: $entryPath"
      $unixType = (([int64]$entry.ExternalAttributes -shr 16) -band 0xF000)
      Assert-Condition ($unixType -ne 0xA000) "Archive contains a symbolic link: $entryPath"
    }
  } finally {
    $zip.Dispose()
  }
}

function Install-VerifiedRuntime {
  param(
    $Config,
    [string[]]$ArchivePaths,
    [string]$RuntimeDirectory,
    [string]$AllowedRoot
  )
  $runtimeParent = Split-Path -Parent $RuntimeDirectory
  [IO.Directory]::CreateDirectory($runtimeParent) | Out-Null
  $staging = Join-Path $runtimeParent (".staging-" + [Guid]::NewGuid().ToString("N"))
  $backup = "$RuntimeDirectory.replace-$([Guid]::NewGuid().ToString('N')).bak"
  [IO.Directory]::CreateDirectory($staging) | Out-Null
  try {
    foreach ($archive in $ArchivePaths) {
      Assert-SafeZip $archive $staging
      Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
    }
    foreach ($requiredName in @(
      "llama-server.exe", "llama-server-impl.dll", "ggml-cuda.dll",
      "cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll"
    )) {
      Assert-Condition (Test-Path -LiteralPath (Join-Path $staging $requiredName) -PathType Leaf) `
        "Verified runtime did not contain $requiredName"
    }

    $hadRuntime = Test-Path -LiteralPath $RuntimeDirectory -PathType Container
    if ($hadRuntime) { Move-Item -LiteralPath $RuntimeDirectory -Destination $backup }
    try {
      Move-Item -LiteralPath $staging -Destination $RuntimeDirectory
      if ($hadRuntime) { Remove-ScopedDirectory $backup $AllowedRoot }
    } catch {
      if ($hadRuntime -and (Test-Path -LiteralPath $backup -PathType Container) -and
          -not (Test-Path -LiteralPath $RuntimeDirectory)) {
        Move-Item -LiteralPath $backup -Destination $RuntimeDirectory
      }
      throw
    }
  } finally {
    Remove-ScopedDirectory $staging $AllowedRoot
  }
}

function Write-JsonAtomically {
  param($Value, [string]$Destination, [string]$AllowedRoot)
  $parent = Split-Path -Parent $Destination
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Destination.write-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 12
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporary, $json + "`n", $utf8NoBom)
    Move-FileAtomically $temporary $Destination $AllowedRoot
  } finally {
    Remove-ScopedFile $temporary $AllowedRoot
  }
}

function Test-LocalApiKeyFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) -cmatch '^[0-9a-f]{64}\n$'
  } catch {
    return $false
  }
}

function New-LocalApiKeyFile {
  param([string]$Destination, [string]$AllowedRoot)
  $parent = Split-Path -Parent $Destination
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Destination.write-$([Guid]::NewGuid().ToString('N')).tmp"
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] 32
    $random.GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    [IO.File]::WriteAllText($temporary, $secret + "`n", (New-Object Text.UTF8Encoding($false)))
    Move-FileAtomically $temporary $Destination $AllowedRoot
  } finally {
    $random.Dispose()
    Remove-ScopedFile $temporary $AllowedRoot
  }
  Assert-Condition (Test-LocalApiKeyFile $Destination) "Failed to create the local vision API credential"
}

function Test-CurrentSetupReceipt {
  param(
    [string]$ReceiptPath,
    [string]$ConfigSha256,
    [string]$ExpectedAssetRoot,
    [string]$ExecutablePath,
    [string]$RuntimeId,
    [string]$ModelId,
    [string]$ExpectedRuntimeExecutable,
    [string]$ExpectedWeights,
    [string]$ExpectedProjector,
    [string]$ApiKeyPath,
    [string]$ExpectedApiKeyFile
  )
  if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { return $false }
  try {
    $receipt = Read-JsonFile $ReceiptPath
    if ([int]$receipt.schemaVersion -ne 1 -or
        [string]$receipt.kind -ne "blackcat-local-vision-setup" -or
        [string]$receipt.configSha256 -ne $ConfigSha256 -or
        -not [string]::Equals(
          [IO.Path]::GetFullPath([string]$receipt.assetRoot).TrimEnd('\', '/'),
          [IO.Path]::GetFullPath($ExpectedAssetRoot).TrimEnd('\', '/'),
          [StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$receipt.runtime.id -ne $RuntimeId -or
        [string]$receipt.runtime.executable -ne $ExpectedRuntimeExecutable -or
        [string]$receipt.model.id -ne $ModelId -or
        [string]$receipt.model.weights -ne $ExpectedWeights -or
        [string]$receipt.model.projector -ne $ExpectedProjector -or
        [string]$receipt.server.apiKeyFile -ne $ExpectedApiKeyFile -or
        [string]$receipt.server.apiKeySha256 -cnotmatch '^[0-9a-f]{64}$' -or
        -not (Test-LocalApiKeyFile $ApiKeyPath) -or
        (Get-Sha256 $ApiKeyPath) -cne [string]$receipt.server.apiKeySha256 -or
        -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
      return $false
    }
    $runtimeDirectory = Split-Path -Parent $ExecutablePath
    $actualFiles = @(Get-RuntimeFileInventory $runtimeDirectory)
    $receiptFiles = @($receipt.runtime.files)
    if ($receiptFiles.Count -ne $actualFiles.Count) { return $false }

    $recordedFiles = @{}
    foreach ($entry in $receiptFiles) {
      $name = [string]$entry.name
      if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains('\') -or
          [IO.Path]::IsPathRooted($name) -or $recordedFiles.ContainsKey($name) -or
          [int64]$entry.size -lt 0 -or [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        return $false
      }
      $resolved = Resolve-ContainedPath $runtimeDirectory $name "runtime receipt file"
      if ((Get-ContainedRelativePath $runtimeDirectory $resolved) -cne $name) { return $false }
      $recordedFiles[$name] = $entry
    }
    foreach ($actual in $actualFiles) {
      $name = [string]$actual.name
      if (-not $recordedFiles.ContainsKey($name)) { return $false }
      $recorded = $recordedFiles[$name]
      if ([int64]$recorded.size -ne [int64]$actual.size -or
          [string]$recorded.sha256 -cne [string]$actual.sha256) { return $false }
    }
    return [string]$receipt.runtime.executableSha256 -cmatch '^[0-9a-f]{64}$' -and
      (Get-Sha256 $ExecutablePath) -ceq [string]$receipt.runtime.executableSha256
  } catch {
    return $false
  }
}

Assert-Condition (Test-Path -LiteralPath $ConfigPath -PathType Leaf) `
  "Local vision manifest not found: $ConfigPath"
$Config = Read-JsonFile $ConfigPath
Assert-PinnedManifest $Config

$runtimeRelative = [string]$Config.runtime.directory
$modelRelative = [string]$Config.model.directory
$null = Resolve-ContainedPath $ProjectRoot $runtimeRelative "runtime.directory validation"
$null = Resolve-ContainedPath $ProjectRoot $modelRelative "model.directory validation"
$AssetRoot = Resolve-VisionAssetRoot $ProjectRoot $AssetRoot

if ($ValidateOnly) {
  Write-Host "Local vision manifest is valid and fully pinned." -ForegroundColor Green
  return
}

Assert-Condition ($AssetRoot -ne $ProjectRoot) "AssetRoot must not be the project root"
[IO.Directory]::CreateDirectory($AssetRoot) | Out-Null

$downloadsDirectory = Resolve-ContainedPath $AssetRoot "downloads" "downloads directory"
$runtimeDirectory = Resolve-ContainedPath $AssetRoot $runtimeRelative "runtime directory"
$modelDirectory = Resolve-ContainedPath $AssetRoot $modelRelative "model directory"
$apiKeyPath = Resolve-ContainedPath $AssetRoot ([string]$Config.server.apiKeyFile) "server API key"
$setupReceipt = Resolve-ContainedPath $AssetRoot ([string]$Config.receipts.setup) "setup receipt"
[IO.Directory]::CreateDirectory($downloadsDirectory) | Out-Null
[IO.Directory]::CreateDirectory($modelDirectory) | Out-Null

$archivePaths = @()
foreach ($archive in @($Config.runtime.archives)) {
  $destination = Resolve-ContainedPath $downloadsDirectory ([string]$archive.name) "archive destination"
  Install-VerifiedArtifact $archive $destination $AssetRoot
  $archivePaths += $destination
}

$weightsPath = Resolve-ContainedPath $modelDirectory ([string]$Config.model.weights.name) `
  "model weights destination"
$projectorPath = Resolve-ContainedPath $modelDirectory ([string]$Config.model.projector.name) `
  "projector destination"
Install-VerifiedArtifact $Config.model.weights $weightsPath $AssetRoot
Install-VerifiedArtifact $Config.model.projector $projectorPath $AssetRoot

$configSha256 = Get-Sha256 $ConfigPath
$executablePath = Resolve-ContainedPath $runtimeDirectory ([string]$Config.runtime.executable) `
  "runtime executable"
$expectedRuntimeExecutable = Get-ContainedRelativePath $AssetRoot $executablePath
$expectedWeights = Get-ContainedRelativePath $AssetRoot $weightsPath
$expectedProjector = Get-ContainedRelativePath $AssetRoot $projectorPath
$expectedApiKeyFile = Get-ContainedRelativePath $AssetRoot $apiKeyPath
$receiptCurrent = Test-CurrentSetupReceipt `
  -ReceiptPath $setupReceipt -ConfigSha256 $configSha256 -ExpectedAssetRoot $AssetRoot `
  -ExecutablePath $executablePath -RuntimeId ([string]$Config.runtime.id) `
  -ModelId ([string]$Config.model.id) -ExpectedRuntimeExecutable $expectedRuntimeExecutable `
  -ExpectedWeights $expectedWeights -ExpectedProjector $expectedProjector `
  -ApiKeyPath $apiKeyPath -ExpectedApiKeyFile $expectedApiKeyFile

if (-not $receiptCurrent) {
  Write-Host "Installing verified llama.cpp runtime..." -ForegroundColor Cyan
  Install-VerifiedRuntime $Config $archivePaths $runtimeDirectory $AssetRoot
  Assert-Condition (Test-Path -LiteralPath $executablePath -PathType Leaf) `
    "Runtime install completed without llama-server.exe"
  New-LocalApiKeyFile $apiKeyPath $AssetRoot

  $artifactReceipts = @()
  $runtimeFileReceipts = @(Get-RuntimeFileInventory $runtimeDirectory)
  foreach ($archiveIndex in 0..($archivePaths.Count - 1)) {
    $archive = @($Config.runtime.archives)[$archiveIndex]
    $artifactReceipts += [ordered]@{
      role = "runtime-archive"
      name = [string]$archive.name
      path = Get-ContainedRelativePath $AssetRoot $archivePaths[$archiveIndex]
      sha256 = [string]$archive.sha256
      size = [int64]$archive.size
    }
  }
  foreach ($entry in @(
    @{ Role = "model"; Artifact = $Config.model.weights; Path = $weightsPath },
    @{ Role = "projector"; Artifact = $Config.model.projector; Path = $projectorPath }
  )) {
    $artifactReceipts += [ordered]@{
      role = [string]$entry.Role
      name = [string]$entry.Artifact.name
      path = Get-ContainedRelativePath $AssetRoot ([string]$entry.Path)
      sha256 = [string]$entry.Artifact.sha256
      size = [int64]$entry.Artifact.size
    }
  }

  $receipt = [ordered]@{
    schemaVersion = 1
    kind = "blackcat-local-vision-setup"
    installedAt = [DateTime]::UtcNow.ToString("o")
    configSha256 = $configSha256
    assetRoot = $AssetRoot
    runtime = [ordered]@{
      id = [string]$Config.runtime.id
      releaseTag = [string]$Config.runtime.releaseTag
      cudaVersion = [string]$Config.runtime.cudaVersion
      executable = $expectedRuntimeExecutable
      executableSha256 = Get-Sha256 $executablePath
      files = $runtimeFileReceipts
    }
    model = [ordered]@{
      id = [string]$Config.model.id
      weights = $expectedWeights
      projector = $expectedProjector
    }
    server = [ordered]@{
      host = [string]$Config.server.host
      port = [int]$Config.server.port
      alias = [string]$Config.server.alias
      apiKeyFile = $expectedApiKeyFile
      apiKeySha256 = Get-Sha256 $apiKeyPath
    }
    artifacts = $artifactReceipts
  }
  Write-JsonAtomically $receipt $setupReceipt $AssetRoot
} else {
  Write-Host "Verified existing local vision installation." -ForegroundColor Green
}

Write-Host "Local vision assets are ready at $AssetRoot" -ForegroundColor Green
Write-Host "No server was started. Launch Black Cat Reseller to use the supervised runtime."
