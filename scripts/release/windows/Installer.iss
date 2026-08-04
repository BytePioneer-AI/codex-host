[Setup]
AppId={{8A7B4E80-A650-4D47-9D05-8D4D7F13E67E}
AppName=codexhost
AppVersion={#ProductVersion}
AppPublisher=codexhost
DefaultDirName={localappdata}\Programs\codexhost
DefaultGroupName=codexhost
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=codexhost

#if Architecture == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#endif

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\codexhost"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"

[Dirs]
Name: "{app}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
