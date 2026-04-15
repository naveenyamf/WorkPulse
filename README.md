# WorkPulse 2.0 — Employee Monitoring Dashboard

> A self-hosted employee activity monitoring system for Windows environments. Tracks web activity, app usage, screenshots, system events and more — from a real-time dashboard.

---

## Features

- **Live Dashboard** — Real-time employee status, active app, idle detection
- **Screenshots** — Automatic periodic screenshots with flagging system
- **Web Activity** — Tracks URLs visited per browser with productivity scoring
- **App Usage** — Time spent per application with donut chart visualization
- **System Events** — Startup, shutdown, lock, unlock, sleep, wakeup events
- **Duty Roster** — Shift assignment with in-shift vs off-shift time tracking
- **Reports** — Export Excel reports (Summary, Web Activity, App Usage, Daily Breakdown)
- **Backup & Restore** — Full PostgreSQL DB backup + screenshot archive backup/restore
- **Multi-User** — Admin and Monitor (view-only) roles with employee assignment
- **MFA Support** — Email OTP login verification
- **Audit Log** — Full admin action logging
- **Dark / Light Mode** — System-aware theme with manual override
- **Timezone Settings** — Configurable timezone for all date displays

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

### Step 2 — Install Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### Step 3 — Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

Create database and user:

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'your_strong_password';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
ALTER DATABASE workpulse OWNER TO workpulse_user;
\q
```

### Step 4 — Install Nginx

```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### Step 5 — Install PM2

```bash
sudo npm install -g pm2
```

### Step 6 — Clone the repository

```bash
cd /home/workpulse
git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
```

### Step 7 — Configure environment

```bash
nano .env
```

Fill in:

```env
PORT=3000
SESSION_SECRET=your_random_long_secret_here
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASSWORD=your_strong_password
NODE_ENV=production
```

### Step 8 — Configure Nginx reverse proxy

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste this:

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

    location /screenshots/ {
        alias /home/workpulse/workpulse-app/screenshots/;
        expires 7d;
        add_header Cache-Control "public";
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 9 — Start the application

```bash
cd /home/workpulse/workpulse-app
pm2 start server.js --name workpulse
pm2 save
pm2 startup
```

Follow the command PM2 outputs to enable auto-start on reboot.

### Step 10 — Run the web installer

Open your browser and go to:

```
http://your-server-ip/install
```

Follow the setup wizard to create your admin account and initialize the database.

> After setup is complete, the installer is automatically disabled for security.

---

## Agent Setup (Employee Windows PCs)

### Step 1 — Add the employee in dashboard

1. Login to dashboard at `http://your-server-ip`
2. Go to **Admin → Add Agents to Monitor**
3. Fill in employee name and email → Click **Add Employee**

### Step 2 — Download the installer

From the dashboard sidebar, click **Download Agent** — this downloads `installer.bat`.

### Step 3 — Run the installer on employee PC

1. Copy `installer.bat` to the employee Windows PC
2. **Right-click** → **Run as Administrator**
3. Enter the WorkPulse server URL when prompted
4. Enter the employee email address
5. The installer will automatically:
   - Fetch the agent token from the server
   - Install the agent to `C:\WorkPulse\`
   - Add to Windows startup (runs silently on every login)
   - Start the agent immediately

### Step 4 — Verify in dashboard

Within 1-2 minutes the employee should appear as **Active** in the dashboard.

### Updating the agent

Run `updater.bat` as Administrator on the employee PC. Downloads latest version and restarts automatically.

### Uninstalling the agent

Run `uninstall.bat` as Administrator. Stops agent, removes all files and startup entries.

---

## Browser Extension — Required for URL Tracking

> Without this extension, only page titles are captured instead of real URLs.

### Install on Chrome

[URL in Title — Chrome Web Store](https://chromewebstore.google.com/detail/url-in-title/ignpacbgnbnkaiooknalneoeladjnfgb)

### Install on Edge

Visit the same link above in Microsoft Edge. Click **Allow extensions from other stores** if prompted.

### Configure the extension

After installing:
1. Click the extension icon in the browser toolbar
2. Go to **Options**
3. Set the title format to: `{url} | {title}`
4. Click **Save**

Once configured, the agent extracts real domains automatically.

---

## Dashboard Configuration

### Timezone
Go to **Admin → System Settings** → select timezone → **Save**. Affects all calendars, logs and reports.

### Email / MFA
Go to **Admin → Email Configuration** to set up SMTP for forgot password and MFA login.

### Screenshot Interval
Go to **Employees** → **Settings** on any employee to set screenshot interval, data retention, roster and department.

### Duty Roster
Go to **Admin → Duty Roster** to create shifts and assign employees. Shows in-shift vs off-shift breakdowns in Web Activity.

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
| Agent | Node.js + PowerShell + BAT |
| Web Server | Nginx |
| Process Manager | PM2 |
| Auth | express-session + bcryptjs |
| Reports | ExcelJS |
| Email | Nodemailer |

---

## Folder Structure

```
workpulse-app/
├── public/            # Dashboard HTML, login page
├── winagent/          # Windows agent files
│   ├── agent.js       # Main agent script
│   ├── installer.bat  # Agent installer for employee PCs
│   ├── uninstall.bat  # Agent uninstaller
│   ├── updater.bat    # Agent updater
│   └── launch.vbs     # Silent launcher
├── screenshots/       # Screenshot storage (gitignored)
├── backups/           # Backups (gitignored)
├── db.js              # PostgreSQL connection
├── install.js         # Web installer
├── server.js          # Main Express server
└── .env               # Environment config (gitignored)
```

---

## Changelog

### v2.2 (April 2026)
- System Settings page (timezone, company name, date format, theme)
- All calendars timezone-aware
- URL tracking via URL in Title extension
- Admin users separated from Monitor users
- GitHub cleanup

### v2.1 (April 2026)
- Screenshot backup and restore
- Excel report export
- Email OTP / MFA login
- Forgot password
- Audit log

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
