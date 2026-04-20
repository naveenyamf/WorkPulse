@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Installer
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Installer v2.6
echo  ================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

if not exist "%~dp0WorkPulse-Agent.exe" (
    echo  ERROR: WorkPulse-Agent.exe not found in this folder.
    echo  Make sure you extracted the full ZIP before running.
    pause
    exit /b 1
)

echo.
echo  Examples:
echo    Local IP  : http://192.168.1.100:3000
echo    Domain    : https://monitoring.company.com
echo.
set /p SERVER_URL=" Enter WorkPulse server URL: "
if "!SERVER_URL!"=="" (
    echo  ERROR: Server URL cannot be empty
    pause
    exit /b 1
)

if "!SERVER_URL:~-1!"=="/" set SERVER_URL=!SERVER_URL:~0,-1!

echo !SERVER_URL! | findstr /i "^http" >nul 2>&1
if errorlevel 1 (
    echo  No protocol specified, detecting...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://!SERVER_URL!' -UseBasicParsing -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if !errorlevel!==0 (
        set SERVER_URL=https://!SERVER_URL!
        echo  Using HTTPS
    ) else (
        set SERVER_URL=http://!SERVER_URL!
        echo  Using HTTP
    )
)

echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 8; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Cannot reach server at !SERVER_URL!
    pause
    exit /b 1
)
echo  Server connected OK

echo  Getting machine ID...
for /f "delims=" %%i in ('powershell -NoProfile -Command "$env:COMPUTERNAME"') do set MACHINE_ID=%%i
echo  Machine: !MACHINE_ID!

:: EMAIL ENTRY WITH 3 ATTEMPTS
set TOKEN=
set EMAIL_ATTEMPT=0

:ask_email
set /a EMAIL_ATTEMPT+=1
echo.
set /p EMPLOYEE_EMAIL=" Enter employee email address: "
if "!EMPLOYEE_EMAIL!"=="" (
    echo  ERROR: Email cannot be empty.
    if !EMAIL_ATTEMPT! lss 3 goto ask_email
    echo  Too many failed attempts. Exiting.
    pause
    exit /b 1
)

echo  Looking up employee...
for /f "delims=" %%i in ('powershell -NoProfile -Command "try { $r=(Invoke-WebRequest -Uri '!SERVER_URL!/api/agent/token/!EMPLOYEE_EMAIL!?machine_id=!MACHINE_ID!' -UseBasicParsing).Content; ($r|ConvertFrom-Json).token } catch { '' }" 2^>nul') do set TOKEN=%%i

if "!TOKEN!"=="" (
    echo.
    echo  ------------------------------------------------
    echo   Employee not found or already assigned to
    echo   another PC. Please enter a different email.
    echo  ------------------------------------------------
    if !EMAIL_ATTEMPT! lss 3 (
        echo   Attempt !EMAIL_ATTEMPT! of 3. Try again.
        goto ask_email
    ) else (
        echo   3 attempts used. Contact your administrator.
        pause
        exit /b 1
    )
)
echo  Employee found! Token retrieved.

:: INSTALL FILES
echo.
echo  Installing to C:\WorkPulse...
mkdir "C:\WorkPulse" >nul 2>&1

echo  Copying agent...
copy /Y "%~dp0WorkPulse-Agent.exe" "C:\WorkPulse\WorkPulse-Agent.exe" >nul
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  ERROR: Failed to copy agent executable.
    pause
    exit /b 1
)

echo  Writing config...
powershell -NoProfile -Command "[System.IO.File]::WriteAllText('C:\WorkPulse\config.json','{\"email\":\"!EMPLOYEE_EMAIL!\",\"token\":\"!TOKEN!\",\"server_url\":\"!SERVER_URL!\",\"machine_id\":\"!MACHINE_ID!\"}')"

echo  Creating silent launcher...
powershell -NoProfile -Command "$a='Set oShell = CreateObject(' + [char]34 + 'WScript.Shell' + [char]34 + ')'; $b='oShell.CurrentDirectory = ' + [char]34 + 'C:\WorkPulse' + [char]34; $c='oShell.Run ' + [char]34 + 'cmd /c WorkPulse-Agent.exe >> C:\WorkPulse\agent.log 2>nul' + [char]34 + ', 0, False'; [System.IO.File]::WriteAllLines('C:\WorkPulse\launch.vbs',@($a,$b,$c))"

if exist "%~dp0updater.bat"   copy /Y "%~dp0updater.bat"   "C:\WorkPulse\updater.bat"   >nul
if exist "%~dp0uninstall.bat" copy /Y "%~dp0uninstall.bat" "C:\WorkPulse\uninstall.bat" >nul

echo  Trusting agent executable...
powershell -NoProfile -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'" >nul 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'" >nul 2>&1

:: SETUP TASK SCHEDULER
echo  Setting up auto-start...
schtasks /delete /tn "WorkPulseAgent" /f >nul 2>&1
schtasks /create /tn "WorkPulseAgent" /tr "wscript.exe //B \"C:\WorkPulse\launch.vbs\"" /sc onlogon /rl highest /f >nul 2>&1

:: START AGENT NOW
echo  Starting agent silently...
taskkill /F /IM WorkPulse-Agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul
del "C:\WorkPulse\agent.log" >nul 2>&1

wscript.exe //B "C:\WorkPulse\launch.vbs"
echo  Waiting for agent to start...
timeout /t 8 /nobreak >nul

tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 goto :agent_running

echo  Retrying...
wscript.exe //B "C:\WorkPulse\launch.vbs"
timeout /t 8 /nobreak >nul

tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 goto :agent_running

echo.
echo  ------------------------------------------------
echo   Agent could not start automatically.
echo   Please RESTART your PC - the agent will start
echo   automatically on next login.
echo  ------------------------------------------------
goto :done

:agent_running
echo.
echo  ================================================
echo   Agent Status: RUNNING
echo  ================================================
echo.
echo  Verifying connection to server...
timeout /t 5 /nobreak >nul
findstr /C:"Agent started" "C:\WorkPulse\agent.log" >nul 2>&1
if %errorlevel%==0 (
    echo   Connected : YES
) else (
    echo   Connected : Connecting...
)

:done
echo.
echo  ================================================
echo   Installation Complete!
echo  ================================================
echo.
echo   Employee : !EMPLOYEE_EMAIL!
echo   Server   : !SERVER_URL!
echo   Machine  : !MACHINE_ID!
echo   Location : C:\WorkPulse\
echo   Auto-start: On every login ^(Task Scheduler^)
echo   Log file : C:\WorkPulse\agent.log
echo.
pause
