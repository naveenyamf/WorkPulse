#!/bin/bash
# WorkPulse Mac Agent Installer
# Run as: bash installer.sh

set -e

INSTALL_DIR="$HOME/Library/Application Support/WorkPulse"
AGENT_BIN="$INSTALL_DIR/WorkPulse-Agent"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.workpulse.agent.plist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

clear
echo ""
echo "  ================================================"
echo "   WorkPulse Mac Agent Installer v1.0"
echo "  ================================================"
echo ""

# Check if WorkPulse-Agent binary exists next to installer
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Detect architecture and pick correct binary
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  AGENT_BIN_SRC="$SCRIPT_DIR/WorkPulse-Agent-arm64"
else
  AGENT_BIN_SRC="$SCRIPT_DIR/WorkPulse-Agent-arm64"  # arm64 runs on Intel via Rosetta 2
fi

if [ ! -f "$AGENT_BIN_SRC" ]; then
  echo -e "${RED}ERROR: WorkPulse-Agent-arm64 not found in this folder.${NC}"
  exit 1
fi

# ── Server URL ────────────────────────────────────────────────────────────────
echo -n "  Enter WorkPulse server URL: "
read SERVER_URL

if [ -z "$SERVER_URL" ]; then
  echo -e "${RED}ERROR: Server URL cannot be empty${NC}"
  exit 1
fi

# Remove trailing slash
SERVER_URL="${SERVER_URL%/}"

# Add http:// if missing
if [[ "$SERVER_URL" != http* ]]; then
  # Try https first
  if curl -sk --max-time 5 "https://$SERVER_URL" > /dev/null 2>&1; then
    SERVER_URL="https://$SERVER_URL"
  else
    SERVER_URL="http://$SERVER_URL"
  fi
fi

# Check server connection
echo "  Checking server connection..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$SERVER_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "000" ]; then
  echo -e "${RED}ERROR: Cannot reach server at $SERVER_URL${NC}"
  exit 1
fi
echo -e "  ${GREEN}Server connected OK${NC}"

# Machine ID
MACHINE_ID=$(scutil --get ComputerName 2>/dev/null || hostname)
echo "  Machine: $MACHINE_ID"

# ── Employee email ────────────────────────────────────────────────────────────
TOKEN=""
EMAIL_ATTEMPT=0

while [ $EMAIL_ATTEMPT -lt 3 ]; do
  EMAIL_ATTEMPT=$((EMAIL_ATTEMPT + 1))
  echo ""
  echo -n "  Enter employee email address: "
  read EMPLOYEE_EMAIL

  if [ -z "$EMPLOYEE_EMAIL" ]; then
    echo -e "${RED}ERROR: Email cannot be empty${NC}"
    continue
  fi

  echo "  Looking up employee..."
  MACHINE_ID_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$MACHINE_ID'))" 2>/dev/null || echo "$MACHINE_ID" | sed 's/ /%20/g' | sed "s/'/%27/g")
  RESPONSE=$(curl -s --max-time 10 "$SERVER_URL/api/agent/token/$EMPLOYEE_EMAIL?machine_id=$MACHINE_ID_ENC" 2>/dev/null)
  TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$TOKEN" ]; then
    echo -e "${RED}  Employee not found or already assigned.${NC}"
    if [ $EMAIL_ATTEMPT -ge 3 ]; then
      echo -e "${RED}Too many failed attempts. Exiting.${NC}"
      exit 1
    fi
  else
    echo -e "  ${GREEN}Employee found! Token retrieved.${NC}"
    break
  fi
done

# ── Install ───────────────────────────────────────────────────────────────────
echo ""
echo "  Installing to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$PLIST_DIR"

# Copy agent binary
echo "  Copying agent..."
cp -f "$AGENT_BIN_SRC" "$AGENT_BIN"
chmod +x "$AGENT_BIN"

# Remove quarantine flag (Gatekeeper)
xattr -rd com.apple.quarantine "$AGENT_BIN" 2>/dev/null || true

# Write config
echo "  Writing config..."
cat > "$INSTALL_DIR/config.json" << CONFIGEOF
{
  "email": "$EMPLOYEE_EMAIL",
  "token": "$TOKEN",
  "server_url": "$SERVER_URL",
  "machine_id": "$MACHINE_ID"
}
CONFIGEOF

# ── LaunchAgent (auto-start) ──────────────────────────────────────────────────
echo "  Setting up auto-start..."

# Stop existing if running
launchctl unload "$PLIST_FILE" 2>/dev/null || true

cat > "$PLIST_FILE" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.workpulse.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$AGENT_BIN</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/workpulse-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/workpulse-agent-err.log</string>
    <key>WorkingDirectory</key>
    <string>/tmp</string>
</dict>
</plist>
PLISTEOF

# ── Permissions guide ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}  ================================================${NC}"
echo -e "${YELLOW}   IMPORTANT: Two permissions required${NC}"
echo -e "${YELLOW}  ================================================${NC}"
echo ""
echo "  1. ACCESSIBILITY (for app tracking):"
echo "     System Settings → Privacy & Security → Accessibility"
echo "     → Click + → Add WorkPulse-Agent → Enable"
echo ""
echo "  2. SCREEN RECORDING (for screenshots):"
echo "     System Settings → Privacy & Security → Screen Recording"
echo "     → Click + → Add WorkPulse-Agent → Enable"
echo ""
echo "  Opening System Settings now..."
sleep 2
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"

echo ""
echo -n "  Press ENTER after granting both permissions to continue..."
read

# ── Start agent ───────────────────────────────────────────────────────────────
echo "  Starting agent..."
launchctl load "$PLIST_FILE" 2>/dev/null || true
sleep 3

# Check if running
if pgrep -f "WorkPulse-Agent" > /dev/null 2>&1; then
  echo -e "  ${GREEN}Agent Status: RUNNING ✓${NC}"
else
  echo -e "${YELLOW}  Agent will start automatically on next login.${NC}"
  # Try direct start
  "$AGENT_BIN" &
  sleep 2
  if pgrep -f "WorkPulse-Agent" > /dev/null 2>&1; then
    echo -e "  ${GREEN}Agent Status: RUNNING ✓${NC}"
  fi
fi

echo ""
echo "  ================================================"
echo "   Installation Complete!"
echo "  ================================================"
echo ""
echo "   Employee : $EMPLOYEE_EMAIL"
echo "   Server   : $SERVER_URL"
echo "   Machine  : $MACHINE_ID"
echo "   Location : $INSTALL_DIR"
echo "   Log file : $INSTALL_DIR/agent.log"
echo "   Auto-start: LaunchAgent (runs on login)"
echo ""
echo "  To view logs:"
echo "  tail -f ~/Library/Application\ Support/WorkPulse/agent.log"
echo ""
