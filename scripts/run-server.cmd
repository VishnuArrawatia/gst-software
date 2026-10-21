@echo off
REM Helper for "START SERVER.bat". Lives beside the project so there are no
REM nested quotes to get wrong: this file already sits in the right folder.
cd /d "%~dp0.."
if not exist output mkdir output
npx tsx src/server/server.ts >> output\server.log 2>&1