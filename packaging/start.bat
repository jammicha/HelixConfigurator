@echo off
setlocal
cd /d "%~dp0"
echo Starting Helix OTel Configurator...
start "" /b node.exe backend\index.js
set "URL=http://localhost:8765"
set /a "_w=0"
:wait
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 ( start "" "%URL%?view=onboarding" & goto :ready )
set /a "_w+=1"
if %_w% geq 30 goto :ready
timeout /t 1 /nobreak >nul
goto :wait
:ready
echo Configurator UI: %URL%
