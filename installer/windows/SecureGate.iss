; Secure Gate Windows installer (Inno Setup).
; Compile on a Windows machine with Inno Setup 6:
;   ISCC.exe installer\windows\SecureGate.iss
;
; The compiled Setup.exe copies the app, writes a Start Menu shortcut for the
; desktop shell, and a "Start Secure Gate server" shortcut that runs install.ps1.

#define MyAppName "Secure Gate"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Quest Mall"

[Setup]
AppId={{8C3E2A11-7B64-4F19-9D2C-SECUREGATE01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\SecureGate
DefaultGroupName=Secure Gate
OutputDir=..\..\desktop\dist
OutputBaseFilename=SecureGate-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64

[Files]
Source: "..\..\desktop\dist\SecureGate-Portable.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "install.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "Start-Server.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Secure Gate"; Filename: "{app}\SecureGate-Portable.exe"
Name: "{group}\Start Secure Gate server"; Filename: "{app}\Start-Server.bat"
Name: "{autodesktop}\Secure Gate"; Filename: "{app}\SecureGate-Portable.exe"

[Run]
Filename: "{app}\Start-Server.bat"; Description: "Start the on-premise server now"; Flags: postinstall shellexec skipifsilent
Filename: "{app}\SecureGate-Portable.exe"; Description: "Open Secure Gate"; Flags: postinstall nowait skipifsilent
