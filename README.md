# WorkPulse 3.0 — Employee Monitoring Dashboard

> A self-hosted employee activity monitoring system for Windows environments. Tracks web activity, app usage, screenshots, system events and more — from a real-time dashboard.

---

## Features

- **Live Dashboard** — Real-time employee status, active app, idle detection
- **Screenshots** — Automatic periodic screenshots with flagging system; skipped when screen is locked
- **Screenshot Gallery** — Mobile-style drag/swipe gallery with pinch-to-zoom, pan, and smooth slide transitions
- **Web Activity** — Tracks URLs visited per browser with on/off shift breakdown and productivity scoring
- **App Usage** — Time spent per application within shift hours, with donut chart visualization
- **System Activity** — Session-based view: Startup → Shutdown, Wake → Sleep, Lock → Unlock with durations
- **Win+L Detection** — Detects screen lock via LockApp.exe process (no admin rights required)
- **Duty Roster** — Shift assignment with in-shift vs off-shift time tracking
- **Temporary Shift Override** — Set a one-day temp shift for any employee; reflected instantly in all calculations
- **Reports** — Export Excel reports: Employee Summary, Web Activity, App Usage, System Activity — all shift-aware
- **Scheduled Reports** — Auto-generate and email reports daily/weekly/monthly
- **Offline Queue** — Agent stores failed heartbeats locally and retries when internet reconnects
- **Machine Binding** — Each employee email locked to one PC; uninstall.bat releases the binding
- **Backup & Restore** — Full PostgreSQL DB backup + screenshot archive backup/restore
- **Multi-User** — Admin and Monitor (view-only) roles with employee assignment
- **MFA Support** — Email OTP and TOTP authenticator login verification
- **Remember This Device** — Skip re-authentication for 30 days on trusted devices
- **Alert Rules** — Per-admin configurable alert rules with background evaluator and 1-hour dedup
- **Site Categories** — Per-admin domain productivity classification (Productive / Neutral / Non-Productive)
- **Audit Log** — Full admin action logging
- **Dark / Light / System Mode** — Smooth animated theme switching with flash transition
- **Timezone Settings** — Configurable timezone for all date displays and reports
- **Clean URLs** — Login at `/`, dashboard at `/dashboard` — no `.html` in URLs
- **Employee Navigation** — Swipe/arrow key navigation between employee profiles with slide animation
- **Department View** — Employees listed under their department with pill badges
- **Duplicate Email Check** — Server-side and client-side duplicate email detection on employee add
- **Editable Employee Name** — Edit employee name directly from the Settings panel
- **Browser Back Navigation** — Back button navigates page history; overlays close before page navigation
- **Android App** — WebView-based APK with session persistence, swipe navigation, and back-button history

---

## Server Requirements

- Ubuntu 20.04+ (or any Debian-based Linux)
- Node.js 18+
- PostgreSQL 14+
- Nginx (as reverse proxy)
- PM2 (process manager)
- zip (for packaging the Windows agent)

---

## Server Installation

### Step 1 — Update system

```bash
sudo apt update && sudo apt upgrade -y
```

---

### Step 2 — Create WorkPulse system user

> ⚠️ **This step is required.** The agent download path is hardcoded to `/home/workpulse/`. If you skip this and use a different user, the Download Agent button will return "File not found".

```bash
sudo useradd -m -s /bin/bash workpulse
sudo passwd workpulse
sudo usermod -aG sudo workpulse
sudo su - workpulse
```

> 💡 All remaining commands should be run as the `workpulse` user unless specified otherwise.

---

### Step 3 — Install Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

---

### Step 4 — Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

---

### Step 5 — Create database and user

> ⚠️ **Replace `YourStrongPassword` with your own password everywhere below.**

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'YourStrongPassword';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
ALTER DATABASE workpulse OWNER TO workpulse_user;
GRANT ALL ON SCHEMA public TO workpulse_user;
\q
```

> ⚠️ **Important:** Run this AFTER Step 13 (web installer) once all tables are created. Also run if you see "must be owner of table" errors:

```bash
sudo -u postgres psql -d workpulse -c "
ALTER TABLE employees OWNER TO workpulse_user;
ALTER TABLE admins OWNER TO workpulse_user;
ALTER TABLE duty_rosters OWNER TO workpulse_user;
ALTER TABLE web_activity OWNER TO workpulse_user;
ALTER TABLE app_usage OWNER TO workpulse_user;
ALTER TABLE system_events OWNER TO workpulse_user;
ALTER TABLE screenshots OWNER TO workpulse_user;
ALTER TABLE heartbeats OWNER TO workpulse_user;
ALTER TABLE alerts OWNER TO workpulse_user;
ALTER TABLE report_schedules OWNER TO workpulse_user;
ALTER TABLE temp_shift_overrides OWNER TO workpulse_user;
ALTER TABLE report_jobs OWNER TO workpulse_user;
ALTER TABLE email_config OWNER TO workpulse_user;
ALTER TABLE otp_tokens OWNER TO workpulse_user;
ALTER TABLE settings OWNER TO workpulse_user;
ALTER TABLE audit_log OWNER TO workpulse_user;
ALTER TABLE dashboard_users OWNER TO workpulse_user;
ALTER TABLE alert_rules OWNER TO workpulse_user;
ALTER TABLE site_categories OWNER TO workpulse_user;
ALTER TABLE remembered_devices OWNER TO workpulse_user;
ALTER TABLE departments OWNER TO workpulse_user;
"
```

Then restart the app:
```bash
pm2 restart workpulse --update-env
```

---

### Step 6 — Install Nginx

```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

---

### Step 7 — Install PM2

```bash
sudo npm install -g pm2
```

---

### Step 8 — Install zip utility

> Required for packaging the Windows agent ZIP in Step 14.

```bash
sudo apt install -y zip
```

---

### Step 9 — Clone the repository

```bash
cd ~
git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
npm install cookie-parser
```

---

### Step 10 — Configure environment

```bash
nano .env
```

Fill in:

```env
PORT=3000
SESSION_SECRET=paste_any_long_random_string_here
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASSWORD=YourStrongPassword
DB_PASS=YourStrongPassword
NODE_ENV=development
```

> ⚠️ Keep `NODE_ENV=development` until you set up HTTPS/SSL.

> 💡 Generate a strong session secret: `openssl rand -hex 48`

---

### Step 11 — Configure Nginx reverse proxy

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste:

```nginx
server {
    listen 80;
    server_name your-server-ip-or-domain;

    client_max_body_size 500M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Enable the site:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

### Step 12 — Start the application

```bash
cd ~/workpulse-app
pm2 start server.js --name workpulse
pm2 save
pm2 startup
```

---

### Step 13 — Run the web installer

Open your browser and go to:
```
http://your-server-ip-or-domain/install
```

Follow the steps to create your admin account and initialize the database.

---

### Step 14 — Build the Windows agent

> ⚠️ **Important notes:**
> - Install `pkg` with `sudo` — regular user lacks permission to install globally
> - Use `node18` target — `node20` is **not supported** by pkg v5 and will fail
> - First build downloads ~80MB of Node.js binaries (cached for future builds)

**Step 14a — Install pkg:**
```bash
sudo npm install -g pkg
```

**Step 14b — Install agent dependencies and set build script:**
```bash
cd ~/workpulse-app/winagent
npm install
npm pkg set scripts.build="pkg agent.js --targets node18-win-x64 --output dist/WorkPulse-Agent.exe"
```

**Step 14c — Build the exe:**
```bash
mkdir -p dist
npm run build
```

> 💡 Build takes 1–3 minutes on first run. You should see `fetched-v18.x.x-win-x64 [====================] 100%` then the exe appears in `dist/`.

**Step 14d — Copy support files to dist:**
```bash
cp installer.bat dist/
cp uninstall.bat dist/
cp updater.bat dist/
cp launch.vbs dist/
```

**Step 14e — Copy all files to home directory (required for Download Agent button):**
```bash
cd ~/workpulse-app/winagent/dist
cp WorkPulse-Agent.exe ~/
cp installer.bat ~/
cp uninstall.bat ~/
cp updater.bat ~/
cp launch.vbs ~/
```

**Step 14f — Create the ZIP package:**
```bash
cd ~
zip WorkPulse-Agent-Windows.zip WorkPulse-Agent.exe installer.bat uninstall.bat updater.bat launch.vbs
ls -lh WorkPulse-Agent-Windows.zip
```

> ✅ You should see a ~16MB ZIP file. The **Download Agent** button in the dashboard will now work.

---

## Android App

WorkPulse includes an Android APK (`com.novelinfra.workpulse`) that wraps the dashboard in a native WebView with:

- Server URL entry with connection validation
- Session persistence across app restarts (cookie flush)
- Back button history navigation (page by page, not direct exit)
- Exit confirmation toast on dashboard back press
- Swipe left/right between employee profiles
- File download manager
- Change Server button (floating ⚙)

---

## Key Features Guide

### Duty Roster & Shift Tracking

Go to **Admin → Duty Roster** to create shifts. Assign a roster to each employee when adding them. All web, app and system activity is split into **On Shift** and **Off Shift** automatically.

### Temporary Shift Override

Open any employee profile → click **⚡ Set Temp Shift for [date]** → select a roster. This overrides the shift for that date only. An orange dot appears on the calendar for dates with temp overrides.

### Screenshot Gallery

Click any screenshot to open the full-screen gallery. Drag left/right (mouse or touch) to slide between screenshots. Pinch or scroll wheel to zoom. Double-click/tap to zoom in to 2.5x. When zoomed, drag with one finger to pan. Back button closes the gallery.

### Machine Binding

Each employee email is bound to one PC on first install. If an employee changes PC:
1. Run `uninstall.bat` on the old PC (releases binding automatically)
2. Run `installer.bat` on the new PC

If the old PC is unavailable, reset via employee Settings in the dashboard.

### Offline Queue

If the employee's PC loses internet, the agent queues all heartbeats, events and screenshots locally in `C:\WorkPulse\`. When connection is restored, everything syncs automatically.

### Reports

Go to **Reports** to generate or schedule Excel exports. Each report contains 4 sheets:
- **Employee Summary** — Roster, shift hours, first/last seen, web and app on/off shift totals
- **Web Activity** — Per-URL time spent with on/off shift and productivity labels
- **App Usage** — Per-app time spent within shift hours
- **System Activity** — Session-based (Start → End event, duration, in-shift indicator)

---

## Dashboard Configuration

| Setting | Location |
|---------|----------|
| Timezone | Admin → System Settings |
| Email / SMTP | Admin → Email Configuration |
| Screenshot interval | Employees → ⚙ Settings |
| Duty Roster | Admin → Duty Roster |
| Temp shift override | Employee Profile → Set Temp Shift |

---

## Backup & Restore

Go to **Admin → Backup & Restore**:

| Action | Description |
|--------|-------------|
| Download Backup | Full PostgreSQL dump (.wpbackup) |
| Download Screenshots Backup | All screenshot images as .tar.gz |
| Restore Backup | Upload .wpbackup to restore DB |
| Restore Screenshots | Upload .tar.gz to restore images |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Frontend | Vanilla JS + CSS |
| Agent | Node.js + pkg (compiled .exe, node18-win-x64) |
| Android | Java + WebView (API 24+) |
| Web Server | Nginx |
| Process Manager | PM2 |
| Auth | express-session + bcryptjs + cookie-parser |
| Remember Device | `remembered_devices` table + 30-day cookie |
| Reports | ExcelJS |
| Email | Nodemailer |
| TOTP | speakeasy |

---

## Folder Structure

```
workpulse-app/
├── public/            # Dashboard HTML, login page, installer page
├── winagent/          # Windows agent source
│   ├── agent.js       # Main agent script
│   ├── installer.bat
│   ├── uninstall.bat
│   ├── updater.bat
│   ├── launch.vbs
│   └── dist/          # Compiled files (after Step 14)
│       ├── WorkPulse-Agent.exe
│       ├── installer.bat
│       ├── updater.bat
│       ├── uninstall.bat
│       └── launch.vbs
├── screenshots/       # Screenshot storage (gitignored)
├── backups/           # Backups (gitignored)
├── db.js              # PostgreSQL connection pool
├── install.js         # Web installer route
├── server.js          # Main Express server
└── .env               # Environment config (gitignored)
```

> 💡 Files in `~/` (home directory) — `WorkPulse-Agent.exe`, `WorkPulse-Agent-Windows.zip` etc. — are served by the Download Agent button. Keep them in sync with `winagent/dist/` after each rebuild.

---

## Troubleshooting

### Signed out immediately after login
**Cause:** `NODE_ENV=production` requires HTTPS.
**Fix:** Set `NODE_ENV=development` in `.env` until SSL is configured.

### Database connection error: client password must be a string
**Fix:** Ensure both `DB_PASSWORD` and `DB_PASS` are in `.env`.

### DutyRoster Init error: must be owner of table employees
**Fix:** Run the table ownership commands from Step 5.

### Download Agent shows "File not found"
**Cause:** Agent not built yet, or files not copied to `~/`.
**Fix:** Complete Step 14 fully. If using a non-`workpulse` user:
```bash
sed -i "s|/home/workpulse/|${HOME}/|g" ~/workpulse-app/server.js
pm2 restart workpulse --update-env
```

### pkg install fails with "EACCES: permission denied"
**Cause:** Global npm install requires elevated permissions.
**Fix:**
```bash
sudo npm install -g pkg
```

### pkg build error: "No available node version satisfies 'node20'"
**Cause:** pkg v5 does not support node20 target.
**Fix:** Use node18:
```bash
npm pkg set scripts.build="pkg agent.js --targets node18-win-x64 --output dist/WorkPulse-Agent.exe"
npm run build
```

### Agent shows "This app can't run on your PC"
**Fix:** Run as Administrator on the employee PC:
```cmd
powershell -Command "Unblock-File -Path 'C:\WorkPulse\WorkPulse-Agent.exe'"
powershell -Command "Add-MpPreference -ExclusionPath 'C:\WorkPulse\'"
```
New installs via `installer.bat` handle this automatically.

### Employee email blocked: "already monitored on another PC"
**Fix:** Run `uninstall.bat` on the old PC first. If unavailable, reset via employee Settings in the dashboard.

### Agent shows offline after employee was deleted and re-added
**Cause:** Deleting an employee generates a new agent token. The PC still has the old token.
**Fix:**
1. Get the new token:
```bash
psql -h localhost -U workpulse_user -d workpulse -c "SELECT agent_token FROM employees WHERE email='employee@company.com';"
```
2. On the Windows PC open `C:\WorkPulse\config.json` in Notepad and replace the `token` value
3. Restart the agent via Task Scheduler:
```cmd
schtasks /end /tn "WorkPulseAgent"
schtasks /run /tn "WorkPulseAgent"
```

### Certbot fails: "Could not bind to IPv4 or IPv6"
**Fix:**
```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d your-domain.com
sudo systemctl start nginx
```

### SSL certificate not renewing
```bash
sudo certbot renew --dry-run
sudo systemctl status certbot.timer
sudo systemctl enable certbot.timer && sudo systemctl start certbot.timer
```

### Remember device not working
**Fix:**
```bash
cd ~/workpulse-app && npm install cookie-parser
pm2 restart workpulse --update-env
```

---

## Changelog

### v3.0 (April 2026)
- **UI Redesign** — Softer color palette, reduced eye strain in both themes
- **Smooth Theme Switching** — Animated flash transition between dark/light/system modes
- **Screenshot Gallery** — Full-screen drag/swipe gallery with pinch-to-zoom, pan, double-tap zoom
- **Employee Navigation** — Arrow key, swipe, and button navigation between profiles with slide animation
- **Browser Back Navigation** — Back button navigates page history; overlays close first; dashboard shows toast
- **Android Back Navigation** — Back button navigates via JS bridge; exit toast on dashboard
- **Sidebar Redesign** — Bolder nav text, theme-aware colors, section dividers
- **Department Employees** — Employees listed under department with colored pill badges
- **Duplicate Email Detection** — Server-side check prevents overwriting active employees
- **Editable Employee Name** — Edit name from Settings panel via `/api/employees/:id/name`
- **Alert Badge** — Loads immediately on login, updates every 15 seconds
- **Page Animations** — Fade/slide transitions, staggered card loads, shimmer loading state
- **Calendar Dropdown Fix** — Positions relative to button, z-index:99999, always fully visible
- **Installer Fix** — Added `agent_version`, `machine_id`, `remembered_devices`; fixed `alert_rules` schema
- **Agent Build Fix** — Added `pkg` build script; use `node18` target (node20 not supported by pkg v5)
- **Bug Fix** — Alert rule query: `taken_at` → `recorded_at`
- **Bug Fix** — `/dashboard` route publicly accessible; auth handled client-side
- **Bug Fix** — Adding existing active employee now returns error instead of overwriting

### v2.7.2 (April 2026)
- **Remember This Device** — 30-day persistent login cookie
- **Clean URLs** — Login at `/`, dashboard at `/dashboard`

### v2.7.1 (April 2026)
- **Mobile Responsive** — Full mobile layout with slide-over sidebar
- **Custom Alert Rules** — Per-admin alert rules with background evaluator
- **Site Categories** — Domain productivity classification

### v2.7.0 (April 2026)
- **Temporary Shift Override** — One-day shift override per employee
- **Machine Binding** — Employee email locked to one PC
- **Offline Queue** — Failed data queued locally and synced on reconnect
- **Agent v2.6.5** — DPI-aware screenshots, 24hr event backfill

### v2.2 (April 2026)
- System Settings, timezone, URL tracking via browser extension

### v2.1 (April 2026)
- Screenshot backup/restore, Excel reports, Email OTP/MFA, forgot password

### v2.0
- Duty Roster, App Usage charts, Dark/Light mode, Multi-user support

### v1.0
- Initial release

---

## License

Proprietary — All rights reserved. Not for redistribution.
