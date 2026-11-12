@echo off
cd /d "%~dp0"
set "PW_NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "PW_NODE=%ProgramFiles%\nodejs\node.exe"
"%PW_NODE%" -e "if(Number(process.versions.node.split('.')[0])<24){console.error('Node.js 24.15 or newer is required.');process.exit(1)}"
if errorlevel 1 goto end
echo Open http://127.0.0.1:4173/ in your browser. Keep this window open.
"%PW_NODE%" server.mjs
:end
pause
