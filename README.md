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

---

### Step 2 — Create WorkPulse system user

> ⚠️ **This step is required.** The agent download path is hardcoded to `/home/workpulse/`. If you skip this and use a different user, the Download Agent button will return "File not found".

```bash
sudo useradd -m -s /bin/bash workpulse
sudo passwd workpulse
```

Set a strong password when prompted. Then switch to that user for all remaining steps:

```bash
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

> Make sure you are logged in as `workpulse` user (`sudo su - workpulse`) before running:

```bash
cd ~
git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
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

> ⚠️ Keep `NODE_ENV=development` until you set up HTTPS/SSL. With `production`, session cookies require HTTPS and you will be signed out immediately on plain HTTP. Switch to `production` only after SSL is configured.

> 💡 For `SESSION_SECRET`, use any long random string — e.g. open a new terminal and run: `openssl rand -hex 48`

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

After the wizard completes, restart the server to load the new `.env`:

```bash
pm2 restart workpulse --update-env
```

Then open `http://your-server-ip` and sign in with the admin account you just created.

---

### Step 13 — Build the Windows Agent

The agent installer must be compiled on the server before employees can download it.

```bash
# Install required tools
sudo apt install -y zip

# Compile the agent executable
cd ~/workpulse-app/winagent
npm install
npx pkg . --targets node18-win-x64 --output ~/workpulse-app/winagent/dist/WorkPulse-Agent.exe

# Copy EXE to home directory
cp ~/workpulse-app/winagent/dist/WorkPulse-Agent.exe ~/WorkPulse-Agent.exe

# Package into ZIP using full paths (prevents "file not found" errors)
zip -j ~/WorkPulse-Agent-Windows.zip \
    ~/WorkPulse-Agent.exe \
    ~/workpulse-app/winagent/installer.bat \
    ~/workpulse-app/winagent/updater.bat \
    ~/workpulse-app/winagent/uninstall.bat

echo "✓ Agent built successfully"
ls -lh ~/WorkPulse-Agent-Windows.zip
```

> ✅ If you created the `workpulse` user in Step 2 and ran all commands as that user, no path changes are needed — the server will find the ZIP automatically at `/home/workpulse/`.

> ⚠️ If you are running as a user other than `workpulse` (e.g. `novel`, `ubuntu`), update the agent path in `server.js`:
> ```bash
> sed -i "s|/home/workpulse/|${HOME}/|g" ~/workpulse-app/server.js
> pm2 restart workpulse --update-env
> ```

---

## Agent Setup (Employee Windows PCs)

### Step 1 — Add the employee in dashboard

1. Login to dashboard at `http://your-server-ip`
2. Go to **Admin → Add Agents to Monitor**
3. Fill in employee name and email → Click **Add Employee**

### Step 2 — Download the agent

From the dashboard sidebar, click **⤓ Download Agent** — downloads `WorkPulse-Agent-Windows.zip`.

### Step 3 — Run on employee PC

1. Extract the ZIP on the employee's Windows PC
2. **Right-click** `installer.bat` → **Run as Administrator**
3. Enter the WorkPulse server URL when prompted (e.g. `http://your-server-ip`)
4. Enter the employee's email address
5. The installer automatically:
   - Fetches the agent token from the server
   - Installs to `C:\WorkPulse\`
   - Adds to Windows startup (runs silently on every login)
   - Starts the agent immediately

### Step 4 — Verify in dashboard

Within 1–2 minutes the employee appears as **Active** in the dashboard.

### Updating the agent

Run `updater.bat` as Administrator on the employee PC.

### Uninstalling the agent

Run `uninstall.bat` as Administrator.

---

## Browser Extension — Required for URL Tracking

> Without this extension, only page titles are captured instead of real URLs.

### Install on Chrome

[URL in Title — Chrome Web Store](https://chromewebstore.google.com/detail/url-in-title/ignpacbgnbnkaiooknalneoeladjnfgb)

### Install on Edge

Visit the same link in Microsoft Edge. Click **Allow extensions from other stores** if prompted.

### Configure the extension

1. Click the extension icon in the browser toolbar
2. Go to **Options**
3. Set the title format to: `{url} | {title}`
4. Click **Save**

---

## Dashboard Configuration

### Timezone
Go to **Admin → System Settings** → select timezone → **Save**.

### Email / MFA
Go to **Admin → Email Configuration** to set up SMTP for forgot password and MFA login.

### Screenshot Interval
Go to **Employees** → **⚙ Settings** on any employee.

### Duty Roster
Go to **Admin → Duty Roster** to create shifts and assign employees.

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
├── public/            # Dashboard HTML, login page, installer page
├── winagent/          # Windows agent source
│   ├── agent.js       # Main agent script
│   ├── installer.bat  # Agent installer for employee PCs
│   ├── uninstall.bat  # Agent uninstaller
│   ├── updater.bat    # Agent updater
│   └── launch.vbs     # Silent launcher
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

**Cause:** `NODE_ENV=production` requires HTTPS for session cookies. On plain HTTP it drops the session.

**Fix:**
```bash
sed -i 's/NODE_ENV=production/NODE_ENV=development/' ~/workpulse-app/.env
pm2 restart workpulse --update-env
```

Switch back to `production` only after HTTPS/SSL is configured.

---

### Database connection error: client password must be a string

**Cause:** `db.js` reads `DB_PASS` but `.env` only has `DB_PASSWORD`.

**Fix:** Ensure both are in `.env`:
```bash
echo "DB_PASS=YourStrongPassword" >> ~/workpulse-app/.env
pm2 restart workpulse --update-env
```

---

### Download Agent shows "File not found"

**Cause:** Agent ZIP not built yet. Follow Step 12 above to build it.

Make sure you built the agent as the `workpulse` user (Step 13). If you used a different user, fix the path:
```bash
sed -i "s|/home/workpulse/|${HOME}/|g" ~/workpulse-app/server.js
pm2 restart workpulse --update-env
```

---

### Bad Gateway (502)

```bash
pm2 logs workpulse --lines 30
pm2 restart workpulse --update-env
```

---

### Cannot connect to database

```bash
sudo systemctl status postgresql
sudo -u postgres psql -c "\l"
```

---

### PM2 restarts keep signing everyone out

Sessions are in memory — every restart signs everyone out. This is expected during setup. Once the server is stable it won't happen.

```bash
pm2 show workpulse | grep restart
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
