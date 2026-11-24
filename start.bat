@echo off
setlocal
cd /d "%~dp0"
title Lyrics Studio
set PORT=8888

set "PY="
python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY ( py -3 -c "import sys" >nul 2>&1 && set "PY=py -3" )
if not defined PY goto nopython

%PY% serve.py %PORT%
echo.
pause
goto :eof

:nopython
echo.
echo   Python was not found.
echo   1. Install it from https://www.python.org/downloads/
echo      (tick "Add python.exe to PATH" on the first screen)
echo   2. Run start.bat again.
echo.
pause
