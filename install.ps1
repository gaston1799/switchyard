<#
.SYNOPSIS
  Installs Switchyard (commands: switchyard, d, dsw, dsd, dswait) globally.

.DESCRIPTION
  Checks for Git and Node.js >= 20, installs missing deps via winget,
  refreshes PATH, then clones the repo (or reuses the current directory)
  and runs npm install -g.

.PARAMETER RepoUrl
  Git clone URL. Defaults to the Switchyard source repository.

.PARAMETER Branch
  Branch to clone. Default: master.

.PARAMETER InstallDir
  Where to clone if not running from inside the repo.
  Default: %LOCALAPPDATA%\deepseek-detached-agent

.EXAMPLE
  # Run from outside the repo (downloads and installs):
  irm https://raw.githubusercontent.com/gaston1799/switchyard/master/install.ps1 | iex

  # Run from inside the repo (installs current working tree):
  .\install.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoUrl    = "https://github.com/gaston1799/switchyard",
  [string]$Branch     = "master",
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "deepseek-detached-agent")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── colours ──────────────────────────────────────────────────────────────────

function Write-Banner {
  Write-Host ""
  Write-Host "  Switchyard installer" -ForegroundColor Cyan
  Write-Host "  $(('─' * 36))" -ForegroundColor DarkGray
  Write-Host ""
}

function Write-Step { param([string]$msg) Write-Host "  ▸ $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail {
  param([string]$msg)
  Write-Host "  ✕ $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

# ── helpers ───────────────────────────────────────────────────────────────────

function Test-Command {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Npm {
  param([string[]]$NpmArgs)
  $npmScript = Get-Command npm.ps1 -ErrorAction SilentlyContinue
  if ($npmScript) {
    try {
      & $npmScript.Source @NpmArgs
      return
    } catch [System.Management.Automation.PSSecurityException] {
      Write-Warn "PowerShell blocked npm.ps1; retrying with npm.cmd..."
    }
  }
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) {
    Write-Fail "npm.cmd was not found. Repair your Node.js installation and re-run."
  }
  & $npmCmd.Source @NpmArgs
}

function Invoke-Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
  $user    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
  $env:PATH = "$machine;$user"
}

function Get-NodeMajor {
  try {
    $ver = & node --version 2>$null
    if ($ver -match '^v(\d+)') { return [int]$Matches[1] }
  } catch {}
  return 0
}

function Invoke-Winget-Install {
  param([string]$Id, [string]$Label)
  Write-Step "Installing $Label via winget..."
  $result = winget install `
    --id    $Id `
    --silent `
    --accept-package-agreements `
    --accept-source-agreements `
    2>&1
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335212) {
    # -1978335212 = APPINSTALLER_ERROR_ALREADY_INSTALLED (treat as success)
    Write-Warn "winget exited $LASTEXITCODE — check output above."
  }
  Invoke-Refresh-Path
}

# ── main ─────────────────────────────────────────────────────────────────────

Write-Banner

# winget availability
Write-Step "Checking winget..."
if (-not (Test-Command "winget")) {
  Write-Warn "winget not found."
  Write-Warn "Install 'App Installer' from the Microsoft Store and re-run."
  Write-Fail "winget is required to auto-install dependencies."
}
Write-Ok "winget found."

# ── Node.js ──────────────────────────────────────────────────────────────────

Write-Step "Checking Node.js >= 20 (required for standalone exe build)..."
$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 20) {
  Write-Ok "Node.js v$nodeMajor found — $(& node --version)."
} else {
  if ($nodeMajor -gt 0) {
    Write-Warn "Node.js v$nodeMajor is too old (need >= 20). Upgrading..."
  }
  Invoke-Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS"
  $nodeMajor = Get-NodeMajor
  if ($nodeMajor -lt 20) {
    Write-Fail "Node.js install failed. Install manually from https://nodejs.org then re-run."
  }
  Write-Ok "Node.js $(& node --version) installed."
}

# ── Git ───────────────────────────────────────────────────────────────────────

Write-Step "Checking Git..."
if (Test-Command "git") {
  Write-Ok "Git found — $(& git --version)."
} else {
  Invoke-Winget-Install "Git.Git" "Git"
  Invoke-Refresh-Path   # git may update PATH differently from node
  if (-not (Test-Command "git")) {
    Write-Fail "Git install failed. Install manually from https://git-scm.com then re-run."
  }
  Write-Ok "Git installed — $(& git --version)."
}

# ── source directory ──────────────────────────────────────────────────────────

$repoDir = $null

if (Test-Path (Join-Path (Get-Location) ".git")) {
  Write-Ok "Running from inside the repo — using current directory."
  $repoDir = (Get-Location).Path
} elseif (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Step "Updating existing clone at $InstallDir..."
  Set-Location $InstallDir
  & git pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Fail "git pull failed." }
  $repoDir = $InstallDir
} else {
  Write-Step "Cloning $RepoUrl ($Branch) to $InstallDir..."
  & git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed." }
  $repoDir = $InstallDir
  Write-Ok "Cloned."
}

Set-Location $repoDir

# ── install dev dependencies (Electron, esbuild, postject) ────────────────────

Write-Step "Installing build dependencies..."
Invoke-Npm -NpmArgs @("install")
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed." }

# ── build standalone CLI exes and the Electron desktop app ────────────────────

Write-Step "Building CLI executables and the Electron desktop app..."
& node build-exe.js
if ($LASTEXITCODE -ne 0) { Write-Fail "application build failed." }

# ── install exes to Programs dir and add to PATH ──────────────────────────────

$ExeDir = Join-Path $env:LOCALAPPDATA "Programs\dsw"
Write-Step "Copying executables to $ExeDir..."
New-Item -ItemType Directory -Force -Path $ExeDir | Out-Null

$aliases = @("switchyard-cli", "dsw", "d", "dsd", "dswait")
foreach ($alias in $aliases) {
  $src  = Join-Path $repoDir "dist\exe\$alias.exe"
  $dest = Join-Path $ExeDir  "$alias.exe"
  if (Test-Path $src) {
    Copy-Item $src $dest -Force
    Write-Ok "$alias.exe"
  } else {
    Write-Warn "$alias.exe not found in dist\exe — skipping."
  }
}
$CliSource = Join-Path $repoDir "dist\exe\switchyard.exe"
if (Test-Path $CliSource) {
  $LegacyCliPath = Join-Path $ExeDir "switchyard.exe"
  if (Test-Path $LegacyCliPath) {
    Remove-Item -LiteralPath $LegacyCliPath -Force
    Write-Ok "Retired the previous console switchyard.exe entry"
  }
} else {
  Write-Warn "CLI executable missing from dist\exe."
}

$BundledSkills = Join-Path $repoDir "dist\exe\skills"
if (Test-Path $BundledSkills) {
  Copy-Item $BundledSkills (Join-Path $ExeDir "skills") -Recurse -Force
  Write-Ok "Bundled skills"
} else {
  Write-Warn "Bundled skills directory not found in dist\exe."
}

# Terminal entry point; `switchyard app` explicitly opens Electron.
$CliLauncher = '@echo off' + "`r`n" + '@"%~dp0d.exe" %*' + "`r`n"
Set-Content -LiteralPath (Join-Path $ExeDir "switchyard.cmd") -Value $CliLauncher -Encoding Ascii

# Install the Electron runtime and app as a real Windows desktop application.
$DesktopSource = Join-Path $repoDir "dist\desktop"
$DesktopDir = Join-Path $env:LOCALAPPDATA "Programs\Switchyard"
$DesktopExe = Join-Path $DesktopDir "Switchyard.exe"
$IconSrc = Join-Path $repoDir "icon.ico"
if ((Test-Path (Join-Path $DesktopSource "Switchyard.exe")) -and (Test-Path $IconSrc)) {
  New-Item -ItemType Directory -Force -Path $DesktopDir | Out-Null
  Copy-Item (Join-Path $DesktopSource "*") $DesktopDir -Recurse -Force
  $StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
  $ShortcutPath = Join-Path $StartMenu "Switchyard.lnk"
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = $DesktopExe
  $Shortcut.WorkingDirectory = $repoDir
  $Shortcut.IconLocation = "$(Join-Path $DesktopDir 'icon.ico'),0"
  $Shortcut.Description = "Switchyard Desktop AI workspace"
  $Shortcut.Save()
  Write-Ok "Electron desktop app and Start Menu shortcut with Switchyard icon"
} else {
  Write-Warn "Electron desktop app or icon missing; skipping Start Menu shortcut."
}

# Retire npm's old generic command shim so Windows Search resolves Switchyard
# to the branded Start Menu app. The dedicated CLI launcher lives in Programs/dsw.
$NpmShimDir = Join-Path $env:APPDATA "npm"
foreach ($extension in @(".cmd", ".ps1", "")) {
  $LegacyShim = Join-Path $NpmShimDir "switchyard$extension"
  if (Test-Path $LegacyShim) {
    $shimText = Get-Content -LiteralPath $LegacyShim -Raw -ErrorAction SilentlyContinue
    if ($shimText -match "deepseek-detached-agent[\\/]src[\\/]deepseek-watch\.js") {
      Remove-Item -LiteralPath $LegacyShim -Force
      Write-Ok "Removed old npm switchyard shell shim ($extension)"
    }
  }
}

# Add ExeDir to the user PATH (persistent, via registry)
Write-Step "Updating user PATH..."
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$pathEntries = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $ExeDir -and $_ -ne $DesktopDir })
$newPath = (@($ExeDir, $DesktopDir) + $pathEntries -join ';')
[System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
$currentEntries = @($env:PATH -split ';' | Where-Object { $_ -and $_ -ne $ExeDir -and $_ -ne $DesktopDir })
$env:PATH = (@($ExeDir, $DesktopDir) + $currentEntries -join ';')
Write-Ok "Updated user PATH with CLI launcher before the desktop directory."


Write-Host ""
if ((Test-Path $DesktopExe) -and (Test-Command "switchyard")) {
  Write-Ok "Switchyard Desktop is installed and available from Start or switchyard app."
  Write-Ok "Terminal harness commands: switchyard  switchyard-cli  d  dsw  dsd  dswait"
} else {
  Write-Warn "Switchyard Desktop install incomplete; open a new terminal after installation."
}

Write-Host ""
Write-Host "  Open desktop app:  switchyard app" -ForegroundColor DarkGray
Write-Host "  Terminal CLI:      switchyard --help" -ForegroundColor DarkGray
Write-Host ""
