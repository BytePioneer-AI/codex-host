# Disposable application fixture; never registers or launches Codex Desktop.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:CODEXHOST_DISPOSABLE_WINDOWS_USER -ne 'fixture-only') { throw 'Requires explicit disposable-profile authorization' }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This acceptance fixture is Windows x64 only; ARM64 remains unverified' }
if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP must identify this isolated fixture scratch directory' }
function Build-Binary([string[]]$CargoArguments, [string]$Name) {
  $lines = & cargo @CargoArguments
  if ($LASTEXITCODE) { throw 'Native fixture build failed' }
  $artifacts = @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq $Name -and $_.executable })
  if ($artifacts.Count -ne 1) { throw "No unique native executable: $Name" }
  return $artifacts[0].executable
}
$root = Join-Path $env:RUNNER_TEMP ('codexhost-appx-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Existing Visual C++ x64 tools are required; this fixture does not install them' }
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
$variables = & cmd.exe /d /s /c "`"$vcvars`" >nul && set"
if ($LASTEXITCODE) { throw 'Cannot initialize existing native tools' }
foreach ($line in $variables) {
  if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process') }
}
$source = Join-Path $PWD 'crates/platform/tests/fixtures/activation-probe.c'
& cl.exe /nologo /LD /W4 /WX /O2 $source "/Fo$root/probe.obj" /link "/OUT:$root/CodexHostActivationProbe.dll" "/IMPLIB:$root/CodexHostActivationProbe.lib"
if ($LASTEXITCODE) { throw 'Imported-DLL pre-entry probe build failed' }
$fixture = Build-Binary -CargoArguments @('rustc','-p','codexhost-platform','--features','activation-fixture','--bin','codexhost-activation-fixture','--locked','--message-format=json','--',("-Lnative="+$root),'-Clink-arg=/INCLUDE:CODEXHOST_TLS_GUARD','-Clink-arg=/INCLUDE:_tls_used') -Name 'codexhost-activation-fixture'
$launcher = Build-Binary -CargoArguments @('build','-p','codexhost-launcher','--bin','codexhost','--locked','--message-format=json') -Name 'codexhost'
Copy-Item $fixture (Join-Path $root 'Codex.exe')
Add-Type -AssemblyName System.Drawing
foreach ($size in @(44,150)) {
  $image = New-Object System.Drawing.Bitmap($size,$size)
  $image.Save((Join-Path $root "logo$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
}
$name = 'CodexHost.Fixture.' + [guid]::NewGuid().ToString('N')
@"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap desktop4 uap10 rescap">
 <Identity Name="$name" Publisher="CN=CodexHostFixture" Version="1.0.0.0" ProcessorArchitecture="x64"/>
 <Properties><DisplayName>Disposable activation fixture</DisplayName><PublisherDisplayName>Fixture</PublisherDisplayName><Logo>logo44.png</Logo></Properties>
 <Resources><Resource Language="en-us"/></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Applications><Application Id="Fixture" Executable="Codex.exe" EntryPoint="Windows.FullTrustApplication" desktop4:SupportsMultipleInstances="true" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL"><uap:VisualElements DisplayName="Fixture" Description="Native activation isolation fixture" Square150x150Logo="logo150.png" Square44x44Logo="logo44.png" BackgroundColor="transparent" AppListEntry="none"/></Application></Applications>
 <Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
"@ | Set-Content -Encoding utf8 (Join-Path $root 'AppxManifest.xml')
$package = $null
try {
  # Loose development registration avoids a machine-wide certificate import.
  # Developer-mode/sideload permission is an environment prerequisite, not set here.
  Add-AppxPackage -Register (Join-Path $root 'AppxManifest.xml')
  $package = Get-AppxPackage -Name $name
  if (-not $package) { throw 'Fixture package registration unavailable in this user/session' }
  $descriptor = Join-Path $root 'fixture.json'
  @{ packageFullName=$package.PackageFullName; appUserModelId=($package.PackageFamilyName+'!Fixture'); executable=(Join-Path $root 'Codex.exe') } | ConvertTo-Json | Set-Content -Encoding utf8 $descriptor
  # Rust serde expects UTF-8 without a Windows PowerShell BOM.
  $content = Get-Content -Raw $descriptor
  [IO.File]::WriteAllText($descriptor,$content,(New-Object Text.UTF8Encoding($false)))
  $env:CODEXHOST_APPX_FIXTURE = $descriptor
  $env:CODEXHOST_APPX_TEST_DEBUGGER = $launcher
  & cargo test -p codexhost-platform --locked actual_msix_resume_binding_precedes_application_entry -- --ignored --nocapture
  if ($LASTEXITCODE) { throw 'Actual AppX resume binding fixture failed; do not enable automatic updates' }
} finally {
  if (-not $package) { $package = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue }
  if ($package) { Remove-AppxPackage -Package $package.PackageFullName }
  Remove-Item Env:CODEXHOST_APPX_FIXTURE -ErrorAction SilentlyContinue
  Remove-Item Env:CODEXHOST_APPX_TEST_DEBUGGER -ErrorAction SilentlyContinue
  Write-Output "Fixture evidence retained: $root"
}
