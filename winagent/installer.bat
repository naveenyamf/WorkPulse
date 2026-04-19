@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Installer
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Installer v2.2
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
echo    Local IP  : http://192.168.1.100
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

echo  Server URL: !SERVER_URL!

echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 8; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Cannot reach server at !SERVER_URL!
    pause
    exit /b 1
)
echo  Server connected OK

echo.
set /p EMPLOYEE_EMAIL=" Enter employee email address: "
if "!EMPLOYEE_EMAIL!"=="" (
    echo  ERROR: Email cannot be empty
    pause
    exit /b 1
)

echo  Fetching agent token...
for /f "delims=" %%i in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '!SERVER_URL!/api/agent/token/!EMPLOYEE_EMAIL!' -UseBasicParsing).Content } catch { '' }" 2^>nul') do set RESPONSE=%%i

for /f "tokens=2 delims=:}" %%a in ("!RESPONSE!") do (
    set TOKEN=%%a
    set TOKEN=!TOKEN:"=!
    set TOKEN=!TOKEN: =!
)

if "!TOKEN!"=="" (
    echo  ERROR: Employee not found: !EMPLOYEE_EMAIL!
    echo  Add this employee in the dashboard first.
    pause
    exit /b 1
)
echo  Employee found! Token retrieved.

echo  Installing to C:\WorkPulse...
mkdir "C:\WorkPulse" >nul 2>&1

echo  Copying agent...
copy /Y "%~dp0WorkPulse-Agent.exe" "C:\WorkPulse\WorkPulse-Agent.exe" >nul
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  ERROR: Failed to copy agent executable.
    pause
    exit /b 1
)

echo {"email":"!EMPLOYEE_EMAIL!","token":"!TOKEN!","server_url":"!SERVER_URL!"} > "C:\WorkPulse\config.json"

echo  Creating launcher...
(
echo Set oShell = CreateObject^("WScript.Shell"^)
echo Set oFSO = CreateObject^("Scripting.FileSystemObject"^)
echo strDir = "C:\WorkPulse"
echo strExe = strDir ^& "\WorkPulse-Agent.exe"
echo If oFSO.FileExists^(strExe^) Then
echo     oShell.Run Chr^(34^) ^& strExe ^& Chr^(34^), 0, False
echo End If
) > "C:\WorkPulse\launch.vbs"

if exist "%~dp0updater.bat"   copy /Y "%~dp0updater.bat"   "C:\WorkPulse\updater.bat"   >nul
if exist "%~dp0uninstall.bat" copy /Y "%~dp0uninstall.bat" "C:\WorkPulse\uninstall.bat" >nul

reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /t REG_SZ /d "wscript.exe \"C:\WorkPulse\launch.vbs\"" /f >nul
echo  Trusting agent executable...
powershell -NoProfile -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'" >nul 2>&1
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'" >nul 2>&1

echo  Starting agent...
start "" wscript.exe "C:\WorkPulse\launch.vbs"
timeout /t 3 /nobreak >nul
tasklist /FI "IMAGENAME eq WorkPulse-Agent.exe" 2>nul | find /I "WorkPulse-Agent.exe" >nul
if %errorlevel% neq 0 (
    echo  VBS blocked, switching to Task Scheduler...
    schtasks /create /tn "WorkPulseAgent" /tr "wscript.exe //B \"C:\WorkPulse\launch.vbs\"" /sc onlogon /rl highest /f >nul 2>&1
    schtasks /run /tn "WorkPulseAgent" >nul 2>&1
    echo  Task Scheduler started
)
echo.
echo  ================================================
echo   Installation Complete!
echo  ================================================
echo.
echo   Employee : !EMPLOYEE_EMAIL!
echo   Server   : !SERVER_URL!
echo   Location : C:\WorkPulse\
echo   Startup  : Enabled
echo   Status   : Agent running
echo.
pause
