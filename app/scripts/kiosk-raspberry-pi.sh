#!/bin/sh
# Starts the Vitrine player full screen at login on Raspberry Pi OS (desktop).
# Usage: sh kiosk-raspberry-pi.sh http://STUDIO-ADDRESS:3400
set -e
STUDIO="${1:?Usage: sh kiosk-raspberry-pi.sh http://STUDIO-ADDRESS:3400}"
BROWSER="$(command -v chromium-browser || command -v chromium)" || { echo "Chromium not found. Install it first."; exit 1; }

mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/vitrine-player.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Vitrine Player
Exec=$BROWSER --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 $STUDIO/tv
X-GNOME-Autostart-enabled=true
EOF
echo "Done. Restart the Pi; a pairing code will appear on the display."
