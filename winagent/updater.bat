@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Updater
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Updater v2.3
echo  ================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

if not exist "C:\WorkPulse\config.json" (
    echo  ERROR: WorkPulse is not installed on this PC.
    echo  Please run installer.bat first.
    pause
    exit /b 1
)

echo  Reading configuration...
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).server_url"') do set SERVER_URL=%%a
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-Content 'C:\WorkPulse\config.json' | ConvertFrom-Json).token"') do set AGENT_TOKEN=%%a

if "!SERVER_URL!"=="" (
    echo  ERROR: Could not read server URL from config.
    pause
    exit /b 1
)
echo  Server: !SERVER_URL!

echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 8; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Cannot reach server at !SERVER_URL!
    pause
    exit /b 1
)
echo  Server connected OK

echo  Stopping current agent...
taskkill /F /IM WorkPulse-Agent.exe >nul 2>&1
taskkill /F /IM wscript.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Downloading latest agent...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/agent-exe' -OutFile 'C:\WorkPulse\WorkPulse-Agent.exe' -UseBasicParsing" >nul 2>&1
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  ERROR: Failed to download agent. Check server connection.
    pause
    exit /b 1
)
echo  Agent downloaded OK

echo  Downloading latest launcher...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/launch-vbs' -OutFile 'C:\WorkPulse\launch.vbs' -UseBasicParsing" >nul 2>&1
echo  Launcher updated

echo  Trusting agent executable...
powershell -NoProfile -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'" >nul 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'" >nul 2>&1

echo  Updating Task Scheduler entry...
schtasks /delete /tn "WorkPulseAgent" /f >nul 2>&1
schtasks /create /tn "WorkPulseAgent" /tr "wscript.exe //B \"C:\WorkPulse\launch.vbs\"" /sc onlogon /rl highest /f >nul 2>&1

echo  Starting updated agent...
schtasks /run /tn "WorkPulseAgent" >nul 2>&1
timeout /t 4 /nobreak >nul

tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 (
    echo  Agent is running!
) else (
    echo  Starting via direct launch...
    start "" /B cmd /c "cd /d C:\WorkPulse && WorkPulse-Agent.exe >> C:\WorkPulse\agent.log 2>nul"
    timeout /t 3 /nobreak >nul
    tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
    if %errorlevel%==0 (
        echo  Agent started successfully!
    ) else (
        echo  WARNING: Agent will start automatically on next login.
    )
)

echo.
echo  ================================================
echo   Update Complete!
echo  ================================================
echo.
echo   Server  : !SERVER_URL!
echo   Log     : C:\WorkPulse\agent.log
echo   Status  : Agent updated and running
echo.
pause
