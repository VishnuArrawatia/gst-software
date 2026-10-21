@echo off
cd /d "%~dp0.."
setlocal
echo START_CSX
where dotnet-script >"%TEMP%\csx-where.txt" 2>&1
set CSX_EXIT=%errorlevel%
type "%TEMP%\csx-where.txt"
if %CSX_EXIT% NEQ 0 (
  echo NO_DOTNET_SCRIPT
  goto :DONE
)
dotnet-script run scripts\_prep-logos-systemdrawing.csx
echo CSX_EXIT=%errorlevel%
:DONE
echo DONE_CSX
