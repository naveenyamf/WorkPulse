#!/bin/bash
# WorkPulse Mac Agent Uninstaller

INSTALL_DIR="$HOME/Library/Application Support/WorkPulse"
PLIST_FILE="$HOME/Library/LaunchAgents/com.workpulse.agent.plist"

echo ""
echo "  ================================================"
echo "   WorkPulse Mac Agent Uninstaller"
echo "  ================================================"
echo ""
echo -n "  Are you sure you want to uninstall? (yes/no): "
read CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "  Cancelled."
  exit 0
fi

echo "  Stopping agent..."
launchctl unload "$PLIST_FILE" 2>/dev/null || true
pkill -f "WorkPulse-Agent" 2>/dev/null || true

echo "  Removing files..."
rm -f "$PLIST_FILE"
rm -rf "$INSTALL_DIR"

echo ""
echo "  WorkPulse Agent uninstalled successfully."
echo ""
