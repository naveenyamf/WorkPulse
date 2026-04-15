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

:: Remove trailing slash
if "!SERVER_URL:~-1!"=="/" set SERVER_URL=!SERVER_URL:~0,-1!

:: If no protocol given, try https first then fall back to http
echo !SERVER_URL! | findstr /i "^http" >nul 2>&1
if errorlevel 1 (
    echo  No protocol specified, detecting...
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://!SERVER_URL!' -UseBasicParsing -TimeoutSec 5; exit 0 } catch { exit 1 }" >nul 2>&1
    if !errorlevel!==0 (
        set SERVER_URL=https://!SERVER_URL!
        echo  Using HTTPS
    ) else (
        set SERVER_URL=http://!SERVER_URL!
        echo  Using HTTP
    )
)

echo  Server URL: !SERVER_URL!

:: Validate server is reachable
echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 8; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Cannot reach server at !SERVER_URL!
    echo  Please check the URL and try again.
    echo.
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

echo  Downloading agent...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/agent-exe' -OutFile 'C:\WorkPulse\WorkPulse-Agent.exe' -UseBasicParsing" >nul 2>&1
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  ERROR: Failed to download agent from server.
    pause
    exit /b 1
)

echo {"email":"!EMPLOYEE_EMAIL!","token":"!TOKEN!","server_url":"!SERVER_URL!"} > "C:\WorkPulse\config.json"

echo  Downloading launcher...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/launch-vbs' -OutFile 'C:\WorkPulse\launch.vbs' -UseBasicParsing" >nul 2>&1
if not exist "C:\WorkPulse\launch.vbs" (
    echo  ERROR: Failed to download launcher.
    pause
    exit /b 1
)

reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /t REG_SZ /d "wscript.exe \"C:\WorkPulse\launch.vbs\"" /f >nul
start "" wscript.exe "C:\WorkPulse\launch.vbs"

echo.
echo  ================================================
echo   Installation Complete!
echo  ================================================
echo.
echo   Employee : !EMPLOYEE_EMAIL!
echo   Server   : !SERVER_URL!
echo   Location : C:\WorkPulse\
echo   Startup  : Enabled (auto-starts on Windows login)
echo   Status   : Agent running in background
echo.
echo   You can close this window.
echo  ================================================
echo.
pause
