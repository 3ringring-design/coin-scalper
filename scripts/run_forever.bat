@echo off
REM Windows: restarts the bot 10 seconds after it stops for any reason.
cd /d %~dp0\..
if exist .venv\Scripts\activate.bat call .venv\Scripts\activate.bat
:loop
python run.py
echo Bot stopped. Restarting in 10 seconds... (Ctrl+C then Y to quit)
timeout /t 10 /nobreak > nul
goto loop
