@echo off
setlocal enabledelayedexpansion
title WorkPulse Agent Uninstaller
color 0C
cls

echo.
echo  ================================================
echo   WorkPulse Agent Uninstaller v2.2
echo  ================================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click and Run as Administrator
    pause
    exit /b 1
)

echo  Stopping agent...
taskkill /F /IM WorkPulse-Agent.exe >nul 2>&1
taskkill /F /IM wscript.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Removing startup entries...
reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulse" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WorkPulseAgent" /f >nul 2>&1

echo  Removing files...
cd C:\
rmdir /S /Q C:\WorkPulse >nul 2>&1

echo.
echo  ================================================
echo   WorkPulse Agent Removed Successfully
echo  ================================================
echo.
echo   All files and startup entries have been removed.
echo   The agent will no longer run on this PC.
echo  ================================================
echo.
pause
