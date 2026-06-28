@echo off
echo.
echo ⚡ Starting WormGPT Enhanced...
echo.

:: Start Ollama if not running
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if %ERRORLEVEL% NEQ 0 (
    echo 🦙 Starting Ollama service...
    start "" /B ollama serve
    timeout /t 3 /nobreak >nul
) else (
    echo ✅ Ollama already running
)

:: Kill anything on port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Start backend server
echo 🔌 Starting backend server...
cd server
start "" /B node index.js
cd ..
timeout /t 2 /nobreak >nul

:: Open browser
echo 🌐 Opening browser...
start http://localhost:3001

echo.
echo ╔═══════════════════════════════════════╗
echo ║   ⚡ WormGPT Enhanced Running!        ║
echo ║                                       ║
echo ║   → http://localhost:3001             ║
echo ║   Password: Realnojokepplwazy1234     ║
echo ║                                       ║
echo ║   Close this window to stop           ║
echo ╚═══════════════════════════════════════╝
echo.

:: Keep window open and server running
cd server
node index.js
