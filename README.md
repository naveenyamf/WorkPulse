# WorkPulse — Employee Monitoring System

> Open-source, self-hosted employee productivity monitoring system with real-time dashboards, screenshot capture, web activity tracking, app usage analytics, and system event logging.

---

## 🖥️ Features

- **Live Employee Status** — see who is online, idle, or offline in real time
- **Screenshots** — periodic captures with flagging and calendar filter
- **Web Activity** — track websites visited, time spent, productivity classification (Productive / Neutral / Non-Productive) with duty/off-duty hours breakdown
- **App Usage** — deduplicated app time with shift-based productivity scoring and top 3 apps summary
- **System Activity** — Windows event logs (startup, lock, sleep, idle, shutdown)
- **Duty Roster** — assign shifts and calculate productive hours within shift window
- **Multi-user Access** — root admin + monitoring users with scoped employee access

---

## ⚙️ Requirements

| Component  | Version |
|------------|---------|
| Ubuntu     | 20.04+  |
| Node.js    | 18+     |
| PostgreSQL | 14+     |
| Nginx      | Any     |
| PM2        | Any     |

---

## 🚀 Installation (Manual)

### Step 1 — Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/workpulse.git
cd workpulse
```

### Step 2 — Install dependencies

```bash
npm install
```

### Step 3 — Set up PostgreSQL

```bash
sudo -u postgres psql << 'EOF'
CREATE DATABASE workpulse;
CREATE USER workpulse_user WITH PASSWORD 'your_password_here';
GRANT ALL PRIVILEGES ON DATABASE workpulse TO workpulse_user;
EOF
```

### Step 4 — Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in your values:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=workpulse
DB_USER=workpulse_user
DB_PASS=your_password_here
JWT_SECRET=generate_a_random_64_char_string
SESSION_SECRET=generate_another_random_64_char_string
PORT=3000
```

Generate random secrets with this command:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice — once for `JWT_SECRET` and once for `SESSION_SECRET`.

### Step 5 — Initialize the database

```bash
node db.js
```

This creates all required tables automatically.

### Step 6 — Create your first Admin account

> ⚠️ **IMPORTANT**: There is NO default username or password. You MUST create an admin account before you can log in to the dashboard.

Run this command (replace the values with your own):

```bash
node -e "
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool();
const hash = bcrypt.hashSync('YOUR_PASSWORD_HERE', 10);
pool.query(
  'INSERT INTO admins (name, email, password_hash) VALUES (\$1, \$2, \$3)',
  ['Your Name', 'your@email.com', hash]
).then(() => { console.log('Admin created successfully!'); process.exit(0); });
"
```

Replace:
- `YOUR_PASSWORD_HERE` with your chosen password (min 8 characters recommended)
- `Your Name` with your full name
- `your@email.com` with your email address

### Step 7 — Start the server

```bash
# Install PM2 globally
npm install -g pm2

# Start WorkPulse
pm2 start server.js --name workpulse
pm2 save
pm2 startup
```

### Step 8 — Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Paste the following (replace `YOUR_DOMAIN_OR_IP`):

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;
    client_max_body_size 10M;

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
sudo nginx -t && sudo systemctl reload nginx
```

---

## 🌐 Accessing WorkPulse

### Option A — Local Network Access

If your server is on a local network (e.g. IP `192.168.1.100`):

1. Open a browser on any PC on the same network
2. Go to: `http://192.168.1.100`
3. Log in with the admin credentials you created in Step 6

> Suitable for office-only access where all devices are on the same network.

### Option B — Public Access via Domain (with SSL)

> Recommended for accessing WorkPulse from outside the office or over the internet.

**1. Point your domain DNS to your server's public IP:**

Add an **A record** in your DNS provider:
- Name: `monitoring`
- Value: `YOUR_PUBLIC_IP`
- TTL: `300`

**2. Open ports 80 and 443** in your router/firewall and forward (NAT) them to your server's local IP.

**3. Install SSL certificate:**

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d monitoring.yourdomain.com
```

**4. Update Nginx config:**

```bash
sudo nano /etc/nginx/sites-available/workpulse
```

Update `server_name`:
```nginx
server_name monitoring.yourdomain.com;
```

Add SSL redirect block:
```nginx
server {
    listen 80;
    server_name monitoring.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name monitoring.yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/monitoring.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/monitoring.yourdomain.com/privkey.pem;
    client_max_body_size 10M;

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
sudo nginx -t && sudo systemctl reload nginx
```

**5. Access via browser:**

```
https://monitoring.yourdomain.com
```

Log in with the admin credentials you created in Step 6.

---

## 🪟 Windows Agent Installation

The Windows Agent runs silently on employee PCs and sends heartbeats, screenshots, app usage, web activity, and system events to the WorkPulse server.

### Download the Agent

From your WorkPulse dashboard click **Download Agent**, or directly:
```
https://YOUR_DOMAIN/download/agent
```

### Install on Employee PC

1. Extract the downloaded ZIP file
2. Right-click `installer.bat` → **Run as Administrator**
3. When prompted, enter your **WorkPulse server URL**:
   - Local network: `http://192.168.1.100`
   - Public domain: `monitoring.yourdomain.com` *(https:// is added automatically)*
4. Enter the **employee's email address** *(must be added in dashboard first under "Add Agents to Monitor")*
5. The installer will:
   - Validate server connection
   - Fetch employee token
   - Download and install the agent
   - Create a silent background launcher
   - Add to Windows startup (auto-starts on boot)

### Update Agent on Employee PC

To push an update to an employee PC:

1. Download latest ZIP from dashboard
2. Copy `updater.bat` to `C:\WorkPulse\` on the employee PC
3. Right-click `updater.bat` → **Run as Administrator**

The updater will stop the old agent, download the latest version from the server, and restart automatically.

### Agent Log

Check agent activity on the employee PC:
```
C:\WorkPulse\agent.log
```

---

## 👤 User Management

### Root Admin
- Created during setup (Step 6)
- Full access to all employees and all settings
- Cannot be deleted from the dashboard
- Password can be reset from **Admin → Monitor Users → Admin Users**

### Monitoring Users
- Created from the dashboard under **Admin → Monitor Users**
- Can be assigned to view only specific employees
- Password can be reset by root admin

### Roles

| Role       | Access                              |
|------------|-------------------------------------|
| Root Admin | Full access — all employees, all settings |
| Admin      | Full access                         |
| User       | View only assigned employees        |

---

## 📁 Project Structure

```
workpulse/
├── server.js           # Main Express server & API routes
├── db.js               # Database schema & initialization
├── .env.example        # Environment variables template
├── public/
│   ├── dashboard.html  # Main dashboard UI
│   └── index.html      # Login page
├── winagent/
│   ├── agent.js        # Windows monitoring agent (Node.js)
│   ├── installer.bat   # One-click Windows installer
│   ├── updater.bat     # One-click Windows updater
│   ├── launch.vbs      # Silent background launcher
│   └── package.json    # Agent dependencies
└── screenshots/        # Screenshot storage (gitignored)
```

---

## 🔒 Security Notes

- Never commit your `.env` file — it contains sensitive credentials
- Use strong, unique passwords for your database and admin account
- Always use HTTPS (SSL) when accessing WorkPulse over the internet
- Each employee has a unique agent token — do not share tokens between employees
- Screenshots are stored locally on your server — ensure adequate disk space

---

## 🛠️ Troubleshooting

**Agent shows OFFLINE on dashboard:**
- Check `C:\WorkPulse\agent.log` on the employee PC
- Ensure the server URL in `C:\WorkPulse\config.json` is correct
- Run `tasklist | findstr workpulse` in CMD to verify agent is running

**Cannot login to dashboard:**
- Ensure you completed Step 6 (admin account creation)
- Check server is running: `pm2 status`
- Check logs: `pm2 logs workpulse`

**SSL certificate fails:**
- Ensure ports 80 and 443 are open and forwarded to your server
- Verify DNS A record points to correct public IP
- Wait for DNS propagation (up to 10 minutes)

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 🙏 Contributing

Pull requests are welcome! Please open an issue first to discuss what you would like to change.

---

*Built with ❤️ for transparent and fair workplace productivity monitoring.*
