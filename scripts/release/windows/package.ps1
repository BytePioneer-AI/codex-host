param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet("x64", "arm64")][string]$Architecture
)

$ErrorActionPreference = "Stop"
$InnoSource = Join-Path $PSScriptRoot "Installer.iss"
$InnoCompilerCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
)
$InnoCompiler = $InnoCompilerCandidates | Where-Object { Test-Path -PathType Leaf $_ } | Select-Object -First 1
if (-not (Test-Path -PathType Leaf $InnoCompiler)) {
  throw "Inno Setup compiler was not found. Install Inno Setup 6 before packaging."
}
$ResolvedPayload = (Resolve-Path $PayloadRoot).Path
$OutputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $OutputPath

Push-Location $PSScriptRoot
try {
  $OutputBaseName = [System.IO.Path]::GetFileNameWithoutExtension($OutputPath)
  & $InnoCompiler $InnoSource `
    "/DPayloadRoot=$ResolvedPayload" `
    "/DOutputDir=$OutputDirectory" `
    "/DOutputBaseFilename=$OutputBaseName" `
    "/DProductVersion=$Version" `
    "/DArchitecture=$Architecture"
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed with status $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -PathType Leaf $OutputPath)) {
  throw "Inno Setup did not create the installer: $OutputPath"
}
