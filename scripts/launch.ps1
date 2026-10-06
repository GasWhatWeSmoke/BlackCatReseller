# Black Cat Agent launcher (production).
# Boots the local Next.js server against the REAL project data, opens the
# Electron app window, and lets Electron own the server lifecycle (quitting the
# app via the tray stops everything). Preserves existing work and
# rebuilds the web bundle only when you've changed source since the last build.

param([switch]$Silent)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

$PORT = 41999

# Launched from the desktop shortcut there is no console to read: every line also
# goes to var\logs\launch.log, and a fatal stop raises a dialog instead of the old
# "Press Enter to close" prompt, which in a hidden window simply hung forever.
$LogDir = Join-Path $proj "var\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "launch.log"

function Say {
  param([string]$Text, [string]$Color = "Gray")
  "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Text |
    Add-Content -Path $LogFile -Encoding utf8
  if (-not $Silent) { Write-Host $Text -ForegroundColor $Color }
}

function Stop-Launch {
  param([string]$Text)
  Say $Text "Red"
  if ($Silent) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "$Text`r`n`r`nDetails: $LogFile", "Black Cat Reseller",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } else {
    Write-Host "See $LogFile for details." -ForegroundColor Red
  }
  exit 1
}

Say "=== Black Cat Agent ===" "Cyan"
Say "Project: $proj"

# 1) Environment: point at the real project DB + media, and make sure the
#    agent-only ELECTRON_RUN_AS_NODE flag can't leak in and break Electron.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:DATABASE_URL       = "file:$proj\data\black-cat.db"
$env:BLACKCAT_DATA_ROOT = "$proj\var"
$env:PORT               = "$PORT"

# Reopening hands off through Electron's single-instance lock, before build/schema
# work. An occupied port or leftover worker is a reason to stop, never to kill it.
. (Join-Path $PSScriptRoot 'launch-guards.ps1')
$electron = Join-Path $proj 'node_modules\.bin\electron.cmd'
function Confirm-LaunchReady {
  $state = Get-BlackCatLaunchState -ProjectRoot $proj
  if ($state.Action -eq 'reuse') {
    Say $state.Message 'Green'
    & $electron $proj
    if ($LASTEXITCODE -ne 0) { Stop-Launch 'Could not open the existing Black Cat instance. Check the log.' }
    exit 0
  }
  if ($state.Action -ne 'start') { Stop-Launch $state.Message }
}

$launchLock = $null
try {
Confirm-LaunchReady
$launchLock = Open-BlackCatLaunchLock (Join-Path $proj 'var\launch.lock')
if ($null -eq $launchLock) {
  Say 'Black Cat startup is already in progress. Wait for that launch to finish.' 'Yellow'
  exit 0
}
Confirm-LaunchReady

# 4) Rebuild the web bundle ONLY if source changed since the last build
#    (otherwise startup is instant). Sources that affect the build:
$buildId = Join-Path $proj ".next\BUILD_ID"
function Test-NativeIcons {
  foreach ($name in @('icon.png','tray.png','icon.ico')) {
    $file = Join-Path $proj ("build\" + $name)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { return $false }
  }
  return $true
}
$needBuild = $true
if ((Test-Path $buildId) -and (Test-NativeIcons)) {
  $builtAtTicks = (Get-Item $buildId).LastWriteTimeUtc.Ticks
  $watch = @("src","prisma\schema.prisma","package.json","package-lock.json","next.config.ts","next.config.mjs",
             "next.config.js","postcss.config.mjs","tailwind.config.ts","assets\desktop","scripts\build-icons.mjs") |
           ForEach-Object { Join-Path $proj $_ } | Where-Object { Test-Path $_ }
  # Walk directories; stat plain files directly. `Get-ChildItem <file> -Recurse` treats
  # the leaf as a PATTERN and rescans the whole project for matches: "package.json"
  # alone hit 1266 copies under node_modules, adding ~23s to EVERY launch and comparing
  # the build against a node_modules timestamp instead of this project's own sources.
  $newestTicks = 0
  foreach ($w in $watch) {
    if (Test-Path $w -PathType Container) {
      foreach ($f in [System.IO.Directory]::EnumerateFiles($w, "*", "AllDirectories")) {
        $t = [System.IO.File]::GetLastWriteTimeUtc($f).Ticks
        if ($t -gt $newestTicks) { $newestTicks = $t }
      }
    } else {
      $t = [System.IO.File]::GetLastWriteTimeUtc($w).Ticks
      if ($t -gt $newestTicks) { $newestTicks = $t }
    }
  }
  if ($newestTicks -le $builtAtTicks) { $needBuild = $false }
}

if ($needBuild) {
  Say "Building web bundle (first run or code changed)..." "Yellow"
  # Native stderr must not trip ErrorActionPreference=Stop; $LASTEXITCODE is the verdict.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & npm.cmd run build:next 2>&1 | Tee-Object -FilePath $LogFile -Append
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($buildExit -ne 0) { Stop-Launch "Building the app failed. Startup stopped; see the log before retrying." }
  if (-not (Test-NativeIcons)) { Stop-Launch "Desktop icons are missing after the build. Startup stopped; rebuild before trying again." }
} else {
  Say "Web bundle up to date - skipping build." "Green"
}

# 4.5) Database: create/sync + seed ONLY when needed — first run, or when schema.prisma
#      actually changed since the last successful sync (hash marker in data/.schema-hash).
#      Skipping the prisma + node startups saves several seconds on every ordinary launch.
#      The existing schema/seed path stays behind process/port checks. Uses LOCAL prisma
#      binary — `npx` adds its own resolution delay every launch.
Confirm-LaunchReady
$dataDir = Join-Path $proj "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }
$dbFile = Join-Path $dataDir "black-cat.db"
$prismaBin = Join-Path $proj "node_modules\.bin\prisma.cmd"
$hashFile = Join-Path $dataDir ".schema-hash"
$schemaHash = (Get-FileHash (Join-Path $proj "prisma\schema.prisma") -Algorithm SHA256).Hash
$prevHash = ""
if (Test-Path $hashFile) { $prevHash = (Get-Content $hashFile -TotalCount 1) }
if (-not (Test-Path $dbFile) -or ($prevHash -ne $schemaHash)) {
  Say "Syncing database schema (first run or schema changed)..." "Yellow"
  & $prismaBin db push --skip-generate
  if ($LASTEXITCODE -ne 0) {
    Stop-Launch "Database schema sync failed. Startup stopped; review the log before retrying."
  }
  # Idempotent seed: enables WAL + inserts the settings row and default vocabulary only
  # when missing. (Rerun manually anytime with: npm run db:init)
  & node scripts/init-db.mjs
  if ($LASTEXITCODE -ne 0) {
    Stop-Launch "Database seed failed. Startup stopped; review the log before retrying."
  }
  Set-Content -Path $hashFile -Value $schemaHash -Encoding ascii
} else {
  Say "Database schema up to date - skipping sync." "Green"
}

# 5) Launch Electron in production mode. Electron spawns `next start` itself and
#    kills it on quit; the env vars above make that server use the real data.
Confirm-LaunchReady
Say "Starting app..." "Green"
& $electron $proj
if ($LASTEXITCODE -ne 0) { Stop-Launch 'Black Cat exited with an error. See the log.' }
} catch {
  Stop-Launch ("Startup stopped: " + $_.Exception.Message)
} finally {
  if ($null -ne $launchLock) { $launchLock.Dispose() }
}
