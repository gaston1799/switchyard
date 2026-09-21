<#
.SYNOPSIS
  Toggle dsw "dev mode": run the live source (npm-linked shim) instead of the
  compiled standalone exe.

.DESCRIPTION
  dsw is installed two ways that both land on the user PATH:
    - source shim : %APPDATA%\npm\dsw(.cmd)         -> runs src\deepseek-watch.js
    - compiled exe: %LOCALAPPDATA%\Programs\dsw\*.exe (a bundled snapshot)

  Whichever directory comes first on PATH wins. Dev mode puts the npm (source)
  directory ahead of the exe directory so every edit under src\ takes effect
  immediately — no rebuild. -Disable restores exe-first.

  Only the USER PATH is modified (both dirs live there). Open a NEW terminal
  after running this for the change to take effect.

.PARAMETER Disable
  Restore exe-first ordering (compiled binaries win again).

.EXAMPLE
  pwsh scripts\dev-mode.ps1            # enable dev mode (source wins)
  pwsh scripts\dev-mode.ps1 -Disable   # back to the compiled exe
#>
[CmdletBinding()]
param([switch]$Disable)

$ErrorActionPreference = "Stop"

$npmDir  = (Join-Path $env:APPDATA "npm").TrimEnd('\')
$progDir = (Join-Path $env:LOCALAPPDATA "Programs\dsw").TrimEnd('\')
$repoDir = Split-Path -Parent $PSScriptRoot

function Norm([string]$p) { return $p.TrimEnd('\').ToLowerInvariant() }

# Ensure the npm-linked source shim actually exists; create it if missing.
$shim = Join-Path $npmDir "dsw.cmd"
if (-not (Test-Path $shim)) {
  Write-Host "[dev-mode] npm source shim missing — running 'npm link' in $repoDir"
  Push-Location $repoDir
  try { & npm link | Out-Null } finally { Pop-Location }
}

$user  = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($user -split ';' | Where-Object { $_ -ne '' })

# Drop any existing occurrences of the two dsw dirs, preserving everything else.
$rest = $parts | Where-Object { (Norm $_) -ne (Norm $npmDir) -and (Norm $_) -ne (Norm $progDir) }

if ($Disable) {
  $ordered = @($progDir, $npmDir) + $rest    # exe first
  $mode = "compiled exe"
} else {
  $ordered = @($npmDir, $progDir) + $rest    # source shim first
  $mode = "live source"
}

$newPath = ($ordered -join ';')
[Environment]::SetEnvironmentVariable("Path", $newPath, "User")

Write-Host ""
Write-Host "[dev-mode] dsw will now resolve to: $mode" -ForegroundColor Green
Write-Host "           source shim : $npmDir"
Write-Host "           compiled exe: $progDir"
Write-Host ""
Write-Host "Open a NEW terminal, then verify with:  where.exe dsw" -ForegroundColor DarkGray
Write-Host "(first line should be the winning path)" -ForegroundColor DarkGray
