@echo off
rem Media Sniffer native messaging launcher
setlocal
set "HERE=%~dp0"
set "PY="
if exist "%HERE%python_path.txt" set /p PY=<"%HERE%python_path.txt"
if not defined PY set "PY=python"
"%PY%" "%HERE%sniffer_host.py"
