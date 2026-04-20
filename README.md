# WorkPulse 2.0 — Employee Monitoring Dashboard

> A self-hosted employee activity monitoring system for Windows environments. Tracks web activity, app usage, screenshots, system events and more — from a real-time dashboard.

---

## Features

- **Live Dashboard** — Real-time employee status, active app, idle detection
- **Screenshots** — Automatic periodic screenshots with flagging system; skipped when screen is locked
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
- **Remember This Device** — Skip re-authentication for 30 days on trusted devices (works with password-only, OTP, and TOTP)
- **Alert Rules** — Per-admin configurable alert rules with background evaluator and 1-hour dedup
- **Site Categories** — Per-admin domain productivity classification (Productive / Neutral / Non-Productive)
- **Audit Log** — Full admin action logging
- **Dark / Light Mode** — System-aware theme with manual override
- **Timezone Settings** — Configurable timezone for all date displays and reports
- **Clean URLs** — Login at `/`, dashboard at `/dashboard` — no `.html` in URLs

---

## Server Requirements

- Ubuntu 20.04+ (or any Debian-based Linux)
- Node.js 18+
- PostgreSQL 14+
- Nginx (as reverse proxy)
- PM2 (process manager)

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

> ⚠️ **Replace `YourStrongPassword` with your own password everywhere below. Use the same password in all places.**

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

> ⚠️ **Important:** Run this AFTER Step 12 (web installer) once all tables are created. Also run if you see "must be owner of table" errors:

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

### Step 8 — Clone the repository

> Make sure you are logged in as `workpulse` user before running:

```bash
cd ~
git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
npm install cookie-parser
```

---

### Step 9 — Configure environment

```bash
nano .env
```

Fill in — **replace `YourStrongPassword` with the same password you used in Step 4:**

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

### Step 10 — Configure Nginx reverse proxy

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste this — **replace `your-server-ip-or-domain` with your actual IP or domain:**

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
sudo nginx -t && sudo systemctl reload nginx
```

---

### Step 10b — Install SSL with Certbot (HTTPS)

> ⚠️ **Required for production.** Do this only after your domain DNS is pointed to this server and the HTTP site is working.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot will:
1. Automatically detect your Nginx config
2. Obtain a free Let's Encrypt certificate
3. Rewrite your Nginx config to serve HTTPS on port 443
4. Set up HTTP → HTTPS redirect automatically

After Certbot completes, your Nginx config will look like:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
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

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

**Switch app to production mode after SSL is working:**

```bash
nano /home/workpulse/workpulse-app/.env
```

Change:
```env
NODE_ENV=production
```

Then restart:
```bash
pm2 restart workpulse --update-env
```

**Auto-renew certificates** (Let's Encrypt certs expire every 90 days — Certbot sets up auto-renewal automatically):

```bash
# Test renewal works
sudo certbot renew --dry-run

# Check auto-renew timer is active
sudo systemctl status certbot.timer
```

---

### Step 11 — Start the application

```bash
cd ~/workpulse-app
pm2 start server.js --name workpulse
pm2 save
pm2 startup
```

Follow the command PM2 prints to enable auto-start on reboot.

---

### Step 12 — Run the web installer

Open your browser and go to:

```
http://your-server-ip/install
```

The wizard will walk you through:
1. Enter your DB connection details and test the connection
2. Choose **Fresh Install**
3. Create your root admin account (name, email, password)
4. All tables and default data are created automatically

After the wizard completes, restart the server:

```bash
pm2 restart workpulse --update-env
```

Then open `http://your-server-ip` and sign in with the admin account you just created.

> ⚠️ Now run the table ownership fix from Step 5 if you haven't already.

---

### Step 13 — Build the Windows Agent

```bash
sudo apt install -y zip

cd ~/workpulse-app/winagent
npm install
npx pkg . --targets node18-win-x64 --output ~/workpulse-app/winagent/dist/WorkPulse-Agent.exe

cp ~/workpulse-app/winagent/dist/WorkPulse-Agent.exe ~/WorkPulse-Agent.exe

mkdir -p /tmp/wp_dist
cp ~/workpulse-app/winagent/dist/WorkPulse-Agent.exe /tmp/wp_dist/
cp ~/workpulse-app/winagent/dist/installer.bat /tmp/wp_dist/
cp ~/workpulse-app/winagent/dist/updater.bat /tmp/wp_dist/
cp ~/workpulse-app/winagent/dist/uninstall.bat /tmp/wp_dist/
cd /tmp/wp_dist && zip ~/WorkPulse-Agent-Windows.zip *
rm -rf /tmp/wp_dist

echo "✓ Agent built successfully"
ls -lh ~/WorkPulse-Agent-Windows.zip
```

---

## Agent Setup (Employee Windows PCs)

### Step 1 — Add the employee in dashboard

1. Login to the dashboard
2. Go to **Admin → Add Employee for Monitoring**
3. Fill in name, email, department and duty roster → Click **Add Employee**
4. Copy the agent token shown

### Step 2 — Download the agent

From the dashboard sidebar, click **⤓ Download Agent** — downloads `WorkPulse-Agent-Windows.zip`.

### Step 3 — Install on employee PC

1. Extract the ZIP on the employee's Windows PC
2. **Right-click** `installer.bat` → **Run as Administrator**
3. Enter the WorkPulse server URL (e.g. `https://monitoring.company.com`)
4. Enter the employee's email address
5. The installer will:
   - Fetch the agent token from the server
   - Check if the email is already registered on another PC (blocked if so)
   - Install to `C:\WorkPulse\`
   - Unblock the EXE and add Windows Defender exclusion
   - Register with Task Scheduler for silent startup
   - Start the agent immediately (no visible window)

### Step 4 — Verify in dashboard

Within 1–2 minutes the employee appears as **Active** in the Employees list with their agent version.

### Updating the agent

Run `updater.bat` as Administrator on the employee PC. It reads the server URL from config automatically and downloads the latest agent.

### Uninstalling the agent

Run `uninstall.bat` as Administrator. Type **YES** to confirm. This:
- Stops the agent
- Removes Task Scheduler entry and startup registry keys
- Removes Windows Defender exclusion
- **Releases the machine binding** on the server (employee can be reinstalled on a new PC)
- Deletes all files from `C:\WorkPulse\`

---

## Browser Extension — Required for URL Tracking

> Without this extension, only page titles are captured instead of real URLs.

### Install on Chrome / Edge

[URL in Title — Chrome Web Store](https://chromewebstore.google.com/detail/url-in-title/ignpacbgnbnkaiooknalneoeladjnfgb)

### Configure the extension

1. Click the extension icon → **Options**
2. Set the title format to: `{url} | {title}`
3. Click **Save**

---

## Key Features Guide

### Duty Roster & Shift Tracking

Go to **Admin → Duty Roster** to create shifts. Assign a roster to each employee when adding them. All web, app and system activity is split into **On Shift** and **Off Shift** automatically.

### Temporary Shift Override

Open any employee profile → click **⚡ Set Temp Shift for [date]** → select a roster. This overrides the shift for that date only. An orange dot appears on the calendar for dates with temp overrides. All calculations update instantly.

### Machine Binding

Each employee email is bound to one PC on first install. If an employee changes PC:
1. Run `uninstall.bat` on the old PC (releases binding automatically)
2. Run `installer.bat` on the new PC

If the old PC is unavailable, an admin can reset the binding via the employee Settings panel.

### Offline Queue

If the employee's PC loses internet, the agent queues all heartbeats, events and screenshots locally in `C:\WorkPulse\`. When connection is restored, everything syncs automatically.

### Reports

Go to **Reports** to generate or schedule Excel exports. Each report contains 4 sheets:
- **Employee Summary** — Roster, shift hours, first/last seen, web and app on/off shift totals
- **Web Activity** — Per-URL time spent with on/off shift and productivity labels
- **App Usage** — Per-app time spent within shift hours
- **System Activity** — Session-based (Start → End event, duration, in-shift indicator)

Temp shift overrides are reflected in all report sheets with amber highlighting.

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
| Agent | Node.js + PowerShell + BAT (v2.6.5) |
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
│   ├── agent.js       # Main agent script (v2.6.5)
│   ├── dist/          # Compiled agent + installer files
│   │   ├── WorkPulse-Agent.exe
│   │   ├── installer.bat
│   │   ├── updater.bat
│   │   └── uninstall.bat
├── screenshots/       # Screenshot storage (gitignored)
├── backups/           # Backups (gitignored)
├── db.js              # PostgreSQL connection pool
├── install.js         # Web installer route
├── server.js          # Main Express server
└── .env               # Environment config (gitignored)
```

---

## Troubleshooting

### Signed out immediately after login
**Cause:** `NODE_ENV=production` requires HTTPS. **Fix:** Set `NODE_ENV=development` in `.env` until SSL is configured.

### Database connection error: client password must be a string
**Fix:** Ensure both `DB_PASSWORD` and `DB_PASS` are in `.env`.

### DutyRoster Init error: must be owner of table employees
**Fix:** Run the table ownership commands from Step 5.

### Download Agent shows "File not found"
**Fix:** Build the agent (Step 13). If using a non-`workpulse` user:
```bash
sed -i "s|/home/workpulse/|${HOME}/|g" ~/workpulse-app/server.js
pm2 restart workpulse --update-env
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

### Certbot fails: "Could not bind to IPv4 or IPv6"
**Cause:** Nginx is using port 80. Certbot needs it temporarily.
**Fix:**
```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d your-domain.com
sudo systemctl start nginx
# Then manually update Nginx config with the cert paths
```

### SSL certificate not renewing
```bash
sudo certbot renew --dry-run
sudo systemctl status certbot.timer
# If timer missing:
sudo systemctl enable certbot.timer && sudo systemctl start certbot.timer
```

### Signed out immediately after login (production)
**Cause:** `NODE_ENV=production` requires HTTPS cookies. If you're on HTTP, sessions won't persist.
**Fix:** Either set up SSL (Step 10b) or keep `NODE_ENV=development` until SSL is ready.

### Remember device not working
**Cause:** `cookie-parser` not installed or `NODE_ENV=production` with HTTP (cookies need HTTPS in production mode).
**Fix:**
```bash
cd ~/workpulse-app && npm install cookie-parser
pm2 restart workpulse --update-env
```
If on HTTPS, make sure `NODE_ENV=production` is set in `.env`.

---

## Changelog

### v2.7.2 (April 2026)
- **Remember This Device** — 30-day persistent login cookie; works for password-only, OTP, and TOTP flows; logout clears cookie and DB record
- **Clean URLs** — Login served at `/`, dashboard at `/dashboard`; no `.html` extensions in URLs
- **Installer fix** — Added missing tables to web installer: `report_schedules`, `alert_rules`, `site_categories`, `settings`, `temp_shift_overrides`, `report_jobs`
- **cookie-parser** — Added as dependency for remember-device cookie handling

### v2.7.1 (April 2026)
- **Mobile Responsive** — Full mobile layout with slide-over sidebar, hamburger menu
- **Custom Alert Rules** — Per-admin alert rules: web activity, app usage, login time, idle, screenshots, system events
- **Site Categories** — Per-admin domain productivity classification (Productive/Neutral/Non-Productive)
- **Alert Evaluator** — Background rule evaluation every 5 minutes with 1-hour dedup
- **Reports for all users** — Non-admin users can queue and schedule reports
- **System Settings for all users** — Non-admin users can manage their own TOTP authenticator
- **App Usage fix** — Accurate in-shift/off-shift calculation with shift duration cap
- **Web Activity fix** — Per-URL accurate in-shift seconds using effective roster (temp override aware)
- **Installer v2.6** — Silent VBS launcher, 3-attempt email retry, Task Scheduler auto-start, no CMD window
- **agent.log cleanup** — Removed CLIXML PowerShell noise from log

### v2.7.0 (April 2026)
- **Temporary Shift Override** — Set a one-day shift override per employee; all calculations update instantly; orange calendar dot indicator
- **Machine Binding** — Employee email locked to one PC on install; uninstall.bat releases binding automatically
- **Session-based System Activity** — Events grouped into Start→End sessions with duration; shown on dashboard and in reports
- **Win+L Lock Detection** — Detects screen lock via LockApp.exe process polling (no admin rights required); skips screenshots and URL tracking while locked
- **Offline Queue** — Failed heartbeats/events queued locally; pending screenshots retried on reconnect
- **Redesigned Reports** — 4-sheet Excel export: Employee Summary, Web Activity, App Usage, System Activity; all shift-aware with temp override support; amber highlighting for temp shift rows
- **Scheduled Reports** — Configurable report range (Yesterday/Last 7 Days/Last 30 Days/Last 3 Months/Last 6 Months/1 Year)
- **Agent v2.6.5** — DPI-aware screenshots (fixes laptop scaling), 24hr event backfill on startup, 6-hour periodic backfill, silent startup via Task Scheduler
- **Add Employee form** — Mandatory fields: name, email, department, duty roster; email format validation; duplicate email/machine checks
- **Web/App Activity default to today** — All monitoring pages default to current date on load
- **All-employees view** — When a date is selected, all employees shown on one page (no pagination)

### v2.2 (April 2026)
- System Settings page (timezone, theme)
- All calendars timezone-aware
- URL tracking via URL in Title extension
- Admin users separated from Monitor users

### v2.1 (April 2026)
- Screenshot backup and restore
- Excel report export
- Email OTP / MFA login
- Forgot password flow
- Audit log improvements

### v2.0
- Duty Roster with shift tracking
- App Usage donut charts
- System Activity log
- Dark / Light mode
- Multi-user support
- Flagged screenshots

### v1.0
- Initial release

---

## License

Proprietary — All rights reserved. Not for redistribution.
