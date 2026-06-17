@echo off
echo ============================================
echo  Bibbidi - Chrome debug cho 1688
echo ============================================
echo.
echo 1. DONG het cua so Chrome truoc
echo 2. Nhan phim bat ky de mo Chrome (debug port 9222)
echo 3. Dang nhap 1688 tren Chrome vua mo
echo 4. Quay lai Bibbidi va dan link
echo.
pause

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

start "" "%CHROME%" --remote-debugging-port=9222

echo.
echo Da mo Chrome. Dang nhap 1688 roi thu lai tren http://localhost:3456
pause
