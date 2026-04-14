# WorkPulse 2.0 — Employee Monitoring System

> Real-time employee monitoring: screenshots, web activity, app usage, system events, duty rosters, and more.

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

---

### Step 2 — Create the database and user

```bash
sudo -u postgres psql
```

Inside the PostgreSQL shell:

```sql
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'your_password_here';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
\q
```

---

### Step 3 — Clone the repository

```bash
sudo useradd -m -s /bin/bash workpulse
sudo su - workpulse

git clone https://github.com/naveenyamf/WorkPulse.git workpulse-app
cd workpulse-app
npm install
```

---

### Step 4 — Run the web installer

The installer handles everything else — tables, admin account, .env file — through a simple browser UI.

**Start the server temporarily:**

```bash
# Create a minimal .env just to boot
echo "SESSION_SECRET=setup" > .env

# Start on port 3000
node server.js &
```

**Open the installer in your browser:**

```
http://YOUR_SERVER_IP:3000/install
```

The wizard will walk you through:

1. **Database** — enter your DB host, name, username and password → tests the connection live
2. **Admin** — create your root admin name, email and password
3. **Install** — watch all 13 tables get created, indexes built, default rosters seeded, and your `.env` written automatically
4. **Done** — your credentials are shown, then go to the dashboard

> ⚠️ **After installation completes**, stop the temp server and remove the installer:

```bash
# Stop the temp server
kill %1

# Open server.js and remove or comment out these 3 lines:
#   // ---- INSTALLER ----
#   const installRouter = require('./install');
#   app.use('/install', installRouter);
```

---

### Step 5 — Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 20M;

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

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/workpulse /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

### Step 6 — HTTPS with Let's Encrypt (recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

### Step 7 — Start with PM2

```bash
cd /home/workpulse/workpulse-app
NODE_ENV=production pm2 start server.js --name workpulse
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

---

### Step 8 — Verify

```bash
pm2 status
pm2 logs workpulse --lines 20
```

Open your domain in a browser — you should see the WorkPulse login page.

---

## Updating an Existing Installation

```bash
cd /home/workpulse/workpulse-app
git pull
npm install
pm2 restart workpulse
```

---

## Windows Agent Setup

1. Go to **Dashboard → Employees** → Add the employee
2. Copy their **Agent Token**
3. Download **WorkPulse-Agent.exe** from the Dashboard sidebar
4. On the employee's Windows PC, run the installer — it will ask for the server URL and token
5. The agent installs to `C:\WorkPulse\` and runs silently in the background

**Agent behaviour:**
- Heartbeat every 1 minute
- Screenshot every 5 minutes (configurable per employee)
- Multi-monitor support
- Tracks active app, web URLs, system events (startup/shutdown/lock)

---

## Browser Extension Setup

1. Download the extension folder from `wp-extension/` in this repo
2. Open Chrome → `chrome://extensions` → Enable **Developer Mode**
3. Click **Load unpacked** → select the `wp-extension` folder
4. The extension icon appears — it will automatically send web activity to your WorkPulse server

> Make sure the server URL inside the extension matches your domain (`https://your-domain.com`)

---

## Rebuilding the Windows Agent (developers only)

If you change `winagent/agent.js`, rebuild the `.exe` on the server:

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
| Installer | `/home/workpulse/workpulse-app/public/install.html` |
| Agent source | `/home/workpulse/workpulse-app/winagent/agent.js` |
| Agent EXE | `/home/workpulse/WorkPulse-Agent.exe` |
| Agent ZIP | `/home/workpulse/WorkPulse-Agent-Windows.zip` |
| Extension | `/home/workpulse/workpulse-app/wp-extension/` |
| Screenshots | `/home/workpulse/workpulse-app/screenshots/` |
| Environment | `/home/workpulse/workpulse-app/.env` |

---

## Environment Variables (`.env`)

The installer creates this automatically. Reference:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASSWORD=your_password
SESSION_SECRET=random_64_char_string
NODE_ENV=production
PORT=3000
```

---

## Troubleshooting

**Bad Gateway / 502**
```bash
pm2 logs workpulse --lines 30
# Look for the error, fix it, then:
pm2 restart workpulse
```

**Cannot connect to database**
```bash
sudo systemctl status postgresql
sudo -u postgres psql -c "\l"   # list databases
```

**Agent not connecting**
- Check the server URL in `C:\WorkPulse\config.json` — must be `https://your-domain.com`
- Check the agent token matches what's in the dashboard

**GitHub push authentication fails**
```bash
# Use a Personal Access Token (not your password)
# GitHub → Settings → Developer Settings → Personal Access Tokens → Classic → repo scope
git remote set-url origin https://YOUR_TOKEN@github.com/naveenyamf/WorkPulse.git
git push
```

---

## PM2 Quick Reference

```bash
pm2 status                        # check if running
pm2 restart workpulse             # restart
pm2 logs workpulse --lines 50     # view logs
pm2 stop workpulse                # stop
NODE_ENV=production pm2 restart workpulse --update-env  # restart with env vars
```

---

## Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Auth:** Session-based (express-session + bcryptjs)
- **Process manager:** PM2
- **Reverse proxy:** Nginx
- **Agent:** Node.js → compiled to `.exe` via `pkg`
- **Extension:** Chrome Manifest V3
