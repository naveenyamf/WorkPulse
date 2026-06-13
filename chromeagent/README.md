# WorkPulse Chromebook Agent

Chrome Extension agent for WorkPulse — mirrors the Windows agent for Chromebook devices.

## What It Tracks

| Feature             | Details                                      |
|---------------------|----------------------------------------------|
| Web Activity        | URLs + time spent per domain                 |
| App Usage           | Maps domains → app names (Gmail, Teams, etc.)|
| Heartbeat           | Online/idle status every minute              |
| Screenshots         | Visible tab capture (respects schedule)      |
| Idle Detection      | Via `chrome.idle` API (5min threshold)       |
| Startup/Shutdown    | Chrome start/suspend events                  |
| Offline Queue       | Buffers data and retries when back online    |

---

## Installation

### Option A — Manual (Single Device)

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `workpulse-chromebook-agent` folder
5. Click the WorkPulse icon in the toolbar
6. Enter your **Server URL** and **Employee Email**
7. Click **Connect** — done!

---

### Option B — Google Admin Console (Managed Chromebooks, Recommended)

1. Zip the extension folder → upload to your web server or Google Drive (get a public URL)
2. Go to [admin.google.com](https://admin.google.com)
3. Navigate to: **Devices → Chrome → Apps & Extensions → Users & Browsers**
4. Click **+** → **Add Chrome app or extension by ID**
5. Or use **Force install from URL** with your extension ZIP URL
6. Set **Installation policy** → **Force install**
7. This silently deploys to all managed Chromebooks — no user action needed

---

## How It Connects (Same as Windows Installer)

The extension calls the same endpoint as `installer.bat`:

```
GET /api/agent/token/{email}?machine_id={id}
```

Returns a token → stored in `chrome.storage.local` → sent as `x-agent-token` header on all API calls.

---

## API Endpoints Used

All identical to the Windows agent:

| Endpoint                    | When                          |
|-----------------------------|-------------------------------|
| `POST /api/agent/heartbeat` | Every 1 minute                |
| `POST /api/agent/screenshot`| Per `screenshotInterval` mins |
| `POST /api/agent/system-event` | Startup, shutdown, idle    |
| `GET  /api/agent/settings`  | Every 5 minutes               |
| `GET  /api/agent/token/:email` | On first setup             |

---

## App Name Mapping

The extension maps URLs to app names matching your Windows agent format:

- `mail.google.com` → **Gmail**
- `teams.microsoft.com` → **Microsoft Teams**
- `zoom.us` → **Zoom**
- `docs.google.com` → **Google Docs**
- `github.com` → **GitHub**
- *(unknown)* → domain name (e.g. `mycompany.com`)

To add more mappings, edit `APP_MAP` in `background.js`.

---

## Offline Behaviour

Same as Windows agent — if the server is unreachable, all events are queued in `chrome.storage.local` and retried every 2 minutes automatically.

---

## Files

```
workpulse-chromebook-agent/
├── manifest.json     — Extension config (Manifest V3)
├── background.js     — Service worker (core agent logic)
├── popup.html        — Extension popup UI
├── popup.js          — Popup logic (connect / status)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
