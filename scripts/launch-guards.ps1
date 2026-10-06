# Read-only launch decisions. Process discovery never grants permission to kill.
function Split-BlackCatCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return @() }
  if (-not ("BlackCat.LaunchCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace BlackCat {
  public static class LaunchCommandLine {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Split(string command) {
      int count; var memory = CommandLineToArgvW(command, out count);
      if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
      try {
        var result = new string[count];
        for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i*IntPtr.Size));
        return result;
      } finally { LocalFree(memory); }
    }
  }
}
'@
  }
  return [BlackCat.LaunchCommandLine]::Split($CommandLine)
}

function Get-BlackCatLaunchDecision {
  param([string]$ProjectRoot, [object[]]$Processes = @(), [object[]]$Listeners = @())
  $rootPath = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\','/')
  $prefix = $rootPath + '\'
  $executable = Join-Path $rootPath 'node_modules\electron\dist\electron.exe'
  foreach ($entry in $Processes) {
    if ($entry.ExecutablePath -and $entry.ExecutablePath.Replace('/','\') -ieq $executable) {
      $tokens = @(Split-BlackCatCommandLine $entry.CommandLine)
      if ($tokens.Count -ge 2) {
        $application = $tokens[1].Replace('/','\').TrimEnd('\')
        # Older shortcuts pass '.'; new launches pass the absolute project path.
        if ($application -eq '.' -or $application -ieq $rootPath -or $application -ieq (Join-Path $rootPath 'electron\main.js')) {
          return [pscustomobject]@{ Action='reuse'; Message='Opening the existing Black Cat instance.' }
        }
      }
    }
  }
  if ($Listeners.Count -gt 0) {
    return [pscustomobject]@{ Action='blocked'; Message='Port 41999 is already in use. Close the previous Black Cat session normally, or resolve the other application using this port. No process was stopped.' }
  }
  foreach ($entry in $Processes) {
    $fromProject = $entry.ExecutablePath -and $entry.ExecutablePath.Replace('/','\').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    $usesProject = $entry.CommandLine -and $entry.CommandLine.Replace('/','\').IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($fromProject -or $usesProject) {
      return [pscustomobject]@{ Action='blocked'; Message='A Black Cat background process is still running. Wait for the previous session to finish closing before starting again. No process was stopped.' }
    }
  }
  return [pscustomobject]@{ Action='start'; Message='No active instance or occupied application port.' }
}

function Get-BlackCatLaunchState {
  param([string]$ProjectRoot)
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe' OR Name='llama-server.exe'" -ErrorAction Stop)
  $decision = Get-BlackCatLaunchDecision -ProjectRoot $ProjectRoot -Processes $processes
  if ($decision.Action -eq 'reuse') { return $decision }
  # Enumerating all listeners distinguishes no match from a failed inspection.
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 41999 })
  return Get-BlackCatLaunchDecision -ProjectRoot $ProjectRoot -Processes $processes -Listeners $listeners
}

function Open-BlackCatLaunchLock {
  param([string]$Path)
  try {
    return [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    if (($_.Exception.HResult -band 0xffff) -in @(32,33)) { return $null }
    throw
  }
}
