$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'launch-guards.ps1')
$TempPrefix = Join-Path ([IO.Path]::GetTempPath()) 'blackcat-launch-test-'
$TempRoot = $TempPrefix + [Guid]::NewGuid().ToString('N')
[IO.Directory]::CreateDirectory($TempRoot) | Out-Null
$failures = 0
function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if (-not $Condition) { $script:failures++ }
  Write-Host "  [$(if ($Condition) {'ok'} else {'FAIL'})] $Name$(if (-not $Condition) { ' ' + $Detail })"
}

$runner = Join-Path $TempRoot 'fixture-runner.ps1'
@'
param([string]$ProjectRoot, [string]$Scenario)
$ErrorActionPreference='Stop'
$global:FixtureRoot=$ProjectRoot
$global:FixtureScenario=$Scenario
$global:FixtureReads=0
$env:BLACKCAT_LAUNCH_TEST_CASE=$Scenario
function Global:Get-CimInstance {
  [CmdletBinding()] param($ClassName,$Filter)
  $global:FixtureReads++
  if ($global:FixtureScenario -eq 'process-error') { throw 'fixture process inspection failed' }
  if ($global:FixtureScenario -in @('existing','existing-error') -or ($global:FixtureScenario -eq 'app-appears' -and $global:FixtureReads -ge 3)) {
    $exe=Join-Path $global:FixtureRoot 'node_modules\electron\dist\electron.exe'
    [pscustomobject]@{ExecutablePath=$exe;CommandLine=('"'+$exe+'" "'+$global:FixtureRoot+'"');ProcessId=70001}
  } elseif ($global:FixtureScenario -eq 'worker') {
    [pscustomobject]@{ExecutablePath='C:\Python\python.exe';CommandLine=('python "'+$global:FixtureRoot+'\worker\job.py"');ProcessId=70002}
  }
}
function Global:Get-NetTCPConnection {
  [CmdletBinding()] param($State)
  if ($global:FixtureScenario -eq 'port-error') { throw 'fixture listener inspection failed' }
  if ($global:FixtureScenario -eq 'occupied' -or
      ($global:FixtureScenario -eq 'port-appears' -and $global:FixtureReads -ge 3) -or
      ($global:FixtureScenario -eq 'late-port' -and $global:FixtureReads -ge 4)) {
    [pscustomobject]@{LocalPort=41999;OwningProcess=80001}
  }
}
function Global:npm.cmd {
  Add-Content -LiteralPath (Join-Path $global:FixtureRoot 'var\actions.log') -Value 'build'
  $global:LASTEXITCODE=0
  if ($global:FixtureScenario -eq 'build-error') { $global:LASTEXITCODE=7 }
  if ($global:FixtureScenario -notin @('build-error','icons-missing')) {
    [IO.Directory]::CreateDirectory((Join-Path $global:FixtureRoot 'build')) | Out-Null
    foreach ($name in @('icon.png','tray.png','icon.ico')) { [IO.File]::WriteAllText((Join-Path $global:FixtureRoot ("build\"+$name)),'fixture icon') }
  }
}
function Global:node {
  Add-Content -LiteralPath (Join-Path $global:FixtureRoot 'var\actions.log') -Value 'seed'
  $global:LASTEXITCODE=0
  if ($global:FixtureScenario -eq 'seed-error') { $global:LASTEXITCODE=6 }
}
function Global:Stop-Process { throw 'Launcher must never terminate processes' }
function Global:Read-Host { throw 'Launcher must not wait for console input' }
& (Join-Path $ProjectRoot 'scripts\launch.ps1')
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding UTF8

function New-Fixture {
  param([string]$Name, [bool]$Built = $false, [bool]$Synced = $false)
  $root = Join-Path $TempRoot ("Black Cat " + $Name)
  foreach ($folder in @('scripts','node_modules\.bin','var','data','prisma','.next','src')) {
    [IO.Directory]::CreateDirectory((Join-Path $root $folder)) | Out-Null
  }
  foreach ($name in @('launch.ps1','launch-guards.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root "scripts\$name")
  }
  Set-Content -LiteralPath (Join-Path $root 'prisma\schema.prisma') -Value '// isolated fixture only'
  Set-Content -LiteralPath (Join-Path $root 'package.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $root 'package-lock.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $root 'data\black-cat.db') -Value 'fixture marker, never opened as SQLite'
  @'
@echo off
echo electron>>"%~dp0..\..\var\actions.log"
if "%BLACKCAT_LAUNCH_TEST_CASE%"=="existing-error" exit /b 9
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $root 'node_modules\.bin\electron.cmd') -Encoding ascii
  @'
@echo off
echo schema>>"%~dp0..\..\var\actions.log"
if "%BLACKCAT_LAUNCH_TEST_CASE%"=="schema-error" exit /b 5
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $root 'node_modules\.bin\prisma.cmd') -Encoding ascii
  if ($Built) {
    [IO.Directory]::CreateDirectory((Join-Path $root 'build')) | Out-Null
    foreach ($name in @('icon.png','tray.png','icon.ico')) { [IO.File]::WriteAllText((Join-Path $root ("build\"+$name)),'fixture icon') }
    $build = Join-Path $root '.next\BUILD_ID'
    Set-Content -LiteralPath $build -Value 'fixture'
    [IO.File]::SetLastWriteTimeUtc($build,[DateTime]::UtcNow.AddMinutes(1))
  }
  if ($Synced) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $root 'prisma\schema.prisma') -Algorithm SHA256).Hash
    Set-Content -LiteralPath (Join-Path $root 'data\.schema-hash') -Value $hash -Encoding ascii
  }
  return $root
}

function Invoke-Fixture {
  param([string]$Root,[string]$Scenario)
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -ProjectRoot $Root -Scenario $Scenario 2>&1
    $code=$LASTEXITCODE
  } finally { $ErrorActionPreference=$old }
  $actions=Join-Path $Root 'var\actions.log'
  $values=if (Test-Path -LiteralPath $actions) { @(Get-Content -LiteralPath $actions) } else { @() }
  return [pscustomobject]@{Code=$code;Actions=($values -join ',');Output=($output -join "`n")}
}

try {
  $root = New-Fixture 'identity'
  $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
  foreach ($argument in @('.',('"'+$root+'"'),('"'+$root.Replace('\','/')+'"'))) {
    $entry=[pscustomobject]@{ExecutablePath=$exe;CommandLine=('"'+$exe+'" '+$argument)}
    Check 'own main process is reused with legacy/absolute/spaced path' ((Get-BlackCatLaunchDecision $root @($entry)).Action -eq 'reuse')
  }
  foreach ($argument in @('--type=renderer',('"'+$root+'\node_modules\next\dist\bin\next" start'))) {
    $entry=[pscustomobject]@{ExecutablePath=$exe;CommandLine=('"'+$exe+'" '+$argument)}
    Check 'renderer/server process is not mistaken for app main' ((Get-BlackCatLaunchDecision $root @($entry)).Action -eq 'blocked')
  }
  $sibling=$root+'-other\node_modules\electron\dist\electron.exe'
  $entry=[pscustomobject]@{ExecutablePath=$sibling;CommandLine=('"'+$sibling+'" .')}
  Check 'similar sibling project is left alone' ((Get-BlackCatLaunchDecision $root @($entry)).Action -eq 'start')

  $cases=@(
    @('existing',$false,$false,0,'electron'),
    @('existing-error',$false,$false,1,'electron'),
    @('occupied',$false,$false,1,''),
    @('worker',$false,$false,1,''),
    @('process-error',$false,$false,1,''),
    @('port-error',$false,$false,1,''),
    @('fresh',$false,$false,0,'build,schema,seed,electron'),
    @('cached',$true,$true,0,'electron'),
    @('build-error',$false,$false,1,'build'),
    @('icons-missing',$false,$false,1,'build'),
    @('schema-error',$true,$false,1,'schema'),
    @('seed-error',$true,$false,1,'schema,seed'),
    @('app-appears',$false,$false,0,'build,electron'),
    @('port-appears',$false,$false,1,'build'),
    @('late-port',$true,$true,1,'')
  )
  foreach ($case in $cases) {
    $root=New-Fixture $case[0] $case[1] $case[2]
    $before=Get-FileHash -LiteralPath (Join-Path $root 'data\black-cat.db')
    $result=Invoke-Fixture $root $case[0]
    Check ("launcher scenario: "+$case[0]) ($result.Code -eq $case[3] -and $result.Actions -eq $case[4]) ($result.Output+" Actions="+$result.Actions)
    Check 'fixture inventory bytes remain unchanged' ((Get-FileHash -LiteralPath (Join-Path $root 'data\black-cat.db')).Hash -eq $before.Hash)
    $handle=Open-BlackCatLaunchLock (Join-Path $root 'var\launch.lock')
    Check 'launcher exit releases preparation lock' ($null -ne $handle)
    if ($null -ne $handle) { $handle.Dispose() }
  }
  $root=New-Fixture 'changed-dependency-lock' $true $true
  [IO.File]::SetLastWriteTimeUtc((Join-Path $root 'package-lock.json'),[DateTime]::UtcNow.AddMinutes(2))
  $result=Invoke-Fixture $root 'fresh'
  Check 'changed dependency lock rebuilds before launching' ($result.Code -eq 0 -and $result.Actions -eq 'build,electron') $result.Output
  $root=New-Fixture 'missing-tray-icon' $true $true
  Remove-Item -LiteralPath (Join-Path $root 'build\tray.png')
  $result=Invoke-Fixture $root 'fresh'
  Check 'missing tray icon rebuilds a cached installation before launching' ($result.Code -eq 0 -and $result.Actions -eq 'build,electron') $result.Output
  $root=New-Fixture 'changed-icon-source' $true $true
  [IO.Directory]::CreateDirectory((Join-Path $root 'assets\desktop')) | Out-Null
  $iconSource=Join-Path $root 'assets\desktop\icon.svg'
  [IO.File]::WriteAllText($iconSource,'fixture vector')
  [IO.File]::SetLastWriteTimeUtc($iconSource,[DateTime]::UtcNow.AddMinutes(2))
  $result=Invoke-Fixture $root 'fresh'
  Check 'changed icon source rebuilds before launching' ($result.Code -eq 0 -and $result.Actions -eq 'build,electron') $result.Output
  $root=New-Fixture 'concurrent' $false $false
  $handle=Open-BlackCatLaunchLock (Join-Path $root 'var\launch.lock')
  try {
    $result=Invoke-Fixture $root 'fresh'
    Check 'another launch cannot prepare the same installation concurrently' ($result.Code -eq 0 -and $result.Actions -eq '' -and $result.Output.Contains('startup is already in progress')) $result.Output
  } finally { $handle.Dispose() }
  $result=Invoke-Fixture $root 'fresh'
  Check 'persistent lock file does not prevent later startup' ($result.Code -eq 0 -and $result.Actions -eq 'build,schema,seed,electron') $result.Output
} finally {
  $resolved=[IO.Path]::GetFullPath($TempRoot)
  if ($resolved.StartsWith($TempPrefix,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolved -PathType Container)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
if ($failures) { Write-Host "LAUNCHER FAILURES: $failures"; exit 1 }
Write-Host 'ALL LAUNCHER CHECKS PASSED'
exit 0
