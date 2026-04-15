# WorkPulse 2.0 — Employee Monitoring Dashboard

> A self-hosted, privacy-respecting employee activity monitoring system for Windows environments. Tracks web activity, app usage, screenshots, system events, and more — all from a sleek real-time dashboard.

---

## Features

- **Live Dashboard** — Real-time employee status, active app, idle detection
- **Screenshots** — Automatic periodic screenshots with flagging system
- **Web Activity** — Tracks URLs visited per browser with productivity scoring (Productive / Neutral / Non-Productive)
- **App Usage** — Tracks time spent per application with donut chart visualization
- **System Events** — Startup, shutdown, lock, unlock, sleep, wakeup events
- **Duty Roster** — Shift assignment with in-shift vs off-shift time tracking
- **Reports** — Export Excel reports (Summary, Web Activity, App Usage, Daily Breakdown)
- **Backup & Restore** — Full PostgreSQL DB backup + screenshot archive backup/restore
- **Multi-User** — Admin and Monitor (view-only) user roles with employee assignment
- **MFA Support** — Email OTP login verification
- **Audit Log** — Full admin action logging
- **Dark / Light Mode** — System-aware theme with manual override
- **Timezone Settings** — Configurable timezone for all date displays

---

## Requirements

- Ubuntu 20.04+ server
- Node.js 18+
- PostgreSQL 14+
- Windows PCs for monitored employees (agent runs on Windows)

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/naveenyamf/WorkPulse.git
cd WorkPulse
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in:

```env
PORT=3000
SESSION_SECRET=your_random_secret_here
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASSWORD=your_db_password
NODE_ENV=production
```

### 4. Set up PostgreSQL

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'your_db_password';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
\q
```

### 5. Run the installer

Start the server once to trigger the web installer:

```bash
node server.js
```

Then open in your browser:

```
http://your-server-ip:3000/install
```

Follow the setup wizard to create your admin account and initialize the database.

### 6. Run with PM2 (recommended)

```bash
npm install -g pm2
pm2 start server.js --name workpulse
pm2 save
pm2 startup
```

---

## Agent Setup (Windows PCs)

The WorkPulse Agent runs silently on employee Windows machines and reports activity to the server.

### Step 1 — Download the agent

From the dashboard sidebar, click **Download Agent** to get `agent.js`.

Or copy `winagent/agent.js` to the employee PC.

### Step 2 — Install Node.js on employee PC

Download and install Node.js from https://nodejs.org (LTS version).

Then install required packages:

```cmd
npm install -g axios form-data
```

### Step 3 — Configure the agent

Edit `agent.js` and set your server URL at the top:

```javascript
let SERVER_URL = 'http://your-server-ip';
```

### Step 4 — Get the agent token

In the dashboard, go to **Employees** → find the employee → copy their **Agent Token**.

Create a file called `config.json` in the same folder as `agent.js`:

```json
{
  "token": "paste_agent_token_here",
  "server_url": "http://your-server-ip"
}
```

### Step 5 — Run the agent

```cmd
node agent.js
```

To run silently on startup, create a scheduled task or use a `.vbs` launcher.

---

## Browser Extension — Required for URL Tracking

> ⚠️ Without this extension, only page titles are captured instead of real URLs.

The agent captures browser activity by reading window titles. To capture actual URLs, employees must install the **"URL in Title"** Chrome/Edge extension.

### Install URL in Title Extension

**Chrome:**
👉 [Install from Chrome Web Store](https://chromewebstore.google.com/detail/url-in-title/ignpacbgnbnkaiooknalneoeladjnfgb)

**Edge:**
👉 Same extension works on Edge — visit the link above in Edge and click **Allow extensions from other stores** if prompted.

### Configure the extension

After installing:
1. Click the extension icon in the browser toolbar
2. Go to **Options**
3. Set the title format to:
   ```
   {url} | {title}
   ```
4. Click **Save**

Once configured, the agent will automatically extract real domains from the browser title bar.

---

## Dashboard Access

Open your browser and go to:

```
http://your-server-ip:3000
```

Login with the admin credentials you created during installation.

---

## Configuration

### Timezone

Go to **Admin → System Settings** to set your local timezone. This affects all calendar date displays, activity logs, and reports.

### Email / MFA

Go to **Admin → Email Configuration** to set up SMTP for:
- Forgot password OTP emails
- Login MFA verification

### Screenshot Interval

Go to **Employees** → click **⚙ Settings** on any employee to configure:
- Screenshot capture interval (1 min to 1 hour)
- Data retention period
- Duty roster assignment
- Department

---

## Backup & Restore

Go to **Admin → Backup & Restore** to:
- Download full PostgreSQL database backup (`.wpbackup`)
- Download all screenshots as a `.tar.gz` archive
- Restore from a previous backup

---

## Security Notes

- All agent tokens are unique per employee (256-bit random hex)
- Passwords are hashed with bcrypt
- Sessions expire after 24 hours
- Admin and Monitor roles are strictly separated
- All admin actions are logged in the Audit Log

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Frontend | Vanilla JS + CSS (no framework) |
| Agent | Node.js + PowerShell |
| Auth | express-session + bcryptjs |
| Reports | ExcelJS |
| Email | Nodemailer |

---

## Changelog

### v2.1 (April 2026)
- System Settings page with timezone configuration
- Screenshot backup & restore
- Excel report export with 4 sheets
- Email OTP / MFA login
- Forgot password flow
- Audit log for all admin actions
- Calendar dot fix for today's date (timezone-aware)
- Admin users correctly separated from Monitor users
- URL tracking via "URL in Title" extension support

### v2.0
- Duty Roster with shift tracking
- In-shift vs Off-shift time breakdown in Web Activity
- App Usage donut charts
- System Activity log
- Dark/Light mode
- Multi-user support with employee assignment
- Flagged screenshots

### v1.0
- Initial release
- Basic employee monitoring
- Screenshots, web activity, app usage

---

## License

Proprietary — All rights reserved. Not for redistribution.
