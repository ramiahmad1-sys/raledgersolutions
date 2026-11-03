@echo off
rem Double-click to start the phone agent and ngrok. Needs Node 18+ and ngrok installed.
cd /d "%~dp0"
if "%GROQ_API_KEY%"=="" set /p GROQ_API_KEY=Paste your Groq key and press Enter: 
start "Phone agent server" cmd /k node server.js
timeout /t 2 >nul
start "ngrok" cmd /k ngrok http 3000
echo.
echo In the ngrok window, copy the https address on the Forwarding line.
echo Twilio webhook = that address + /voice  (POST)
pause
