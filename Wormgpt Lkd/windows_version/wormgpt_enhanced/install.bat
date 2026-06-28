@echo off
echo.
echo ╔═══════════════════════════════════════════╗
echo ║       WormGPT Enhanced - Windows          ║
echo ╚═══════════════════════════════════════════╝
echo.

:: Check Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js not found. Install from https://nodejs.org ^(v18+^)
    pause
    exit /b 1
)
echo ✅ Node.js found: 
node --version

:: Check Ollama
ollama --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Ollama not found.
    echo    Download from: https://ollama.ai/download
    echo    Install it then re-run this script.
    pause
    exit /b 1
)
echo ✅ Ollama found

:: Start Ollama service
echo.
echo 🚀 Starting Ollama service...
start "" /B ollama serve
timeout /t 3 /nobreak >nul

:: Pull model
echo 📥 Pulling model: godmoded/llama3-lexi-uncensored
echo    (This may take a few minutes on first run...)
ollama pull godmoded/llama3-lexi-uncensored
if %ERRORLEVEL% NEQ 0 (
    echo ⚠️  Model pull failed - try manually: ollama pull godmoded/llama3-lexi-uncensored
)

:: Install frontend deps
echo.
echo 📦 Installing frontend dependencies...
cd app
call npm install --silent
echo ✅ Frontend deps installed

:: Build frontend
echo 🔨 Building frontend...
call npm run build --silent
echo ✅ Frontend built
cd ..

:: Install server deps
echo.
echo 📦 Installing server dependencies...
cd server
call npm install --silent
echo ✅ Server deps installed
cd ..

echo.
echo ╔═══════════════════════════════════════════╗
echo ║  ✅  Installation Complete!               ║
echo ║                                           ║
echo ║  Run:   start.bat                         ║
echo ║  Open:  http://localhost:3001             ║
echo ║  Pass:  Realnojokepplwazy1234             ║
echo ╚═══════════════════════════════════════════╝
echo.
pause
