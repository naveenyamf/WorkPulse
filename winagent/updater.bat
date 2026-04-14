@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Updater
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Updater
echo  ================================================
echo.

:: Check admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

echo  Stopping current agent...
taskkill /F /IM wscript.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Reading server URL from config...
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).server_url"') do set SERVER_URL=%%a
if "!SERVER_URL!"=="" set SERVER_URL=http://10.10.11.251
echo  Server: !SERVER_URL!
echo  Downloading latest agent...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/agent-js' -OutFile 'C:\WorkPulse\agent.js'" >nul 2>&1


if not exist "C:\WorkPulse\agent.js" (
    echo  ERROR: Download failed! Check server connection.
    pause
    exit /b 1
)

echo  Updating launcher...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/launch-vbs' -OutFile 'C:\WorkPulse\launch.vbs' -UseBasicParsing"

echo  Restarting agent...
start "" wscript.exe "C:\WorkPulse\launch.vbs"
timeout /t 2 /nobreak >nul

echo.
echo  ================================================
echo   Update Complete!
echo  ================================================
echo.
echo   Agent updated and restarted successfully.
echo   You can close this window.
echo  ================================================
echo.
pause
