# Creates (or repairs) the Black Cat Reseller desktop shortcut.
#
# The shortcut is the only launch surface most days, and until now nothing in the
# repo defined it - it was hand-made, pointed at the console .cmd, and when the
# project folder was renamed nothing noticed. Run this to put it back:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $proj "scripts\launch-silent.vbs"
$icon = Join-Path $proj "build\icon.ico"

if (-not (Test-Path $vbs)) { throw "Missing launcher: $vbs" }

$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Black Cat Reseller.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
# wscript runs the launcher with NO console window; the .cmd is the console version.
$s.TargetPath       = Join-Path $env:WINDIR "System32\wscript.exe"
$s.Arguments        = '"' + $vbs + '"'
$s.WorkingDirectory = $proj
$s.Description      = "Black Cat Reseller"
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()

Write-Host "Shortcut written: $lnk" -ForegroundColor Green
Write-Host "  -> $($s.TargetPath) $($s.Arguments)"
