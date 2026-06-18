@echo off
chcp 65001 >nul
title Bibbidi — Media Grabber
cd /d "%~dp0"

echo.
echo  ============================================
echo   Bibbidi — Tải ảnh / video từ link
echo  ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [LỖI] Máy chưa cài Node.js nên không chạy được.
  echo.
  echo  Cách sửa ^(chỉ làm 1 lần^):
  echo    1. Trình duyệt sẽ mở trang tải Node.js
  echo    2. Tải bản LTS ^(nút xanh^) và cài đặt
  echo    3. Khởi động lại máy
  echo    4. Double-click file Bibbidi.bat lại
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo  Đang cài thư viện lần đầu ^(2-5 phút^)...
  call npm install
  if errorlevel 1 (
    echo  [LỖI] Cài thư viện thất bại. Kiểm tra mạng rồi thử lại.
    pause
    exit /b 1
  )
  echo  Đang tải trình duyệt cho đăng nhập 1688...
  call npx playwright install chromium
)

if not exist ".setup-done" (
  echo. > ".setup-done"
)

echo  Đang mở http://localhost:3456 ...
start "" "http://localhost:3456"

echo.
echo  Bibbidi ĐANG CHẠY — giữ cửa sổ này mở.
echo  Tắt cửa sổ này = tắt Bibbidi.
echo.
call npm start

echo.
echo  Bibbidi đã dừng.
pause
