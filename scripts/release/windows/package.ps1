param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet("x64", "arm64")][string]$Architecture
)

$ErrorActionPreference = "Stop"
$WixSource = Join-Path $PSScriptRoot "Product.wxs"
$ExpectedWixVersion = "4.0.6"
$ResolvedPayload = (Resolve-Path $PayloadRoot).Path
$OutputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $OutputPath

Push-Location $PSScriptRoot
try {
  & dotnet tool restore
  if ($LASTEXITCODE -ne 0) { throw "dotnet tool restore failed with status $LASTEXITCODE" }

  $ActualWixVersion = (& dotnet tool run wix --version).Trim()
  if ($LASTEXITCODE -ne 0) { throw "wix --version failed with status $LASTEXITCODE" }
  if (-not $ActualWixVersion.StartsWith($ExpectedWixVersion)) {
    throw "WiX version mismatch: expected $ExpectedWixVersion, got $ActualWixVersion"
  }

  & dotnet tool run wix build $WixSource `
    -arch $Architecture `
    -d "PayloadRoot=$ResolvedPayload" `
    -d "ProductVersion=$Version" `
    -o $OutputPath
  if ($LASTEXITCODE -ne 0) { throw "wix build failed with status $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -PathType Leaf $OutputPath)) {
  throw "WiX did not create the MSI: $OutputPath"
}
