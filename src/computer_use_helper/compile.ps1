# src/computer_use_helper/compile.ps1
# Compiles ComputerUseHelper.cs into a standalone console executable.
# Invoked on demand by src/computer_tools.js; the output path is content-hashed
# by the caller so a changed helper source always forces a recompile.
#
# Why a script file instead of an inline -Command: the .NET reference assembly
# paths contain spaces, and Add-Type argument quoting through Node -> cmd ->
# PowerShell is fragile.

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'

$candidates = @(
  'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8',
  'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.7.2',
  'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.0'
)

$refRoot = $null
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath (Join-Path $candidate 'UIAutomationClient.dll')) {
    $refRoot = $candidate
    break
  }
}
if (-not $refRoot) {
  throw 'Could not find .NET Framework reference assemblies containing UIAutomationClient.dll (looked for v4.8, v4.7.2, v4.0).'
}

$references = @(
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.Xml.dll',
  'System.Web.Extensions.dll',
  (Join-Path $refRoot 'UIAutomationClient.dll'),
  (Join-Path $refRoot 'UIAutomationTypes.dll'),
  (Join-Path $refRoot 'WindowsBase.dll')
)

$code = Get-Content -Raw -LiteralPath $Source
if (-not $code -or $code.Trim().Length -eq 0) { throw "Helper source is empty: $Source" }

$outDir = Split-Path -Parent $Output
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }

try {
  Add-Type -TypeDefinition $code -Language CSharp -OutputAssembly $Output `
    -OutputType WindowsApplication -ReferencedAssemblies $references
}
catch {
  $message = $_.Exception.Message
  if ($_.Exception.InnerException) { $message += ' :: ' + $_.Exception.InnerException.Message }
  throw "Computer Use helper compilation failed: $message"
}

if (-not (Test-Path -LiteralPath $Output)) { throw 'Add-Type did not produce an assembly.' }
Write-Output ("OK " + $Output)
