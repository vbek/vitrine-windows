# Starts the Vitrine player full screen at sign-in on Windows, using Microsoft Edge.
# Usage: powershell -ExecutionPolicy Bypass -File kiosk-windows.ps1 -Studio http://STUDIO-ADDRESS:3400
param([Parameter(Mandatory)][string]$Studio)

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "Microsoft Edge not found at $edge" }

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut("$([Environment]::GetFolderPath('Startup'))\Vitrine Player.lnk")
$link.TargetPath = $edge
$link.Arguments = "--kiosk $Studio/tv --edge-kiosk-type=fullscreen --no-first-run --autoplay-policy=no-user-gesture-required --user-data-dir=`"$env:LOCALAPPDATA\VitrinePlayer`""
$link.Save()
Write-Host "Done. Sign out and back in; a pairing code will appear on the display."
