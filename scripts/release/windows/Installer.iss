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
SetupIconFile=..\..\..\crates\launcher\assets\codexhost.ico
UninstallDisplayIcon={app}\bin\codexhost-start.exe

#if Architecture == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#endif

[Files]
; Extract the new helper before touching an existing installation, including older versions.
Source: "{#PayloadRoot}\libexec\codexhost-updater.exe"; DestName: "codexhost-install-helper.exe"; Flags: dontcopy
Source: "{#PayloadRoot}\app\codexhost-inno-files-v1.txt"; DestName: "codexhost-own-files.txt"; Flags: dontcopy
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userdesktop}\codexhost"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"
Name: "{userprograms}\codexhost"; Filename: "{app}\bin\codexhost-start.exe"; WorkingDir: "{app}"
Name: "{userprograms}\codexhost console"; Filename: "{app}\bin\codexhost-start.exe"; Parameters: "--console"; WorkingDir: "{app}"

[Dirs]
Name: "{app}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
#include "recovery.iss"
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  try
    PrepareFileRecovery;
    ExtractTemporaryFile('codexhost-install-helper.exe');
    { PrepareToInstall runs after Install is clicked, before the file-in-use check.
      Append a dot so even a drive-root destination has no trailing argument backslash. }
    if not ExecAndLogOutput(
      ExpandConstant('{tmp}\codexhost-install-helper.exe'),
      'prepare-install --install-root ' + AddQuotes(AddBackslash(ExpandConstant('{app}')) + '.'),
      ExpandConstant('{tmp}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode, nil) then
      Result := 'Could not start codexhost installation preparation: ' + SysErrorMessage(ResultCode)
    else if ResultCode <> 0 then begin
      Log(Format('codexhost installation preparation failed with exit code %d', [ResultCode]));
      Result := 'Could not close the running codexhost installation. Close codexhost and try again.';
    end;
    if Result = '' then ApplyFileReplacement;
  except
    Result := 'Could not prepare codexhost installation: ' + GetExceptionMessage;
  end;
end;
