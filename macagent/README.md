# WorkPulse Mac Agent v1.0.0

macOS monitoring agent for WorkPulse — mirrors the Windows agent for Mac devices.

## What It Tracks

| Feature | Details |
|---|---|
| Active App | Via AppleScript (`System Events`) |
| Browser URLs | Safari, Chrome, Edge, Firefox, Arc, Brave |
| App Usage | Time spent per app |
| Heartbeat | Every 20 seconds |
| Screenshots | Via `screencapture` command |
| Idle Detection | Via `ioreg HIDIdleTime` |
| Lock/Unlock | Detected via CGSSessionScreenIsLocked |
| Sleep/Wake | Via system log |
| Auto-start | LaunchAgent plist |
| Offline Queue | JSON file, retries on reconnect |

---

## Build (on a Mac)

```bash
npm install
npm run build          # builds both Intel (x64) and Apple Silicon (arm64)
npm run build-x64      # Intel only
npm run build-arm64    # Apple Silicon only
```

This produces `WorkPulse-Agent` (or `WorkPulse-Agent-arm64`) binary using `pkg`.

---

## Install

```bash
bash installer.sh
```

The installer will:
1. Ask for server URL + employee email
2. Fetch agent token from server
3. Copy binary to `~/Library/Application Support/WorkPulse/`
4. Write `config.json`
5. Create LaunchAgent plist for auto-start
6. Open System Settings for permissions
7. Start the agent

---

## Required Permissions (one-time)

Both must be granted manually by the user:

**1. Accessibility**
`System Settings → Privacy & Security → Accessibility → Add WorkPulse-Agent`

**2. Screen Recording**
`System Settings → Privacy & Security → Screen Recording → Add WorkPulse-Agent`

---

## File Locations

```
~/Library/Application Support/WorkPulse/
├── WorkPulse-Agent     ← binary
├── config.json         ← server URL + token
├── agent.log           ← live log
├── offline_queue.json  ← queued heartbeats
└── pending_screenshots/← queued screenshots
```

Auto-start plist:
```
~/Library/LaunchAgents/com.workpulse.agent.plist
```

---

## View Logs

```bash
tail -f ~/Library/Application\ Support/WorkPulse/agent.log
```

---

## Uninstall

```bash
bash uninstaller.sh
```

---

## Differences from Windows Agent

| Feature | Windows | Mac |
|---|---|---|
| Active window | PowerShell + Win32 API | AppleScript |
| System events | Windows Event Log | `log show` command |
| Screenshot | GDI BitBlt | `screencapture` |
| Auto-start | Registry Run key | LaunchAgent plist |
| Config location | `C:\WorkPulse\` | `~/Library/Application Support/WorkPulse/` |
| Idle time | Win32 `GetLastInputInfo` | `ioreg HIDIdleTime` |
| Lock detection | LockApp/LogonUI process | CGSSessionScreenIsLocked |
