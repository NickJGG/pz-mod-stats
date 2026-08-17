@echo off
REM Regenerate the Workshop comment audit and publish it to the audit-data branch.
REM Requires llama-server already running (START.bat) — audit.mjs preflights it and
REM prints how to start it if it's down. Pass --no-publish to write locally only.
node "%~dp0scripts\audit.mjs" %*
pause
