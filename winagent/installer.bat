@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Installer
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Installer v2.7
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
    pause
    exit /b 1
)

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
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://!SERVER_URL!' -UseBasicParsing -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if !errorlevel!==0 (set SERVER_URL=https://!SERVER_URL!) else (set SERVER_URL=http://!SERVER_URL!)
)

echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 8; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Cannot reach server at !SERVER_URL!
    pause
    exit /b 1
)
echo  Server connected OK

for /f "delims=" %%i in ('powershell -NoProfile -Command "$env:COMPUTERNAME"') do set MACHINE_ID=%%i
echo  Machine: !MACHINE_ID!

set TOKEN=
set EMAIL_ATTEMPT=0

:ask_email
set /a EMAIL_ATTEMPT+=1
echo.
set /p EMPLOYEE_EMAIL=" Enter employee email address: "
if "!EMPLOYEE_EMAIL!"=="" (
    echo  ERROR: Email cannot be empty.
    if !EMAIL_ATTEMPT! lss 3 goto ask_email
    pause
    exit /b 1
)

echo  Looking up employee...
for /f "delims=" %%i in ('powershell -NoProfile -Command "try { $r=(Invoke-WebRequest -Uri '!SERVER_URL!/api/agent/token/!EMPLOYEE_EMAIL!?machine_id=!MACHINE_ID!' -UseBasicParsing).Content; ($r|ConvertFrom-Json).token } catch { '' }" 2^>nul') do set TOKEN=%%i

if "!TOKEN!"=="" (
    echo  Employee not found or already assigned.
    if !EMAIL_ATTEMPT! lss 3 goto ask_email
    pause
    exit /b 1
)
echo  Employee found! Token retrieved.

echo.
echo  Installing to C:\WorkPulse...
mkdir "C:\WorkPulse" >nul 2>&1

echo  Copying agent...
copy /Y "%~dp0WorkPulse-Agent.exe" "C:\WorkPulse\WorkPulse-Agent.exe" >nul

echo  Writing config...
powershell -NoProfile -Command "$e='!EMPLOYEE_EMAIL!'; $t='!TOKEN!'; $s='!SERVER_URL!'; $m='!MACHINE_ID!'; $cfg='{' + '\"email\":\"' + $e + '\",\"token\":\"' + $t + '\",\"server_url\":\"' + $s + '\",\"machine_id\":\"' + $m + '\"}'; [System.IO.File]::WriteAllText('C:\WorkPulse\config.json',$cfg)"

echo  Creating silent launcher...
powershell -NoProfile -Command "$s='Set oShell = CreateObject(' + [char]34 + 'WScript.Shell' + [char]34 + ')'; $s2='oShell.CurrentDirectory = ' + [char]34 + 'C:\WorkPulse' + [char]34; $s3='oShell.Run ' + [char]34 + 'C:\WorkPulse\WorkPulse-Agent.exe' + [char]34 + ', 0, False'; [System.IO.File]::WriteAllLines('C:\WorkPulse\launch.vbs',@($s,$s2,$s3))"


if exist "%~dp0updater.bat"   copy /Y "%~dp0updater.bat"   "C:\WorkPulse\updater.bat"   >nul
if exist "%~dp0uninstall.bat" copy /Y "%~dp0uninstall.bat" "C:\WorkPulse\uninstall.bat" >nul

echo  Trusting agent...
powershell -NoProfile -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'" >nul 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'" >nul 2>&1

echo  Removing old NSSM service if exists...
if exist "C:\WorkPulse\nssm.exe" (
    "C:\WorkPulse\nssm.exe" stop WorkPulse_Service >nul 2>&1
    "C:\WorkPulse\nssm.exe" remove WorkPulse_Service confirm >nul 2>&1
)
echo  Setting up auto-start...
schtasks /delete /tn "WorkPulseAgent"    /f >nul 2>&1
schtasks /delete /tn "WorkPulseWatchdog" /f >nul 2>&1
sc stop WorkPulse_Service >nul 2>&1
sc delete WorkPulse_Service >nul 2>&1
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulseAgent" /t REG_SZ /d "wscript.exe //B \"C:\WorkPulse\launch.vbs\"" /f >nul 2>&1
echo  Auto-start configured OK

powershell -NoProfile -Command "$t=Get-ScheduledTask -TaskName 'WorkPulseAgent'; $t.Settings.DisallowStartIfOnBatteries=$false; $t.Settings.StopIfGoingOnBatteries=$false; Set-ScheduledTask -InputObject $t" >nul 2>&1

echo  Starting agent silently...
taskkill /F /IM WorkPulse-Agent.exe >nul 2>&1
timeout /t 1 /nobreak >nul
wscript.exe //B "C:\WorkPulse\launch.vbs"
timeout /t 8 /nobreak >nul

tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 goto :agent_running

echo  Retrying...
wscript.exe //B "C:\WorkPulse\launch.vbs"
timeout /t 8 /nobreak >nul
tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel%==0 goto :agent_running

echo  Agent will start automatically on next login.
goto :done

:agent_running
echo.
echo  ================================================
echo   Agent Status: RUNNING
echo  ================================================

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
echo   Auto-start: Registry Run key (all users)
echo   Log file : C:\WorkPulse\agent.log
echo.
pause
