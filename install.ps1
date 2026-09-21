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

# ── install dev dependencies (esbuild, postject) ──────────────────────────────

Write-Step "Installing build dependencies..."
& npm install
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed." }

# ── build standalone exes ─────────────────────────────────────────────────────

Write-Step "Building standalone executables (esbuild + Node SEA)..."
& node build-exe.js
if ($LASTEXITCODE -ne 0) { Write-Fail "exe build failed." }

# ── install exes to Programs dir and add to PATH ──────────────────────────────

$ExeDir = Join-Path $env:LOCALAPPDATA "Programs\dsw"
Write-Step "Copying executables to $ExeDir..."
New-Item -ItemType Directory -Force -Path $ExeDir | Out-Null

$aliases = @("switchyard", "dsw", "d", "dsd", "dswait")
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

# Add ExeDir to the user PATH (persistent, via registry)
Write-Step "Updating user PATH..."
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$ExeDir*") {
  $newPath = if ($userPath) { "$userPath;$ExeDir" } else { $ExeDir }
  [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  $env:PATH = "$env:PATH;$ExeDir"
  Write-Ok "Added $ExeDir to user PATH."
} else {
  Write-Ok "$ExeDir already on PATH."
  $env:PATH = "$env:PATH;$ExeDir"   # refresh current session anyway
}

# ── verify ────────────────────────────────────────────────────────────────────

Write-Host ""
if (Test-Command "switchyard") {
  Write-Ok "switchyard.exe is on PATH and working."
  Write-Ok "Also available: d  dsw  dsd  dswait"
} else {
  Write-Warn "switchyard not found yet — open a new terminal window and try: switchyard --help"
}

Write-Host ""
Write-Host "  Set your API key:  switchyard config set-key <your-deepseek-key>" -ForegroundColor DarkGray
Write-Host ""
