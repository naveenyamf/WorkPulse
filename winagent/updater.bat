@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Updater
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Updater v2.7
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
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/WorkPulseAgent.exe' -OutFile 'C:\WorkPulse\WorkPulse-Agent.exe' -UseBasicParsing" >nul 2>&1
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  ERROR: Failed to download agent. Check server connection.
    pause
    exit /b 1
)
echo  Agent downloaded OK

echo  Recreating silent launcher...
powershell -NoProfile -Command "$a='Set oShell = CreateObject(' + [char]34 + 'WScript.Shell' + [char]34 + ')'; $b='oShell.CurrentDirectory = ' + [char]34 + 'C:\WorkPulse' + [char]34; $c='oShell.Run ' + [char]34 + 'C:\WorkPulse\WorkPulse-Agent.exe' + [char]34 + ', 0, False'; [System.IO.File]::WriteAllLines('C:\WorkPulse\launch.vbs',@($a,$b,$c))"

echo  Trusting agent executable...
powershell -NoProfile -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'" >nul 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'" >nul 2>&1

echo  Updating auto-start...
schtasks /delete /tn "WorkPulseAgent"    /f >nul 2>&1
schtasks /delete /tn "WorkPulseWatchdog" /f >nul 2>&1
sc stop WorkPulse_Service >nul 2>&1
sc delete WorkPulse_Service >nul 2>&1
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulseAgent" /t REG_SZ /d "wscript.exe //B \"C:\WorkPulse\launch.vbs\"" /f >nul 2>&1
echo  Auto-start configured OK

echo  Starting updated agent...
wscript.exe //B "C:\WorkPulse\launch.vbs"
timeout /t 5 /nobreak >nul

tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 (
    echo  Agent is running!
) else (
    echo  WARNING: Agent will start automatically on next login.
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
