{ Exact published software-file removal, only for an explicit original-tool restore.
  Unknown files, user plugins and directories are never recursively removed. }
var
  RestoreFiles: TArrayOfString;
  OwnFiles: TArrayOfString;
  RestoreRequested: Boolean;

function RecoveryFileAttributes(Name: String): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function SoftwarePath(Line: String): String;
var
  I, P: Integer;
  Part, Name: String;
begin
  if (Length(Line) < 68) or (Line[65] <> ' ') then RaiseException('Invalid software file record');
  for I := 1 to 64 do
    if Pos(Line[I], '0123456789abcdef') = 0 then RaiseException('Invalid software digest');
  Name := Copy(Line, 66, Length(Line));
  P := Pos(' ', Name);
  if P < 2 then RaiseException('Invalid software file size');
  for I := 1 to P - 1 do
    if Pos(Name[I], '0123456789') = 0 then RaiseException('Invalid software file size');
  Name := Copy(Name, P + 1, Length(Name));
  if (Length(Name) = 0) or (Length(Name) > 240) or
    ((Pos('app/', Name) <> 1) and (Pos('bin/', Name) <> 1) and
     (Pos('runtime/', Name) <> 1) and (Pos('libexec/', Name) <> 1) and
     (Pos('licenses/', Name) <> 1) and (Name <> 'THIRD_PARTY_NOTICES.txt')) then
    RaiseException('Software file outside distribution scope');
  Part := '';
  for I := 1 to Length(Name) do begin
    if Pos(Name[I], 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@./-') = 0 then
      RaiseException('Invalid software path');
    if Name[I] = '/' then begin
      if (Part = '') or (Part = '.') or (Part = '..') or (Part[Length(Part)] = '.') then RaiseException('Ambiguous software path');
      Part := '';
    end else Part := Part + Name[I];
  end;
  if (Part = '') or (Part = '.') or (Part = '..') or (Part[Length(Part)] = '.') then RaiseException('Ambiguous software path');
  Result := Name;
end;

procedure CheckFileList(Lines: TArrayOfString);
var I, J: Integer; Name: String;
begin
  if (GetArrayLength(Lines) < 8) or (GetArrayLength(Lines) > 2051) then RaiseException('Invalid software manifest size');
  if (Lines[0] <> 'codexhost-inno-files-v1') or (Lines[1] = '') or (Lines[2] <> 'windows-{#Architecture}') then
    RaiseException('Unsupported original-installer recovery capability');
  for I := 3 to GetArrayLength(Lines) - 1 do begin
    Name := SoftwarePath(Lines[I]);
    for J := 3 to I - 1 do
      if CompareText(Name, SoftwarePath(Lines[J])) = 0 then RaiseException('Duplicate software path');
  end;
end;

function RestorePath(Name: String): String;
var Current: String; Attr: LongWord;
begin
  Current := RemoveBackslashUnlessRoot(ExpandConstant('{app}'));
  Attr := RecoveryFileAttributes(Current);
  if (Attr = $FFFFFFFF) or ((Attr and $400) <> 0) then RaiseException('Restore root is missing or redirected');
  { Inspect every existing ancestor; never follow a reparse point for deletion. }
  StringChangeEx(Name, '/', '\', True);
  Current := AddBackslash(ExpandConstant('{app}')) + Name;
  Result := Current;
  repeat
    Attr := RecoveryFileAttributes(Current);
    if (Attr <> $FFFFFFFF) and ((Attr and $400) <> 0) then RaiseException('Restore path contains a reparse point');
    Current := ExtractFileDir(Current);
  until CompareText(Current, RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0;
  if DirExists(Result) then RaiseException('Software file became a directory');
end;

procedure PrepareFileRecovery;
var FileName: String; I: Integer;
begin
  FileName := ExpandConstant('{param:CODEXHOSTREPLACEFILES|}');
  RestoreRequested := FileName <> '';
  if not RestoreRequested then exit;
  if not LoadStringsFromFile(FileName, RestoreFiles) then RaiseException('Cannot read replacement software manifest');
  ExtractTemporaryFile('codexhost-own-files.txt');
  if not LoadStringsFromFile(ExpandConstant('{tmp}\codexhost-own-files.txt'), OwnFiles) then RaiseException('Cannot read original software manifest');
  CheckFileList(RestoreFiles);
  CheckFileList(OwnFiles);
  for I := 3 to GetArrayLength(RestoreFiles) - 1 do RestorePath(SoftwarePath(RestoreFiles[I]));
end;

procedure ApplyFileReplacement;
var I, J: Integer; Name, FullName: String; Kept: Boolean;
begin
  if not RestoreRequested then exit;
  for I := 3 to GetArrayLength(RestoreFiles) - 1 do begin
    Name := SoftwarePath(RestoreFiles[I]);
    Kept := False;
    for J := 3 to GetArrayLength(OwnFiles) - 1 do
      if CompareText(Name, SoftwarePath(OwnFiles[J])) = 0 then Kept := True;
    if not Kept then begin
      FullName := RestorePath(Name);
      if FileExists(FullName) and not DeleteFile(FullName) then RaiseException('Cannot remove replaced software file: ' + Name);
    end;
  end;
end;
