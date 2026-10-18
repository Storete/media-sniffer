@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "PY="

where python >nul 2>nul
if %errorlevel%==0 set "PY=python"

if not defined PY if exist "D:/Python/python.exe" set "PY=D:/Python/python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"

if not defined PY (
  echo [x] Python not found. Install Python 3.8+ first: https://www.python.org/downloads/
  pause
  exit /b 1
)

"%PY%" "%HERE%setup.py" install
echo.
pause
