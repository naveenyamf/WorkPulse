# WorkPulse 2.0 — Employee Monitoring System

> Real-time employee monitoring: screenshots, web activity, app usage, system events, duty rosters, Excel reports, email OTP, MFA and full backup/restore.

---

## Features

| Category | Features |
|----------|---------|
| **Monitoring** | Live employee status, screenshots (multi-monitor), web activity, app usage, system events |
| **Analysis** | Productivity scoring, duty/off-duty tracking, shift roster comparison |
| **Reports** | Excel export — Summary, Web Activity, App Usage, Daily Breakdown |
| **Admin** | Departments, duty rosters, audit log, role-based access control |
| **Security** | Email OTP for forgot password, optional MFA on every login |
| **Backup** | DB backup (pg_dump), screenshot backup (tar.gz), one-click restore with live progress |
| **Setup** | Web installer — fresh install or restore from backup |

---

## Requirements

| Software | Version |
|----------|---------|
| Ubuntu | 20.04 or 22.04 |
| Node.js | 18+ |
| PostgreSQL | 13+ |
| Nginx | Any recent |
| PM2 | Any recent |

---

## Fresh Installation on a New Server

### Step 1 — Install system dependencies

```bash
# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Nginx & PM2
sudo apt install -y nginx
sudo npm install -g pm2
```

### Step 2 — Create the database and user

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'your_password_here';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
\q
```

### Step 3 — Clone and install

```bash
sudo useradd -m -s /bin/bash workpulse
sudo su - workpulse

git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
```

### Step 4 — Run the web installer

```bash
# Create a minimal .env to boot
echo "SESSION_SECRET=setup" > .env

# Start temporarily
node server.js &
```

Open in browser: `http://YOUR_SERVER_IP:3000/install`

The wizard offers two paths:

**✨ Fresh Install** — for a new server:
1. Enter DB connection → live test
2. Choose Fresh Install
3. Create root admin (name, email, password)
4. All 15 tables created, indexes built, default rosters seeded, `.env` written
5. Go to dashboard

**🔄 Restore Backup** — to migrate from another server:
1. Enter DB connection → live test
2. Choose Restore Backup
3. Upload your `.wpbackup` file
4. Live progress log, then log in with existing credentials

> ⚠️ After setup completes, remove the installer from `server.js`:
> ```js
> // Remove these two lines:
> const installRouter = require('./install');
> app.use('/install', installRouter);
> ```

### Step 5 — Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Step 6 — HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Step 7 — Start with PM2

```bash
cd /home/workpulse/workpulse-app
NODE_ENV=production pm2 start server.js --name workpulse
pm2 save
pm2 startup   # follow the printed command
```

### Step 8 — Verify

```bash
pm2 status
pm2 logs workpulse --lines 20
```

---

## Updating an Existing Installation

```bash
cd /home/workpulse/workpulse-app
git pull
npm install
pm2 restart workpulse
```

---

## Email Configuration (SMTP)

WorkPulse uses email for **Forgot Password** and optional **MFA** login verification.

### How to set up

1. Go to **Admin → Email Configuration**
2. Click a preset (Gmail, Outlook, Yahoo) to auto-fill host and port
3. Enter your SMTP username and password
4. Click **💾 Save Config**
5. Click **📨 Send Test Email** — sent to your admin email address
6. Optionally enable **MFA** once test passes

### How it works

The SMTP account you configure is the **sender**. Emails go **to** the user's email address stored in their WorkPulse account.

```
admin@yourcompany.com (SMTP sender)
    → sends OTP →
user@yourcompany.com (recipient — stored in their WorkPulse account)
```

- **Forgot Password** — user clicks link on login page → enters email → receives OTP → sets new password
- **MFA** — after correct password → OTP sent to user's email → must enter to access dashboard

### Gmail setup

Gmail requires an **App Password**, not your regular password:

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Select Mail → Other → name it `WorkPulse`
3. Copy the 16-character generated password

| Setting | Value |
|---------|-------|
| Host | `smtp.gmail.com` |
| Port | `587` |
| Username | `you@gmail.com` |
| Password | 16-char App Password |
| TLS | Enabled |

### Outlook / Office 365

| Setting | Value |
|---------|-------|
| Host | `smtp.office365.com` |
| Port | `587` |
| Username | `you@company.com` |
| Password | Your account password |
| TLS | Enabled |

> ⚠️ Every admin and dashboard user must have a **real working email** in their account before enabling MFA — otherwise they cannot receive OTPs and will be locked out.

> ⚠️ If you get locked out with MFA on and SMTP broken, disable it directly:
> ```bash
> PGPASSWORD='your_password' psql -U workpulse_user -d workpulse \
>   -c "UPDATE email_config SET mfa_enabled=false;"
> pm2 restart workpulse
> ```

---

## Backup & Restore

### Database backup

From the dashboard: **Admin → Backup & Restore → Create Backup** → downloads `.wpbackup` instantly.

Automatic nightly cron backup (recommended):
```bash
crontab -e
# Add (runs at 2 AM daily, keeps named files):
0 2 * * * PGPASSWORD='your_password' pg_dump -h localhost -U workpulse_user -d workpulse -f /home/workpulse/workpulse-app/backups/auto-$(date +\%Y-\%m-\%d).wpbackup
```

### Screenshot backup

**Admin → Backup & Restore → Backup Screenshots** → downloads `.tar.gz` of all screenshot image files.

> Keep both files for a complete backup: `.wpbackup` (database) + `.tar.gz` (images)

### Restore

- **Database** — Admin → Backup & Restore → Restore Backup → upload `.wpbackup` → live log
- **Screenshots** — Admin → Backup & Restore → Restore Screenshots → upload `.tar.gz`
- **On a new server** — use the `/install` wizard → choose Restore Backup

---

## Reports (Excel Export)

**Monitoring → Reports** → select employee + date range + sheets → Export Excel.

The `.xlsx` file contains up to 4 sheets:

| Sheet | Contents |
|-------|---------|
| Summary | One row per employee — screenshots, web mins, app mins, top site, top app, productivity % |
| Web Activity | All URLs per employee per day with minute counts |
| App Usage | All apps per employee per day with minute counts |
| Daily Breakdown | Per-day — first seen, last seen, screenshot count, web mins, app mins |

---

## Windows Agent Setup

1. Go to **Dashboard → Add Agents to Monitor** → add the employee
2. Click **⤓ Download Agent** in the sidebar — downloads the installer ZIP
3. Extract on the employee's Windows PC and run `installer.bat`
4. Agent installs to `C:\WorkPulse\` and starts automatically on login

**Agent behaviour:**
- Heartbeat every 1 minute
- Screenshot every 5 minutes (configurable per employee)
- Multi-monitor support
- Tracks active app, web URLs, system events (startup/shutdown/lock/sleep/wake)

---

## Browser Extension Setup

1. Download `wp-extension/` folder from this repo
2. Open Chrome → `chrome://extensions` → Enable **Developer Mode**
3. Click **Load unpacked** → select the `wp-extension` folder
4. Extension automatically tracks web activity and sends to your server

> After changing your domain to HTTPS, reinstall the extension on all PCs — it needs the updated server URL.

---

## Rebuilding the Windows Agent (developers only)

```bash
cd /home/workpulse/workpulse-app/winagent
npx pkg . --targets node18-win-x64 --output dist/WorkPulse-Agent.exe
cp dist/WorkPulse-Agent.exe /home/workpulse/
zip -j /home/workpulse/WorkPulse-Agent-Windows.zip \
    /home/workpulse/WorkPulse-Agent.exe \
    installer.bat updater.bat uninstall.bat
pm2 restart workpulse
```

---

## Key File Paths

| File | Path |
|------|------|
| Server | `/home/workpulse/workpulse-app/server.js` |
| Dashboard | `/home/workpulse/workpulse-app/public/dashboard.html` |
| Login page | `/home/workpulse/workpulse-app/public/index.html` |
| Installer page | `/home/workpulse/workpulse-app/public/install.html` |
| Installer route | `/home/workpulse/workpulse-app/install.js` |
| Agent source | `/home/workpulse/workpulse-app/winagent/agent.js` |
| Agent EXE | `/home/workpulse/WorkPulse-Agent.exe` |
| Agent ZIP | `/home/workpulse/WorkPulse-Agent-Windows.zip` |
| Extension | `/home/workpulse/workpulse-app/wp-extension/` |
| Screenshots | `/home/workpulse/workpulse-app/screenshots/` |
| DB Backups | `/home/workpulse/workpulse-app/backups/` |
| Environment | `/home/workpulse/workpulse-app/.env` |

---

## Environment Variables (`.env`)

The installer creates this automatically:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASSWORD=your_password
SESSION_SECRET=auto_generated_64_char_string
NODE_ENV=production
PORT=3000
```

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `employees` | Employee records and agent tokens |
| `heartbeats` | Live status and active app |
| `screenshots` | Screenshot metadata |
| `web_activity` | URLs tracked by agent and extension |
| `app_usage` | Application usage records |
| `system_events` | Startup, shutdown, lock, sleep events |
| `admins` | Root administrator accounts |
| `dashboard_users` | Monitor-only user accounts |
| `user_employee_access` | Employee access per monitor user |
| `departments` | Department list |
| `duty_rosters` | Shift definitions |
| `alerts` | Flagged events |
| `audit_log` | All admin actions with timestamps |
| `email_config` | SMTP settings and MFA flag |
| `otp_tokens` | Short-lived OTP codes for login and password reset |

---

## Troubleshooting

**Bad Gateway / 502**
```bash
pm2 logs workpulse --lines 30
pm2 restart workpulse
```

**Backup fails — no password supplied**
```bash
grep DB_PASSWORD /home/workpulse/workpulse-app/.env
# If missing:
echo "DB_PASSWORD=your_password" >> /home/workpulse/workpulse-app/.env
pm2 restart workpulse --update-env
```

**Cannot connect to database**
```bash
sudo systemctl status postgresql
sudo -u postgres psql -c "\l"
```

**Agent not connecting**
- Check `C:\WorkPulse\config.json` — server URL must be `https://your-domain.com`
- Verify the agent token matches the dashboard

**Email not sending**
- Admin → Email Config → Send Test Email — read the exact error
- Gmail: must use App Password, not your login password
- Check port 587 is not blocked by your server firewall

**Locked out (MFA on, SMTP broken)**
```bash
PGPASSWORD='your_password' psql -U workpulse_user -d workpulse \
  -c "UPDATE email_config SET mfa_enabled=false;"
pm2 restart workpulse
```

**GitHub push authentication fails**
```bash
# Generate a Personal Access Token at:
# GitHub → Settings → Developer Settings → Personal Access Tokens → Classic → repo scope
git remote set-url origin https://YOUR_TOKEN@github.com/naveenyamf/WorkPulse.git
git push
```

---

## PM2 Quick Reference

```bash
pm2 status                                  # check status
pm2 restart workpulse                       # restart
pm2 restart workpulse --update-env          # restart and reload .env
pm2 logs workpulse --lines 50               # view logs
pm2 stop workpulse                          # stop
pm2 startup                                 # enable auto-start on reboot
pm2 save                                    # save current process list
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Auth | express-session + bcryptjs |
| Email | nodemailer (SMTP) |
| Excel reports | exceljs |
| Process manager | PM2 |
| Reverse proxy | Nginx |
| Agent | Node.js → `.exe` via `pkg` |
| Browser extension | Chrome Manifest V3 |
