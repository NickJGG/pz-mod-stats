@echo off
REM Regenerate the Workshop comment audit and publish it to the audit-data branch.
REM Requires llama-server already running (START.bat) — audit.mjs preflights it and
REM prints how to start it if it's down. Pass --no-publish to write locally only.
REM --no-think runs with the model's chain-of-thought off (faster on this GPU);
REM %* still forwards extra flags, so AUDIT.bat --no-publish etc. works.
node "%~dp0scripts\audit.mjs" --no-think %*
pause
