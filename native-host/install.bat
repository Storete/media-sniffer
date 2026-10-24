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

rem T-F4 器官化：yt-dlp 以钉版本 pip 进宿主环境（API 驱动；CLI 兜底仍在）。
rem 版本更新 = 改这里的版本号 + 跑回归（test/host_ytdlp_api_test.py）。
"%PY%" -m pip install --quiet "yt-dlp==2026.8.19" 2>nul
if not "%errorlevel%"=="0" echo [!] yt-dlp pip 安装失败（不影响安装继续，宿主会回退 CLI 模式）

"%PY%" "%HERE%setup.py" install
echo.
pause
