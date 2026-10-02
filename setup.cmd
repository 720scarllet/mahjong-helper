@echo off
setlocal
set "PROJECT_ROOT=%~dp0"
set "SETUP_CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%SETUP_CSC%" set "SETUP_CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%PROJECT_ROOT%tools" mkdir "%PROJECT_ROOT%tools"
"%SETUP_CSC%" /nologo /codepage:65001 /target:winexe /out:"%PROJECT_ROOT%tools\Setup.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "%PROJECT_ROOT%scripts\Setup.cs"
if errorlevel 1 (
  echo Setup launcher failed to compile.
  pause
  exit /b 1
)
start "" "%PROJECT_ROOT%tools\Setup.exe" "%PROJECT_ROOT%."
