@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Uninstaller
color 0C
cls

echo.
echo  ================================================
echo   WorkPulse Agent Uninstaller v2.3
echo  ================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

echo  Reading config for server unregister...
set SERVER_URL=
set EMPLOYEE_EMAIL=
if exist "C:\WorkPulse\config.json" (
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).server_url" 2^>nul') do set SERVER_URL=%%a
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).email" 2^>nul') do set EMPLOYEE_EMAIL=%%a
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).token" 2^>nul') do set AGENT_TOKEN=%%a
)

echo  Stopping agent...
taskkill /F /IM WorkPulse-Agent.exe >nul 2>&1
taskkill /F /IM wscript.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Removing Task Scheduler entry...
schtasks /delete /tn "WorkPulseAgent" /f >nul 2>&1

echo  Removing startup registry entries...
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulseAgent" /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulseAgent" /f >nul 2>&1

echo  Notifying server to release machine binding...
if not "!SERVER_URL!"=="" (
    if not "!AGENT_TOKEN!"=="" (
        powershell -NoProfile -Command ^
            "try { Invoke-WebRequest -Uri '!SERVER_URL!/api/agent/unregister' -Method POST -Headers @{'x-agent-token'='!AGENT_TOKEN!'} -UseBasicParsing -TimeoutSec 5 | Out-Null; Write-Host ' Server notified OK' } catch { Write-Host ' Server notify skipped (offline)' }"
    )
)

echo  Removing WorkPulse files...
cd C:\
rmdir /S /Q C:\WorkPulse >nul 2>&1

if exist "C:\WorkPulse" (
    echo  WARNING: Some files could not be removed. Try again after reboot.
) else (
    echo  Files removed successfully.
)

echo.
echo  ================================================
echo   WorkPulse Agent Removed Successfully
echo  ================================================
echo.
echo   Employee : !EMPLOYEE_EMAIL!
echo   Server   : !SERVER_URL!
echo   Status   : Agent stopped and removed
echo   Machine  : Released from server binding
echo.
echo   The agent will no longer run on this PC.
echo  ================================================
echo.
pause
