@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Installer
color 0B
cls

echo.
echo  ================================================
echo   WorkPulse Agent Installer
echo  ================================================
echo.

:: Check admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

:: Get server URL
echo.
set /p SERVER_URL=" Enter WorkPulse server URL (e.g. http://192.168.1.100 or https://abc@xyz.com): "
if "!SERVER_URL!"=="" (
    echo  ERROR: Server URL cannot be empty
    pause
    exit /b 1
)

:: Remove trailing slash
if "!SERVER_URL:~-1!"=="/" set SERVER_URL=!SERVER_URL:~0,-1!
echo  Server URL: !SERVER_URL!

:: Add https:// if no protocol specified
echo !SERVER_URL! | findstr /i "^http" >nul 2>&1
if errorlevel 1 set SERVER_URL=https://!SERVER_URL!

:: Add hosts entry if domain provided
echo !SERVER_URL! | findstr /i "novelinfra.com" >nul 2>&1
if not errorlevel 1 (
    findstr /i "monitoring.novelinfra.com" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
    if errorlevel 1 (
        echo 103.164.156.123 monitoring.novelinfra.com >> C:\Windows\System32\drivers\etc\hosts
        echo  Added hosts entry for monitoring.novelinfra.com
    )
)

:: Validate server is reachable
echo  Checking server connection...
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!SERVER_URL!' -UseBasicParsing -TimeoutSec 5; if($r.StatusCode -lt 500){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Cannot reach server at !SERVER_URL!
    echo  Please check the URL and try again.
    echo.
    pause
    exit /b 1
)
echo  Server connected OK


echo  Checking requirements... OK

:: Get employee email
echo.
set /p EMPLOYEE_EMAIL=" Enter employee email address: "

if "!EMPLOYEE_EMAIL!"=="" (
    echo  ERROR: Email cannot be empty
    pause
    exit /b 1
)

:: Fetch token from server
echo.
echo  Connecting to WorkPulse server...
set SERVER=!SERVER_URL!

for /f "delims=" %%i in ('powershell -NoProfile -Command "(Invoke-WebRequest -Uri '!SERVER_URL!/api/agent/token/!EMPLOYEE_EMAIL!' -UseBasicParsing).Content" 2^>nul') do set RESPONSE=%%i

:: Extract token from JSON response
for /f "tokens=2 delims=:}" %%a in ("!RESPONSE!") do (
    set TOKEN=%%a
    set TOKEN=!TOKEN:"=!
    set TOKEN=!TOKEN: =!
)

if "!TOKEN!"=="" (
    echo.
    echo  ERROR: Could not find employee with email: !EMPLOYEE_EMAIL!
    echo  Please make sure this employee is added in the dashboard first.
    echo.
    pause
    exit /b 1
)

echo  Employee found! Token retrieved successfully.

:: Create installation directory
echo.
echo  Installing WorkPulse Agent...
mkdir "C:\WorkPulse" >nul 2>&1

:: Download agent exe from server
echo  Downloading agent...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/agent-exe' -OutFile 'C:\WorkPulse\WorkPulse-Agent.exe' -UseBasicParsing"
if not exist "C:\WorkPulse\WorkPulse-Agent.exe" (
    echo  Falling back to local copy...
    copy /Y "WorkPulse-Agent.exe" "C:\WorkPulse\WorkPulse-Agent.exe" >nul
)

:: Save config with email, token and server URL
echo {"email":"!EMPLOYEE_EMAIL!","token":"!TOKEN!","server_url":"!SERVER_URL!"} > "C:\WorkPulse\config.json"


:: Download launcher VBS from server
powershell -NoProfile -Command "Invoke-WebRequest -Uri '!SERVER_URL!/download/launch-vbs' -OutFile 'C:\WorkPulse\launch.vbs' -UseBasicParsing"

:: Add to startup registry (runs at Windows login, completely hidden)
reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /t REG_SZ /d "wscript.exe \"C:\WorkPulse\launch.vbs\"" /f >nul

:: Start agent right now
echo  Starting agent...
start "" wscript.exe "C:\WorkPulse\launch.vbs"

echo.
echo  ================================================
echo   Installation Complete!
echo  ================================================
echo.
echo   Employee : !EMPLOYEE_EMAIL!
echo   Status   : Agent is now running in background
echo   Startup  : Will auto-start when Windows boots
echo.
echo   You can now close this window.
echo  ================================================
echo.
pause
