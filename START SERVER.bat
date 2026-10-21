@echo off
REM ==========================================================================
REM  GST CONTROL ERP - double-click this file to start the server.
REM
REM  It works on any network: home, office or hotspot. The IP changes with
REM  the network, so the launcher finds the current one and prints every
REM  address that can be used from another computer.
REM ==========================================================================

title GST CONTROL ERP - Server
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     GST CONTROL ERP  -  SVN ^& SAKAR
echo   ==========================================================
echo.

REM ---- Is the server already running? -------------------------------------
netstat -ano | findstr "0.0.0.0:4310" | findstr LISTENING >nul
if %errorlevel%==0 (
  echo   Server pehle se chal raha hai. Sirf link khol rahe hain.
  echo.
  goto :openlink
)

REM ---- Start the server in this window -------------------------------------
echo   Server shuru ho raha hai... isme 10-15 second lagenge.
echo   Ye window BAND MAT KARIYEGA - band karoge to server ruk jayega.
echo.
echo   ------------------------------------------------------------
echo     band karne ke liye:  Ctrl+C  (phir Y se confirm karein)
echo   ------------------------------------------------------------
echo.

start "GST ERP Server" /min "%~dp0scripts\run-server.cmd"

REM ---- Wait until the port answers -----------------------------------------
set /a tries=0
:waitloop
set /a tries+=1
timeout /t 2 /nobreak >nul
netstat -ano | findstr "0.0.0.0:4310" | findstr LISTENING >nul
if not %errorlevel%==0 (
  if %tries% lss 45 goto :waitloop
  echo.
  echo   ! Server start nahi hua. Log dekhein:  output\server.log
  echo.
  pause
  exit /b 1
)

:openlink
REM ---- Work out the addresses that work from another computer --------------
REM  Do NOT put a space between the caret and the pipe on the line below. A
REM  caret followed by a space escapes the SPACE only, which leaves the pipe
REM  live, and cmd then aborts the whole launcher with "unexpected at this
REM  time" - after the server has already started, so a working start looked
REM  exactly like a failed one.
REM
REM  IP1 is the address OTHER computers use. Loopback is not one of them, and
REM  it is the last address netsh prints, so without the guard below IP1 ended
REM  up as 127.0.0.1 and the launcher advertised a link that can never work.
set "IP1="
for /f "tokens=2 delims=:" %%a in ('netsh interface ipv4 show address ^| findstr /c:"IP Address"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do (
    if not "%%b"=="1.0.0.0" if not "%%b"=="127.0.0.1" set "IP1=%%b"
  )
)

echo.
echo   ==========================================================
echo     SERVER CHALU HAI - ye link kholo
echo   ==========================================================
echo.
echo     Isi computer par:
echo       http://localhost:4310/
echo.
echo   Doosre computer par (SAME Wi-Fi / LAN):
if defined IP1 (
  echo       http://%IP1%:4310/
) else (
  echo       ^(LAN IP nahi mila - network check karein^)
)
echo       http://%COMPUTERNAME%:4310/
echo.
echo   ------------------------------------------------------------
echo     Server band karne ke liye ye window BAND kar dein.
echo     Ya task manager me "node" process ko stop karein.
echo   ------------------------------------------------------------
echo.

REM ---- Open it in the default browser --------------------------------------
start "" "http://localhost:4310/"

echo   Browser me link khul gaya. Ye window band mat karein.
echo.
timeout /t 8 >nul