require('dotenv').config();
const express = require('express');
const schedule = require('node-schedule');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/screenshots', express.static('screenshots'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Create screenshots folder if not exists
if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

// ---- INSTALLER (disable this block after first setup) ----
const installRouter = require('./install');
app.use('/install', installRouter);
// ---- END INSTALLER ----

// Screenshot upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'screenshots/'),
  filename: (req, file, cb) => {
    const name = `${req.employee.id}_${Date.now()}.jpg`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// ---- AUTH MIDDLEWARE ----
function requireLogin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminRole === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function getAllowedEmployees(req) {
  if (req.session.isUser && req.session.allowedEmployees) {
    return req.session.allowedEmployees;
  }
  return null; // null means all employees (admin)
}

async function auditLog(req, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_log (admin_id, admin_name, action, details) VALUES ($1,$2,$3,$4)',
      [req.session.adminId||null, req.session.adminName||'Unknown', action, details||null]
    );
  } catch(e) {}
}

function requireAgent(req, res, next) {
  const token = req.headers['x-agent-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  pool.query('SELECT * FROM employees WHERE agent_token=$1 AND active=true', [token])
    .then(r => {
      if (!r.rows.length) return res.status(401).json({ error: 'Invalid token' });
      req.employee = r.rows[0];
      next();
    })
    .catch(err => res.status(500).json({ error: err.message }));
}

// ---- ADMIN AUTH ROUTES ----
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.adminId = admin.id;
    req.session.adminName = admin.name;
    req.session.adminRole = admin.role || 'admin';
    res.json({ success: true, name: admin.name, role: admin.role || 'admin' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ name: req.session.adminName, role: req.session.adminRole || 'admin' });
});

// ---- EMPLOYEE MANAGEMENT ----
app.get("/api/employees", requireLogin, async (req, res) => {
  try {
    const allowed = getAllowedEmployees(req);
    let query = `SELECT e.*, (SELECT active_app FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as current_app, (SELECT idle FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as is_idle, (SELECT recorded_at FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as last_seen FROM employees e WHERE e.active=true`;
    const params = [];
    if (allowed) { params.push(allowed); query += ` AND e.id = ANY($1::int[])`; }
    query += " ORDER BY e.name";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees', requireLogin, async (req, res) => {
  const { name, email, department } = req.body;
  const token = require('crypto').randomBytes(32).toString('hex');
  try {
    // Check if employee exists but was deleted
    const existing = await pool.query(
      'SELECT id FROM employees WHERE email=$1', [email]
    );
    if (existing.rows.length) {
      // Reactivate with new token
      const result = await pool.query(
        'UPDATE employees SET name=$1, department=$2, agent_token=$3, active=true WHERE email=$4 RETURNING *',
        [name, department, token, email]
      );
      return res.json(result.rows[0]);
    }
    // New employee
	const result = await pool.query(
      'INSERT INTO employees (name, email, department, agent_token) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, email, department, token]
    );
    await auditLog(req, 'Employee Added', name + ' (' + email + ')');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.delete('/api/employees/:id', requireLogin, async (req, res) => {
  const emp = await pool.query('SELECT name,email FROM employees WHERE id=$1', [req.params.id]);
  await pool.query("UPDATE employees SET active=false, deleted_at=NOW() WHERE id=$1", [req.params.id]);
  await auditLog(req, 'Employee Deleted', emp.rows[0]?.name + ' (' + emp.rows[0]?.email + ')');
  res.json({ success: true });
});


// ---- AGENT ROUTES (called by agent on employee PC) ----
app.post('/api/agent/heartbeat', requireAgent, async (req, res) => {
  const { active_app, idle, urls, apps } = req.body;
  const empId = req.employee.id;
  try {
    // Save heartbeat
    await pool.query(
      'INSERT INTO heartbeats (employee_id, active_app, idle) VALUES ($1,$2,$3)',
      [empId, active_app || 'Unknown', idle || false]
    );
    // Save web activity
    if (urls && urls.length) {
      for (const u of urls) {
        await pool.query(
          "INSERT INTO web_activity (employee_id, url, duration_seconds, browser, idle_seconds, full_url) VALUES ($1,$2,$3,$4,$5,$6)",
          [empId, u.url, u.seconds || 0, u.browser || "Browser", u.idle_seconds || 0, u.full_url || u.url]
        );
      }
    }
    // Save app usage
    if (apps && apps.length) {
      for (const a of apps) {
        await pool.query(
          'INSERT INTO app_usage (employee_id, app_name, duration_seconds) VALUES ($1,$2,$3)',
          [empId, a.name, a.seconds || 0]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/screenshot', requireAgent, upload.single('screenshot'), async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO screenshots (employee_id, filename) VALUES ($1,$2)',
      [req.employee.id, req.file.filename]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- DASHBOARD DATA ROUTES ----
app.get("/api/dashboard/stats", requireLogin, async (req, res) => {
  try {
    const allowed = getAllowedEmployees(req);
    const empFilter = allowed ? `AND e.id = ANY(ARRAY[${allowed.join(",")||0}]::int[])` : "";
    const idFilter = allowed ? `AND employee_id = ANY(ARRAY[${allowed.join(",")||0}]::int[])` : "";
    const active = await pool.query(`SELECT COUNT(*) FROM employees e WHERE active=true ${empFilter} AND EXISTS (SELECT 1 FROM heartbeats h WHERE h.employee_id=e.id AND h.recorded_at > NOW()-INTERVAL '5 minutes')`);
    const total = await pool.query(`SELECT COUNT(*) FROM employees e WHERE active=true ${empFilter}`);
    const screenshots = await pool.query(`SELECT COUNT(*) FROM screenshots WHERE recorded_at::date = CURRENT_DATE ${idFilter}`);
    const alerts = await pool.query(`SELECT COUNT(*) FROM alerts WHERE resolved=false ${idFilter}`);
    res.json({ active: parseInt(active.rows[0].count), total: parseInt(total.rows[0].count), screenshots: parseInt(screenshots.rows[0].count), alerts: parseInt(alerts.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/api/dashboard/screenshots", requireLogin, async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    const allowed = getAllowedEmployees(req);
    const params = [];
    let where = "WHERE e.active=true";
    if (employee_id) { params.push(employee_id); where += ` AND s.employee_id=$${params.length}`; }
    if (date) { params.push(date); where += ` AND s.recorded_at::date=$${params.length}`; }
    if (allowed) { params.push(allowed); where += ` AND s.employee_id = ANY($${params.length}::int[])`; }
    if (req.query.flagged === "true") { where += " AND s.flagged=true"; }
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const countResult = await pool.query(`SELECT COUNT(*) FROM screenshots s JOIN employees e ON s.employee_id=e.id ${where}`, params);
    const total = parseInt(countResult.rows[0].count);
    const result = await pool.query(`SELECT s.*, e.name as employee_name FROM screenshots s JOIN employees e ON s.employee_id=e.id ${where} ORDER BY s.recorded_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    return res.json({ screenshots: result.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/screenshots/:id/flag', requireLogin, async (req, res) => {
  await pool.query('UPDATE screenshots SET flagged=true WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.post('/api/screenshots/:id/unflag', requireLogin, async (req, res) => {
  await pool.query('UPDATE screenshots SET flagged=false WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.get("/api/dashboard/web-activity", requireLogin, async (req, res) => {
  const { employee_id, date } = req.query;
  const page = parseInt(req.query.page) || 1;
  const perPage = 2;
  try {
    // Get employees with their roster
    const allowed = getAllowedEmployees(req);
	let empQuery = `SELECT DISTINCT e.id, e.name, e.department,
      r.start_time as shift_start, r.end_time as shift_end, r.name as roster_name
      FROM employees e
      LEFT JOIN duty_rosters r ON e.roster_id = r.id
      WHERE e.active=true
      AND EXISTS (
        SELECT 1 FROM web_activity w 
        WHERE w.employee_id = e.id
        AND w.url NOT LIKE '[Incognito]%'
        AND w.url != 'Desktop' AND w.url != 'Unknown'
        AND w.url != 'New Tab' AND w.url != 'New tab'
        AND w.url != 'Speed Dial' AND length(w.url) < 150
        ${date ? "AND w.recorded_at::date=$1::date" : ""}
      )`;


    const empParams = [];
    if (date) { empParams.push(date); } // $1 for date in EXISTS
    if (employee_id) { empParams.push(employee_id); empQuery += ` AND e.id=$${empParams.length}`; }
    if (allowed) { empParams.push(allowed); empQuery += ` AND e.id = ANY($${empParams.length}::int[])`; }
    empQuery += ' ORDER BY e.name';
    const empResult = await pool.query(empQuery, empParams);
    const allEmps = empResult.rows;
    // Pack employees into pages of max 50 sites, never split employee across pages
    const siteLimit = 50;
    const pages_arr = [[]];
    for (const emp of allEmps) {
      const siteCount = await pool.query(
        `SELECT COUNT(DISTINCT url) as cnt FROM web_activity WHERE employee_id=$1`, [emp.id]
      );
      const cnt = parseInt(siteCount.rows[0].cnt) || 0;
      const curPage = pages_arr[pages_arr.length - 1];
      const curCount = curPage.reduce((a,e) => a + (e._cnt||0), 0);
      if (curPage.length > 0 && curCount + cnt > siteLimit) {
        pages_arr.push([Object.assign({}, emp, {_cnt: cnt})]);
      } else {
        curPage.push(Object.assign({}, emp, {_cnt: cnt}));
      }
    }
    const total = pages_arr.length;
    const pages = total;
    const emps = pages_arr[(page-1)] || [];
    if (!emps.length) return res.json({ rows: [], total, page, pages });
    const empIds = emps.map(e => e.id);
    let query = `WITH url_mins AS (
      SELECT w.employee_id, w.url, w.browser,
        COUNT(DISTINCT date_trunc('minute', w.recorded_at)) * 60 AS url_seconds,
        COUNT(*) AS visits
      FROM web_activity w
      JOIN employees e ON w.employee_id = e.id
      WHERE e.active = true
      AND w.url NOT LIKE '[Incognito]%'
      AND w.url != 'Desktop' AND w.url != 'Unknown'
      AND w.url != 'New Tab' AND w.url != 'New tab'
      AND w.url != 'Speed Dial' AND length(w.url) < 150
      AND w.employee_id = ANY($1::int[])
      ${date ? "AND w.recorded_at::date=$2" : ""}
      GROUP BY w.employee_id, w.url, w.browser
    ),
    emp_duty AS (
      -- Unique minutes per employee within shift (no double counting)
      SELECT w.employee_id,
        COUNT(DISTINCT CASE
          WHEN r.start_time IS NULL THEN date_trunc('minute', w.recorded_at)
          WHEN r.end_time > r.start_time THEN
            CASE WHEN w.recorded_at::time >= r.start_time AND w.recorded_at::time < r.end_time
              THEN date_trunc('minute', w.recorded_at) END
          ELSE
            CASE WHEN w.recorded_at::time >= r.start_time OR w.recorded_at::time < r.end_time
              THEN date_trunc('minute', w.recorded_at) END
        END) * 60 AS emp_duty_seconds,
        COUNT(DISTINCT date_trunc('minute', w.recorded_at)) * 60 AS emp_total_seconds
      FROM web_activity w
      JOIN employees e ON w.employee_id = e.id
      LEFT JOIN duty_rosters r ON e.roster_id = r.id
      WHERE e.active = true
      AND w.url NOT LIKE '[Incognito]%'
      AND w.url != 'Desktop' AND w.url != 'Unknown'
      AND w.url != 'New Tab' AND w.url != 'New tab'
      AND w.url != 'Speed Dial' AND length(w.url) < 150
      AND w.employee_id = ANY($1::int[])
      ${date ? "AND w.recorded_at::date=$2" : ""}
      GROUP BY w.employee_id
    )
    SELECT u.url, u.browser, e.name as employee_name, e.id as employee_id,
      u.url_seconds as total_seconds,
      u.url_seconds as active_seconds,
      u.visits,
      -- Per-URL duty seconds = proportional share of employee total duty
      ROUND(
        COALESCE(d.emp_duty_seconds, 0)::numeric
        * u.url_seconds::numeric
        / NULLIF(d.emp_total_seconds, 0)
      ) AS duty_seconds,
      d.emp_duty_seconds,
      d.emp_total_seconds
    FROM url_mins u
    JOIN employees e ON u.employee_id = e.id
    LEFT JOIN emp_duty d ON d.employee_id = u.employee_id
    WHERE e.active = true
    ORDER BY total_seconds DESC LIMIT 500`;
    const params = date ? [empIds, date] : [empIds];
    const result = await pool.query(query, params);

    // Attach roster info to each row
    const rosterMap = {};
    emps.forEach(function(e){ rosterMap[e.id] = e; });
    const rows = result.rows.map(function(r){
      const emp = rosterMap[r.employee_id] || {};
      return Object.assign({}, r, {
        shift_start: emp.shift_start || null,
        shift_end: emp.shift_end || null,
        roster_name: emp.roster_name || null
      });
    });
    res.json({ rows, total, page, pages, emps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/app-usage', requireLogin, async (req, res) => {
  try {
    const { employee_id, date } = req.query;
    const page = parseInt(req.query.page) || 1;
    const perPage = 2;

    // Get employees with roster info
    const allowed = getAllowedEmployees(req);
    const empParams = [];
    if (date) { empParams.push(date); }
    let empQuery = `SELECT e.id, e.name, e.department,
      r.start_time as shift_start, r.end_time as shift_end, r.name as roster_name
      FROM employees e LEFT JOIN duty_rosters r ON e.roster_id=r.id
      WHERE e.active=true
      AND EXISTS (SELECT 1 FROM app_usage a WHERE a.employee_id=e.id ${date ? `AND a.recorded_at::date=$${empParams.length}` : ''})`;
    if (employee_id) { empParams.push(employee_id); empQuery += ` AND e.id=$${empParams.length}`; }
    if (allowed) { empParams.push(allowed); empQuery += ` AND e.id = ANY($${empParams.length}::int[])`; }
    empQuery += ' ORDER BY e.name';
    const empResult = await pool.query(empQuery, empParams);
    const allEmps = empResult.rows;
    const total = allEmps.length;
    const pages = Math.ceil(total / perPage) || 1;
    const emps = allEmps.slice((page-1)*perPage, page*perPage);
    if (!emps.length) return res.json({ rows: [], total, page, pages });

    const empIds = emps.map(e => e.id);
    // For overnight shifts, also check next day
    let dateFilter = '';
    let params = [empIds];
    if (date) {
      const nd = new Date(date); nd.setDate(nd.getDate()+1);
      const nextDate = nd.toISOString().split('T')[0];
      params = [empIds, date, nextDate];
      // dateFilter uses $2 and $3
      dateFilter = `AND a.recorded_at::date IN ($2::date, $3::date)`;
    }
    let query = `WITH app_data AS (
      SELECT
        CASE
          WHEN LOWER(a.app_name) = 'excel' THEN 'Microsoft Excel'
          WHEN LOWER(a.app_name) = 'msedge' THEN 'Microsoft Edge'
          WHEN LOWER(a.app_name) = 'chrome' THEN 'Google Chrome'
          WHEN LOWER(a.app_name) = 'firefox' THEN 'Firefox'
          WHEN LOWER(a.app_name) = 'brave' THEN 'Brave Browser'
          WHEN LOWER(a.app_name) = 'winword' THEN 'Microsoft Word'
          WHEN LOWER(a.app_name) = 'powerpnt' THEN 'PowerPoint'
          WHEN LOWER(a.app_name) = 'outlook' THEN 'Outlook'
          WHEN LOWER(a.app_name) = 'teams' THEN 'Microsoft Teams'
          WHEN LOWER(a.app_name) = 'code' THEN 'VS Code'
          WHEN LOWER(a.app_name) = 'opera' THEN 'Opera Browser'
          WHEN LOWER(a.app_name) = 'slack' THEN 'Slack'
          WHEN LOWER(a.app_name) = 'zoom' THEN 'Zoom'
          WHEN LOWER(a.app_name) = 'notepad++' THEN 'Notepad++'
          WHEN LOWER(a.app_name) = 'notepad' THEN 'Notepad'
          WHEN LOWER(a.app_name) = 'windowsterminal' THEN 'Windows Terminal'
          WHEN LOWER(a.app_name) = 'powershell_ise' THEN 'PowerShell ISE'
          WHEN LOWER(a.app_name) = 'powershell' THEN 'PowerShell'
          WHEN LOWER(a.app_name) = 'cmd' THEN 'Command Prompt'
          WHEN LOWER(a.app_name) = 'explorer' THEN 'File Explorer'
          WHEN LOWER(a.app_name) = 'ultraviewer_desktop' THEN 'UltraViewer'
          WHEN LOWER(a.app_name) = 'screenrec' THEN 'ScreenRec'
          WHEN LOWER(a.app_name) = 'putty' THEN 'PuTTY'
          WHEN LOWER(a.app_name) = 'snippingtool' THEN 'Snipping Tool'
          WHEN LOWER(a.app_name) = 'm365copilot' THEN 'Microsoft Copilot'
          WHEN LOWER(a.app_name) = 'msteams' THEN 'Microsoft Teams'
          WHEN LOWER(a.app_name) = 'wps' THEN 'WPS Office'
          WHEN LOWER(a.app_name) = 'acrobat' THEN 'Adobe Acrobat'
          WHEN LOWER(a.app_name) = 'acrord32' THEN 'Adobe Acrobat Reader'
          WHEN LOWER(a.app_name) = 'taskmgr' THEN 'Task Manager'
          WHEN LOWER(a.app_name) = 'mspaint' THEN 'MS Paint'
          WHEN LOWER(a.app_name) = 'whatsapp' THEN 'WhatsApp'
          WHEN LOWER(a.app_name) = 'telegram' THEN 'Telegram'
          WHEN LOWER(a.app_name) = 'winscp' THEN 'WinSCP'
          ELSE INITCAP(LOWER(a.app_name))
        END as app_name,
        a.employee_id,
        e.name as employee_name,
        -- unique minutes this app appeared in (deduplicated)
COUNT(DISTINCT DATE_TRUNC('minute', a.recorded_at)) as app_minutes,
        COUNT(a.id) * 60 as total_seconds

      FROM app_usage a JOIN employees e ON a.employee_id=e.id
      LEFT JOIN duty_rosters r ON e.roster_id=r.id
      WHERE e.active=true
        AND LOWER(a.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost','textinputhost')
        AND a.app_name NOT SIMILAR TO '[0-9]%'
        AND a.employee_id = ANY($1::int[])
        ${date ? dateFilter : ''}
        -- Filter to shift window using JOIN
        AND CASE
          WHEN r.start_time IS NULL THEN true
          WHEN r.end_time > r.start_time THEN
            a.recorded_at::time >= r.start_time AND a.recorded_at::time < r.end_time
          ELSE
            a.recorded_at::time >= r.start_time OR a.recorded_at::time < r.end_time
        END
      GROUP BY 1, a.employee_id, e.name
    ),
    emp_totals AS (
      SELECT employee_id,
        COUNT(DISTINCT DATE_TRUNC('minute', a.recorded_at)) * 60 as unique_total_seconds
      FROM app_usage a JOIN employees e ON a.employee_id=e.id
      LEFT JOIN duty_rosters r ON e.roster_id=r.id
      WHERE e.active=true AND a.employee_id = ANY($1::int[])
        ${date ? dateFilter : ''}
        AND CASE
          WHEN r.start_time IS NULL THEN true
          WHEN r.end_time > r.start_time THEN
            a.recorded_at::time >= r.start_time AND a.recorded_at::time < r.end_time
          ELSE
            a.recorded_at::time >= r.start_time OR a.recorded_at::time < r.end_time
        END
      GROUP BY employee_id
    )
SELECT d.app_name, d.employee_name, d.employee_id,
      d.total_seconds,
      COALESCE(t.unique_total_seconds, d.total_seconds) as emp_unique_total,
      (SELECT COUNT(DISTINCT DATE_TRUNC('minute', a2.recorded_at)) * 60
       FROM app_usage a2
       JOIN employees e2 ON a2.employee_id = e2.id
       LEFT JOIN duty_rosters r ON e2.roster_id = r.id
       WHERE a2.employee_id = d.employee_id
         AND LOWER(a2.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost','textinputhost')
         ${date ? `AND a2.recorded_at::date IN ($2::date, $3::date)` : ''}
         AND CASE
           WHEN r.start_time IS NULL THEN true
           WHEN r.end_time > r.start_time THEN
             a2.recorded_at::time >= r.start_time AND a2.recorded_at::time < r.end_time
           ELSE
             a2.recorded_at::time >= r.start_time OR a2.recorded_at::time < r.end_time
         END
      ) as shift_active_seconds
    FROM app_data d
    LEFT JOIN emp_totals t ON d.employee_id = t.employee_id
    ORDER BY d.employee_id, d.total_seconds DESC
    `;


    const result = await pool.query(query, params);

    // Attach roster info
    const rosterMap = {};
    emps.forEach(e => { rosterMap[e.id] = e; });
    const rows = result.rows.map(r => Object.assign({}, r, {
      shift_start: rosterMap[r.employee_id]?.shift_start || null,
      shift_end: rosterMap[r.employee_id]?.shift_end || null,
      roster_name: rosterMap[r.employee_id]?.roster_name || null
    }));

    res.json({ rows, total, page, pages, emps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, e.name as employee_name
      FROM alerts a JOIN employees e ON a.employee_id=e.id
      WHERE e.active=true ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/:id/resolve', requireLogin, async (req, res) => {
  await pool.query('UPDATE alerts SET resolved=true WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});


// Agent self-registration by email - simple IP rate limit (10 req/min per IP)
const _tokenRateMap = new Map();
app.get('/api/agent/token/:email', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = _tokenRateMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  _tokenRateMap.set(ip, entry);
  if (entry.count > 10) return res.status(429).json({ error: 'Too many requests' });
  try {
    const result = await pool.query(
      'SELECT agent_token FROM employees WHERE email=$1 AND active=true',
      [req.params.email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ token: result.rows[0].agent_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download agent zip
app.get('/download/agent', (req, res) => {
  const file = '/home/workpulse/WorkPulse-Agent-Windows.zip';
  if (!fs.existsSync(file)) {
    return res.status(404).send('File not found: ' + file);
  }
  res.setHeader('Content-Disposition', 'attachment; filename=WorkPulse-Agent-Windows.zip');
  res.setHeader('Content-Type', 'application/zip');
  res.sendFile(file);
});

app.get('/download/launch-vbs', (req, res) => {
  const file = '/home/workpulse/workpulse-app/winagent/launch.vbs';
  res.setHeader('Content-Disposition', 'attachment; filename=launch.vbs');
  res.sendFile(file);
});

app.get('/download/agent-exe', (req, res) => {
  const file = '/home/workpulse/WorkPulse-Agent.exe';
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Disposition', 'attachment; filename=WorkPulse-Agent.exe');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(file);
});

// Download browser extension
app.get('/download/extension', (req, res) => {
  const file = '/home/workpulse/WorkPulse-Extension.zip';
  if (!fs.existsSync(file)) return res.status(404).send('Extension not found');
  res.setHeader('Content-Disposition', 'attachment; filename=WorkPulse-Extension.zip');
  res.setHeader('Content-Type', 'application/zip');
  res.sendFile(file);
});

// Serve dashboard for all other routes
app.get('/api/dashboard/screenshot-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    let query = `SELECT s.recorded_at::date::text as date, COUNT(*) as count FROM screenshots s JOIN employees e ON s.employee_id=e.id WHERE e.active=true AND s.recorded_at >= NOW() - INTERVAL '90 days'`;
    const params = [];
    if (employee_id) { params.push(employee_id); query += ` AND s.employee_id=$${params.length}`; }
    query += ' GROUP BY s.recorded_at::date ORDER BY date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Dates with web activity (for calendar)
app.get('/api/dashboard/web-activity-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    const params = [];
    let query = `SELECT w.recorded_at::date::text as date, COUNT(*) as count FROM web_activity w JOIN employees e ON w.employee_id=e.id WHERE e.active=true AND w.recorded_at >= NOW() - INTERVAL '90 days'`;
    if (employee_id) { params.push(employee_id); query += ` AND w.employee_id=$${params.length}`; }
    if (allowed) { params.push(allowed); query += ` AND w.employee_id = ANY($${params.length}::int[])`; }
    query += ' GROUP BY w.recorded_at::date ORDER BY date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dates with app usage (for calendar)
app.get('/api/dashboard/app-usage-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    const params = [];
    let query = `SELECT a.recorded_at::date::text as date, COUNT(*) as count FROM app_usage a JOIN employees e ON a.employee_id=e.id WHERE e.active=true AND a.recorded_at >= NOW() - INTERVAL '90 days'`;
    if (employee_id) { params.push(employee_id); query += ` AND a.employee_id=$${params.length}`; }
    if (allowed) { params.push(allowed); query += ` AND a.employee_id = ANY($${params.length}::int[])`; }
    query += ' GROUP BY a.recorded_at::date ORDER BY date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get deleted employees
app.get("/api/employees/deleted", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT *, EXTRACT(DAY FROM NOW()-deleted_at) as days_deleted FROM employees WHERE active=false AND deleted_at > NOW()-INTERVAL '10 days' ORDER BY deleted_at DESC`);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Permanently delete employee and all their data
app.delete("/api/employees/:id/permanent", requireLogin, requireAdmin, async (req, res) => {
  const id = req.params.id;
const empInfo = await pool.query('SELECT name, email FROM employees WHERE id=$1', [id]);
    const empName = empInfo.rows[0] ? empInfo.rows[0].name + ' (' + empInfo.rows[0].email + ')' : 'ID: ' + id;

  try {
    // Delete screenshot files
    const shots = await pool.query('SELECT filename FROM screenshots WHERE employee_id=$1', [id]);
    const fs = require('fs');
    const path = require('path');
    shots.rows.forEach(function(s){
      const f = path.join('/home/workpulse/workpulse-app/screenshots', s.filename);
      if(fs.existsSync(f)) fs.unlinkSync(f);
    });
// Delete all DB data
    await pool.query('DELETE FROM screenshots WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM web_activity WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM app_usage WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM heartbeats WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM system_events WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM alerts WHERE employee_id=$1', [id]);
    await pool.query('DELETE FROM user_employee_access WHERE employee_id=$1', [id]);
await pool.query('DELETE FROM employees WHERE id=$1', [id]);
    await auditLog(req, 'Employee Permanently Deleted', empName + ' (ID: ' + id + ')');

    res.json({ success: true });

  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Restore deleted employee
app.post("/api/employees/:id/restore", requireLogin, async (req, res) => {
  try {
    const emp = await pool.query('SELECT name,email FROM employees WHERE id=$1', [req.params.id]);
    await pool.query("UPDATE employees SET active=true, deleted_at=NULL WHERE id=$1", [req.params.id]);
    await auditLog(req, 'Employee Restored', emp.rows[0]?.name + ' (' + emp.rows[0]?.email + ')');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// Update screenshot interval
app.post("/api/employees/:id/settings", requireLogin, async (req, res) => {
  try {
    const { screenshot_interval } = req.body;
    const emp = await pool.query('SELECT name FROM employees WHERE id=$1', [req.params.id]);
    await pool.query("UPDATE employees SET screenshot_interval=$1 WHERE id=$2", [screenshot_interval, req.params.id]);
    await auditLog(req, 'Screenshot Interval Changed', emp.rows[0]?.name + ' → ' + screenshot_interval + ' mins');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// Agent gets its settings
app.get("/api/agent/settings", requireAgent, async (req, res) => {
  try {
    const result = await pool.query("SELECT screenshot_interval FROM employees WHERE id=$1", [req.employee.id]);
    res.json({ screenshot_interval: result.rows[0].screenshot_interval || 5 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/employees/:id/stats', requireLogin, async (req, res) => {
  try {
    const id = req.params.id;
    const screenshots = await pool.query('SELECT COUNT(*) FROM screenshots WHERE employee_id=$1', [id]);
    const webTotal = await pool.query('SELECT COUNT(*) FROM web_activity WHERE employee_id=$1', [id]);
    const webNormal = await pool.query("SELECT COUNT(*) FROM web_activity WHERE employee_id=$1 AND url NOT LIKE '[Incognito]%'", [id]);
    const webIncognito = await pool.query("SELECT COUNT(*) FROM web_activity WHERE employee_id=$1 AND url LIKE '[Incognito]%'", [id]);
    const appUsage = await pool.query('SELECT COUNT(DISTINCT app_name) FROM app_usage WHERE employee_id=$1', [id]);
    res.json({
      screenshots: parseInt(screenshots.rows[0].count),
      web_total: parseInt(webTotal.rows[0].count),
      web_normal: parseInt(webNormal.rows[0].count),
      web_incognito: parseInt(webIncognito.rows[0].count),
      apps: parseInt(appUsage.rows[0].count)
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- DASHBOARD USER MANAGEMENT ----
app.get('/api/dashboard-users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, 
        (SELECT COUNT(*) FROM user_employee_access WHERE user_id=u.id) as employee_count
      FROM dashboard_users u
      WHERE u.active=true
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard-users', requireLogin, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const hash = await require('bcryptjs').hash(password, 10);
    const result = await pool.query(
      'INSERT INTO dashboard_users (name, email, password_hash, role, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role',
      [name, email, hash, role || 'user', req.session.adminId]
    );
    await auditLog(req, 'Monitoring User Created', name + ' (' + email + ') - Role: ' + (role||'user'));
    res.json(result.rows[0]);


  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/dashboard-users/:id', requireLogin, requireAdmin, async (req, res) => {
  const u = await pool.query('SELECT name,email FROM dashboard_users WHERE id=$1', [req.params.id]);
  await pool.query('UPDATE dashboard_users SET active=false WHERE id=$1', [req.params.id]);
  await auditLog(req, 'Monitoring User Removed', u.rows[0]?.name + ' (' + u.rows[0]?.email + ')');
  res.json({ success: true });
});


app.post('/api/dashboard-users/:id/employees', requireLogin, requireAdmin, async (req, res) => {
  const { employee_ids } = req.body;
  try {
    await pool.query('DELETE FROM user_employee_access WHERE user_id=$1', [req.params.id]);
    for (const empId of employee_ids) {
      await pool.query('INSERT INTO user_employee_access (user_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, empId]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard-users/:id/employees', requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT employee_id FROM user_employee_access WHERE user_id=$1', [req.params.id]);
    res.json(result.rows.map(r => r.employee_id));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin-users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM admins ORDER BY id');
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dashboard-users/:id/reset-password', requireLogin, requireAdmin, async (req, res) => {
  const { password, type } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password too short' });
  const bcrypt = require('bcryptjs');
  try {
    const hash = await bcrypt.hash(password, 10);
    if (type === 'admin') {
      const adminRes = await pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2 RETURNING id', [hash, req.params.id]);
      if (adminRes.rows.length) {
        await auditLog(req, 'Admin Password Reset', 'ID: ' + req.params.id);
        return res.json({ success: true });
      }
    } else {
      const userRes = await pool.query('UPDATE dashboard_users SET password_hash=$1 WHERE id=$2 RETURNING id', [hash, req.params.id]);
      if (userRes.rows.length) {
        await auditLog(req, 'User Password Reset', 'ID: ' + req.params.id);
        return res.json({ success: true });
      }
    }
    res.status(404).json({ error: 'User not found' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});



// ---- USER LOGIN ----
app.post('/api/user-login', async (req, res) => {
  const { email, password } = req.body;
  const bcrypt = require('bcryptjs');
  try {
    // Check MFA setting
    const mfaCfg = await pool.query('SELECT mfa_enabled FROM email_config LIMIT 1');
    const mfaOn  = mfaCfg.rows[0]?.mfa_enabled === true;

    let loginData = null;

    const adminResult = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
    if (adminResult.rows.length) {
      const admin = adminResult.rows[0];
      const match = await bcrypt.compare(password, admin.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });
      loginData = { adminId: admin.id, adminName: admin.name, adminRole: admin.role || 'admin', isUser: false, email: admin.email };
    } else {
      const userResult = await pool.query('SELECT * FROM dashboard_users WHERE email=$1 AND active=true', [email]);
      if (!userResult.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
      const user = userResult.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });
      const empResult = await pool.query('SELECT employee_id FROM user_employee_access WHERE user_id=$1', [user.id]);
      loginData = { adminId: user.id, adminName: user.name, adminRole: user.role, isUser: true, email: user.email, allowedEmployees: empResult.rows.map(r => r.employee_id) };
    }

    // Check per-user TOTP first
    let userTotpEnabled = false;
    try {
      if (!loginData.isUser) {
        const tr = await pool.query('SELECT totp_enabled FROM admins WHERE id=$1', [loginData.adminId]);
        userTotpEnabled = tr.rows[0]?.totp_enabled === true;
      } else {
        const tr = await pool.query('SELECT totp_enabled FROM dashboard_users WHERE id=$1', [loginData.adminId]);
        userTotpEnabled = tr.rows[0]?.totp_enabled === true;
      }
    } catch(e) {}

    if (userTotpEnabled) {
      req.session.pendingLogin = loginData;
      return res.json({ totp_required: true });
    }

    if (mfaOn) {
      // Store pending login, send OTP
      req.session.pendingLogin = loginData;
      const otp = generateOTP();
      await pool.query("INSERT INTO otp_tokens (email,otp,purpose,expires_at) VALUES ($1,$2,'mfa',NOW()+INTERVAL '10 minutes')", [loginData.email, otp]);
      await sendOTP(loginData.email, otp, 'mfa');
      return res.json({ mfa_required: true, email: loginData.email });
    }

    // No MFA — log in directly
    req.session.adminId   = loginData.adminId;
    req.session.adminName = loginData.adminName;
    req.session.adminRole = loginData.adminRole;
    req.session.isUser    = loginData.isUser;
    if (loginData.allowedEmployees) req.session.allowedEmployees = loginData.allowedEmployees;
    return res.json({ success: true, name: loginData.adminName, role: loginData.adminRole });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ---- DATA RETENTION ----
app.post('/api/employees/:id/retention', requireLogin, requireAdmin, async (req, res) => {
  const { days } = req.body;
  try {
    const emp = await pool.query('SELECT name FROM employees WHERE id=$1', [req.params.id]);
    await pool.query('UPDATE employees SET data_retention_days=$1 WHERE id=$2', [days, req.params.id]);
    await auditLog(req, 'Data Retention Changed', emp.rows[0]?.name + ' → ' + days + ' days');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


async function runDataRetention() {
  try {
    const employees = await pool.query('SELECT id, data_retention_days FROM employees WHERE data_retention_days > 0 AND active=true');
    for (const emp of employees.rows) {
      const days = emp.data_retention_days;
      await pool.query(`DELETE FROM screenshots WHERE employee_id=$1 AND recorded_at < NOW()-INTERVAL '${days} days'`, [emp.id]);
      await pool.query(`DELETE FROM web_activity WHERE employee_id=$1 AND recorded_at < NOW()-INTERVAL '${days} days'`, [emp.id]);
      await pool.query(`DELETE FROM app_usage WHERE employee_id=$1 AND recorded_at < NOW()-INTERVAL '${days} days'`, [emp.id]);
      await pool.query(`DELETE FROM heartbeats WHERE employee_id=$1 AND recorded_at < NOW()-INTERVAL '${days} days'`, [emp.id]);
      console.log('[Retention] Cleaned data for employee', emp.id, '- keeping last', days, 'days');
    }
  } catch(err) { console.error('[Retention] Error:', err.message); }
}

setInterval(runDataRetention, 24 * 60 * 60 * 1000);
runDataRetention();

// Auto permanently delete expired deleted employees
async function runDeletedCleanup() {
  try {
    const expired = await pool.query(
      `SELECT id FROM employees WHERE active=false AND deleted_at < NOW() - INTERVAL '10 days'`
    );
    for (const emp of expired.rows) {
      const shots = await pool.query('SELECT filename FROM screenshots WHERE employee_id=$1', [emp.id]);
      const fs = require('fs');
      const path = require('path');
      shots.rows.forEach(function(s){
        const f = path.join('/home/workpulse/workpulse-app/screenshots', s.filename);
        if(fs.existsSync(f)) fs.unlinkSync(f);
      });
      await pool.query('DELETE FROM screenshots WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM web_activity WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM app_usage WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM heartbeats WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM system_events WHERE employee_id=$1', [emp.id]);
	await pool.query('DELETE FROM alerts WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM user_employee_access WHERE employee_id=$1', [emp.id]);
      await pool.query('DELETE FROM employees WHERE id=$1', [emp.id]);
      console.log('[Cleanup] Permanently deleted expired employee id:', emp.id);
    }
  } catch(err) { console.error('[Cleanup] Error:', err.message); }
}
setInterval(runDeletedCleanup, 24 * 60 * 60 * 1000);
runDeletedCleanup();

// Extension web activity endpoint
app.post("/api/agent/web-activity", requireAgent, async (req, res) => {
  const { urls } = req.body;
  const empId = req.employee.id;
  try {
    if (urls && urls.length) {
      for (const u of urls) {
        await pool.query("INSERT INTO web_activity (employee_id, url, duration_seconds, browser, full_url) VALUES ($1,$2,$3,$4,$5)", [empId, u.url, u.seconds || 0, u.browser || "Browser", u.full_url || u.url]);
      }
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// ---- DUTY ROSTER ----
// Auto-create table and seed default rosters
(async function initDutyRosters() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS duty_rosters (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        description VARCHAR(200),
        color VARCHAR(10) DEFAULT '#00e5ff',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS roster_id INTEGER REFERENCES duty_rosters(id) ON DELETE SET NULL
    `);
    // Seed default rosters if empty
    const existing = await pool.query('SELECT COUNT(*) FROM duty_rosters');
    if (parseInt(existing.rows[0].count) === 0) {
      const defaults = [
        ['General Shift (9AM–6PM)',   '09:00', '18:00', 'Standard office hours',    '#00e5ff'],
        ['Shift A (9:30AM–6:30PM)',   '09:30', '18:30', 'Slightly later start',     '#10b981'],
        ['Shift B (10AM–7PM)',        '10:00', '19:00', 'Late morning shift',        '#7c3aed'],
        ['Shift C (12:30PM–9:30PM)',  '12:30', '21:30', 'Afternoon shift',           '#f59e0b'],
        ['Evening (6PM–3AM)',         '18:00', '03:00', 'Evening/night shift',       '#ef4444'],
        ['Night (7PM–4AM)',           '19:00', '04:00', 'Late night shift',          '#f472b6'],
      ];
      for (const [name, start, end, desc, color] of defaults) {
        await pool.query(
          'INSERT INTO duty_rosters (name, start_time, end_time, description, color) VALUES ($1,$2,$3,$4,$5)',
          [name, start, end, desc, color]
        );
      }
      console.log('[DutyRoster] Default rosters seeded.');
    }
  } catch(err) { console.error('[DutyRoster] Init error:', err.message); }
})();

// Get all rosters
app.get('/api/rosters', requireLogin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM duty_rosters WHERE active=true ORDER BY start_time');
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create roster
app.post('/api/rosters', requireLogin, requireAdmin, async (req, res) => {
  const { name, start_time, end_time, description, color } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO duty_rosters (name, start_time, end_time, description, color) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, start_time, end_time, description || '', color || '#00e5ff']
    );
    await auditLog(req, 'Roster Created', name + ' (' + start_time + ' - ' + end_time + ')');
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Update roster
app.put('/api/rosters/:id', requireLogin, requireAdmin, async (req, res) => {
  const { name, start_time, end_time, description, color } = req.body;
  try {
    const result = await pool.query(
      'UPDATE duty_rosters SET name=$1, start_time=$2, end_time=$3, description=$4, color=$5 WHERE id=$6 RETURNING *',
      [name, start_time, end_time, description || '', color || '#00e5ff', req.params.id]
    );
    await auditLog(req, 'Roster Updated', name + ' (' + start_time + ' - ' + end_time + ')');
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete roster
app.delete('/api/rosters/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE duty_rosters SET active=false WHERE id=$1', [req.params.id]);
    await auditLog(req, 'Roster Deleted', 'ID: ' + req.params.id);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Assign roster to employee
app.post('/api/employees/:id/roster', requireLogin, async (req, res) => {
  const { roster_id } = req.body;
  try {
    await pool.query('UPDATE employees SET roster_id=$1 WHERE id=$2', [roster_id || null, req.params.id]);
    await auditLog(req, 'Roster Assigned', 'Employee ID: ' + req.params.id + ' Roster: ' + (roster_id||'None'));
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Update employee department
app.post("/api/employees/:id/department", requireLogin, requireAdmin, async (req, res) => {
  const { department } = req.body;
  try {
    const emp = await pool.query("SELECT name FROM employees WHERE id=$1", [req.params.id]);
    await pool.query("UPDATE employees SET department=$1 WHERE id=$2", [department, req.params.id]);
    await auditLog(req, "Department Changed", emp.rows[0]?.name + " -> " + department);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});




app.post('/api/agent/system-event', requireAgent, async (req, res) => {
  const { event_type, recorded_at } = req.body;
  const valid = ['startup','shutdown','locked','unlocked','sleep','hibernate','idle_lock','wakeup'];
  if (!valid.includes(event_type)) return res.status(400).json({ error: 'Invalid event' });
  try {
    if (recorded_at) {
      await pool.query('INSERT INTO system_events (employee_id, event_type, recorded_at) VALUES ($1,$2,$3)', [req.employee.id, event_type, new Date(recorded_at)]);
    } else {
      await pool.query('INSERT INTO system_events (employee_id, event_type) VALUES ($1,$2)', [req.employee.id, event_type]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/system-activity', requireLogin, async (req, res) => {
  const { employee_id, date } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  try {
    const allowed = getAllowedEmployees(req);
    const params = [];
    let where = 'WHERE e.active=true';
    if (employee_id) { params.push(employee_id); where += ` AND s.employee_id=$${params.length}`; }
    if (date) { params.push(date); where += ` AND s.recorded_at::date=$${params.length}`; }
    if (allowed) { params.push(allowed); where += ` AND s.employee_id = ANY($${params.length}::int[])`; }
    const countRes = await pool.query(`SELECT COUNT(*) FROM system_events s JOIN employees e ON s.employee_id=e.id ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT s.*, e.name as employee_name FROM system_events s JOIN employees e ON s.employee_id=e.id ${where} ORDER BY s.recorded_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ rows: result.rows, total, page, pages: Math.ceil(total/limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/system-activity-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    const params = [];
    let where = 'WHERE e.active=true';
    if (employee_id) { params.push(employee_id); where += ` AND s.employee_id=$${params.length}`; }
    if (allowed) { params.push(allowed); where += ` AND s.employee_id = ANY($${params.length}::int[])`; }
    const result = await pool.query(
      `SELECT s.recorded_at::date::text as date, COUNT(*) as count FROM system_events s JOIN employees e ON s.employee_id=e.id ${where} GROUP BY s.recorded_at::date ORDER BY date DESC`,
      params
    );
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


app.get('/download/agent-js', (req, res) => {
  const file = '/home/workpulse/workpulse-app/winagent/agent.js';
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Disposition', 'attachment; filename=agent.js');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(file);
});

app.get('/api/audit-log', requireLogin, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const countRes = await pool.query('SELECT COUNT(*) FROM audit_log');
    const total = parseInt(countRes.rows[0].count);
    const result = await pool.query(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    res.json({ rows: result.rows, total, page, pages: Math.ceil(total/limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Departments
app.get('/api/departments', requireLogin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name');
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/departments', requireLogin, requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const result = await pool.query('INSERT INTO departments (name) VALUES ($1) RETURNING *', [name]);
    await auditLog(req, 'Department Created', name);
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/departments/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const d = await pool.query('SELECT name FROM departments WHERE id=$1', [req.params.id]);
    const name = d.rows[0]?.name;
    const empCount = await pool.query('SELECT COUNT(*) FROM employees WHERE department=$1 AND active=true', [name]);
    if (parseInt(empCount.rows[0].count) > 0) return res.status(400).json({ error: 'Department has active employees. Reassign them first.' });
    await pool.query('DELETE FROM departments WHERE id=$1', [req.params.id]);
    await auditLog(req, 'Department Deleted', name);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});



// ---- BACKUP & RESTORE ----
const { execFile } = require('child_process');
const multerBackup = require('multer')({ dest: 'backups/tmp/' });

// Ensure backups directory exists
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// List backup history
app.get('/api/admin/backup/history', requireLogin, requireAdmin, async (req, res) => {
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.wpbackup') || f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(backupsDir, f));
        return { filename: f, size_kb: Math.round(stat.size / 1024), created_at: stat.mtime };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(files);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create backup — runs pg_dump, streams the file back
app.post('/api/admin/backup', requireLogin, requireAdmin, async (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `workpulse-backup-${ts}.wpbackup`;
    const filepath = path.join(backupsDir, filename);

    const env = Object.assign({}, process.env, {
      PGPASSWORD: process.env.DB_PASSWORD || ''
    });

    const args = [
      '-h', process.env.DB_HOST || 'localhost',
      '-p', process.env.DB_PORT || '5432',
      '-U', process.env.DB_USER || 'workpulse_user',
      '-d', process.env.DB_NAME || 'workpulse',
      '--no-password',
      '-f', filepath
    ];

    execFile('pg_dump', args, { env }, async (err) => {
      if (err) {
        console.error('[Backup] pg_dump error:', err.message);
        return res.status(500).json({ error: 'pg_dump failed: ' + err.message });
      }
      await auditLog(req, 'Backup Created', filename);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      const stream = fs.createReadStream(filepath);
      stream.pipe(res);
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Download a stored backup by filename
app.get('/api/admin/backup/download/:filename', requireLogin, requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(backupsDir, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filepath).pipe(res);
});

// Delete a stored backup
app.delete('/api/admin/backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(backupsDir, filename);
  try {
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filepath);
    await auditLog(req, 'Backup Deleted', filename);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Restore from uploaded backup — streams progress via NDJSON
app.post('/api/admin/restore', requireLogin, requireAdmin, multerBackup.single('backup'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (msg, type, pct, label) => {
    res.write(JSON.stringify({ msg, type: type||'info', pct: pct||0, label: label||'' }) + '\n');
  };

  if (!req.file) {
    send('No backup file uploaded.', 'err'); res.end(); return;
  }

  const tmpFile = req.file.path;

  try {
    send('Backup file received: ' + req.file.originalname, 'ok', 15, 'File received');

    // Save a copy to backups dir before restoring
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const savedName = `restore-${ts}.wpbackup`;
    fs.copyFileSync(tmpFile, path.join(backupsDir, savedName));
    send('Backup saved to history: ' + savedName, 'dim', 20);

    send('Starting database restore via psql…', 'info', 25, 'Restoring…');

    const env = Object.assign({}, process.env, {
      PGPASSWORD: process.env.DB_PASSWORD || ''
    });

    const args = [
      '-h', process.env.DB_HOST || 'localhost',
      '-p', process.env.DB_PORT || '5432',
      '-U', process.env.DB_USER || 'workpulse_user',
      '-d', process.env.DB_NAME || 'workpulse',
      '--no-password',
      '-f', tmpFile
    ];

    send('Dropping existing tables…', 'warn', 30, 'Clearing DB…');

    // Drop all tables first using pool
    await pool.query(`
      DO $$ DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    send('✓ Existing tables dropped', 'ok', 40, 'Tables dropped');

    execFile('psql', args, { env }, async (err, stdout, stderr) => {
      // Clean up tmp file
      try { fs.unlinkSync(tmpFile); } catch(e) {}

      if (err) {
        send('✗ psql error: ' + err.message, 'err', 0, 'Failed');
        res.write(JSON.stringify({ error: err.message }) + '\n');
        res.end(); return;
      }

      if (stderr && stderr.trim()) {
        send('Note: ' + stderr.trim().split('\n')[0], 'warn', 90);
      }

      send('✓ Database restored successfully!', 'ok', 95, 'Almost done…');
      await auditLog(req, 'Database Restored', req.file.originalname);
      send('✓ Audit log updated', 'dim', 98);
      send('🎉 Restore complete! Refresh the page to see your data.', 'ok', 100, 'Done!');
      res.write(JSON.stringify({ done: true, pct: 100, label: 'Done!', msg: 'Restore complete.' }) + '\n');
      res.end();
    });

  } catch(err) {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    send('✗ Error: ' + err.message, 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});
// Screenshot backup — tar.gz of screenshots folder
app.post('/api/admin/backup/screenshots', requireLogin, requireAdmin, async (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `workpulse-screenshots-${ts}.tar.gz`;
    const filepath = path.join(backupsDir, filename);
    const ssDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(ssDir)) return res.status(404).json({ error: 'Screenshots directory not found' });
    const { execFile } = require('child_process');
    execFile('tar', ['-czf', filepath, '-C', __dirname, 'screenshots'], {}, async (err) => {
      if (err) return res.status(500).json({ error: 'tar failed: ' + err.message });
      await auditLog(req, 'Screenshots Backup Created', filename);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/gzip');
      fs.createReadStream(filepath).pipe(res);
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// List screenshot backups on server
app.get('/api/admin/backup/screenshots/list', requireLogin, requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(backupsDir, f));
        return { filename: f, size_mb: (stat.size/1024/1024).toFixed(1), created_at: stat.mtime };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(files);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Screenshot upload to server backups folder (saves file, doesn't extract yet)
app.post('/api/admin/backup/screenshots/upload', requireLogin, requireAdmin, multerBackup.single('screenshots'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const origName = req.file.originalname || 'uploaded-screenshots.tar.gz';
    const destPath = path.join(backupsDir, origName);
    fs.renameSync(req.file.path, destPath);
    console.log('[SS Upload] Saved to:', destPath);
    await auditLog(req, 'Screenshots Backup Uploaded', origName);
    res.json({ success: true, filename: origName });
  } catch(e) {
    console.error('[SS Upload] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Screenshot restore — extract tar.gz over screenshots folder
app.post('/api/admin/restore/screenshots', requireLogin, requireAdmin, multerBackup.single('screenshots'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (msg, type, pct, label) => res.write(JSON.stringify({ msg, type: type||'info', pct: pct||0, label: label||'' }) + '\n');

  if (!req.file) {
    console.error('[SS Restore] No file in req.file — multer tmp dir issue?');
    send('No file uploaded.', 'err'); res.end(); return;
  }

  const tmpFile = req.file.path;
  console.log('[SS Restore] File received:', req.file.originalname, req.file.size, 'bytes');

  try {
    send('File received: ' + req.file.originalname, 'ok', 10, 'File ready');
    const ssDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
    send('Extracting screenshots…', 'info', 30, 'Extracting…');
    console.log('[SS Restore] Extracting to:', __dirname);
    const { execFile } = require('child_process');
    execFile('tar', ['-xzf', tmpFile, '-C', __dirname], {}, async (err) => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (err) {
        console.error('[SS Restore] tar failed:', err.message);
        send('✗ Extract failed: ' + err.message, 'err', 0, 'Failed');
        res.write(JSON.stringify({ error: err.message }) + '\n');
        res.end(); return;
      }
      console.log('[SS Restore] Extraction complete!');
      send('✓ Screenshots restored!', 'ok', 95, 'Done!');
      await auditLog(req, 'Screenshots Restored', req.file.originalname);
      send('🎉 Screenshot restore complete!', 'ok', 100, 'Done!');
      res.write(JSON.stringify({ done: true, pct: 100, label: 'Done!', msg: 'Done.' }) + '\n');
      res.end();
    });
  } catch(err) {
    console.error('[SS Restore] Error:', err.message);
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    send('✗ ' + err.message, 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});
// ---- END BACKUP & RESTORE ----

// ============================================================
// ---- REPORTS (Excel export) --------------------------------
// ============================================================
const ExcelJS = require('exceljs');

app.get('/api/admin/report', requireLogin, requireAdmin, async (req, res) => {
  const { employee_id, from, to } = req.query;
  const inclSummary = req.query.summary !== 'false';
  const inclWeb     = req.query.web     !== 'false';
  const inclApps    = req.query.apps    !== 'false';
  const inclDaily   = req.query.daily   !== 'false';

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'WorkPulse';
    wb.created = new Date();

    // Helper styles
    const headerFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0D1117' } };
    const accentFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF00E5FF' } };
    const greenFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF10B981' } };
    const redFill     = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEF4444' } };
    const amberFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF59E0B' } };
    const darkText    = { argb:'FF0D1117' };
    const lightText   = { argb:'FFE2E8F0' };
    const borderThin  = { style:'thin', color:{ argb:'FF1E242E' } };
    const allBorders  = { top:borderThin, left:borderThin, bottom:borderThin, right:borderThin };

    function styleHeader(row, fillColor) {
      row.eachCell(function(cell) {
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: fillColor||'FF0D1117' } };
        cell.font = { bold:true, color:{ argb:'FFE2E8F0' }, size:10 };
        cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
        cell.border = allBorders;
      });
      row.height = 22;
    }

    function styleData(row, evenRow) {
      row.eachCell(function(cell) {
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: evenRow ? 'FF181C22' : 'FF111418' } };
        cell.font = { color:{ argb:'FFE2E8F0' }, size:10 };
        cell.alignment = { vertical:'middle', wrapText:false };
        cell.border = allBorders;
      });
      row.height = 18;
    }

    // Fetch employees
    let empQuery = 'SELECT * FROM employees WHERE active=true';
    const empParams = [];
    if (employee_id) { empParams.push(employee_id); empQuery += ' AND id=$1'; }
    const emps = await pool.query(empQuery, empParams);

    const fromDate = from || new Date(Date.now() - 30*24*3600*1000).toISOString().split('T')[0];
    const toDate   = to   || new Date().toISOString().split('T')[0];

    // ── SHEET 1: Summary ──────────────────────────────────────────────────────
    if (inclSummary) {
      const ws = wb.addWorksheet('Summary', { properties:{ tabColor:{ argb:'FF00E5FF' } } });
      ws.columns = [
        { header:'Employee',     key:'name',       width:22 },
        { header:'Department',   key:'dept',       width:16 },
        { header:'Screenshots',  key:'ss',         width:14 },
        { header:'Web Activity (min)', key:'web',  width:20 },
        { header:'App Usage (min)',    key:'apps',  width:18 },
        { header:'Top App',      key:'topapp',     width:20 },
        { header:'Top Website',  key:'topsite',    width:24 },
        { header:'Productive %', key:'prod',       width:16 },
      ];
      styleHeader(ws.getRow(1), 'FF0D1117');

      for (const emp of emps.rows) {
        const ss    = await pool.query('SELECT COUNT(*) FROM screenshots WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3', [emp.id, fromDate, toDate]);
        const web   = await pool.query('SELECT COUNT(DISTINCT date_trunc(\'minute\',recorded_at)) as mins, url FROM web_activity WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3 GROUP BY url ORDER BY mins DESC LIMIT 1', [emp.id, fromDate, toDate]);
        const webTotal = await pool.query('SELECT COUNT(DISTINCT date_trunc(\'minute\',recorded_at)) as mins FROM web_activity WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3', [emp.id, fromDate, toDate]);
        const apps  = await pool.query('SELECT app_name, COUNT(DISTINCT date_trunc(\'minute\',recorded_at)) as mins FROM app_usage WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3 GROUP BY app_name ORDER BY mins DESC LIMIT 1', [emp.id, fromDate, toDate]);
        const appsTotal = await pool.query('SELECT COUNT(DISTINCT date_trunc(\'minute\',recorded_at)) as mins FROM app_usage WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3', [emp.id, fromDate, toDate]);

        // Productivity % (simple domain check server-side)
        const webRows = await pool.query('SELECT url, COUNT(DISTINCT date_trunc(\'minute\',recorded_at)) as mins FROM web_activity WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3 GROUP BY url', [emp.id, fromDate, toDate]);
        const PRODUCTIVE = ['github','gitlab','jira','confluence','notion','slack','teams','zoom','docs.google','sheets','gmail','outlook','office','sharepoint','figma','linear','asana','trello','monday','clickup','stackoverflow','aws','azure'];
        const NONPROD    = ['youtube','facebook','instagram','twitter','tiktok','netflix','reddit','whatsapp','telegram','snapchat','pinterest'];
        let prodMins=0, totalWebMins=0;
        webRows.rows.forEach(function(r){ const m=parseInt(r.mins)||0; totalWebMins+=m; if(PRODUCTIVE.some(function(k){return r.url.includes(k);})) prodMins+=m; });
        const prodPct = totalWebMins>0 ? Math.round(prodMins/totalWebMins*100)+'%' : '—';

        const rowData = ws.addRow({
          name:    emp.name,
          dept:    emp.department||'—',
          ss:      parseInt(ss.rows[0].count)||0,
          web:     parseInt(webTotal.rows[0].mins)||0,
          apps:    parseInt(appsTotal.rows[0].mins)||0,
          topapp:  apps.rows[0]?.app_name||'—',
          topsite: web.rows[0]?.url||'—',
          prod:    prodPct,
        });
        styleData(rowData, ws.rowCount % 2 === 0);
      }
      ws.getColumn('prod').alignment = { horizontal:'center' };
    }

    // ── SHEET 2: Web Activity ─────────────────────────────────────────────────
    if (inclWeb) {
      const ws = wb.addWorksheet('Web Activity', { properties:{ tabColor:{ argb:'FF7C3AED' } } });
      ws.columns = [
        { header:'Employee',    key:'name',   width:20 },
        { header:'Website',     key:'url',    width:30 },
        { header:'Browser',     key:'browser',width:14 },
        { header:'Minutes',     key:'mins',   width:12 },
        { header:'Category',    key:'cat',    width:16 },
        { header:'Date',        key:'date',   width:14 },
      ];
      styleHeader(ws.getRow(1), 'FF1A0A2E');

      const empFilter = employee_id ? 'AND w.employee_id=$3' : '';
      const params    = [fromDate, toDate];
      if (employee_id) params.push(employee_id);
      const rows = await pool.query(
        `SELECT e.name as emp_name, w.url, w.browser,
          w.recorded_at::date as date,
          COUNT(DISTINCT date_trunc('minute',w.recorded_at)) as mins
         FROM web_activity w JOIN employees e ON w.employee_id=e.id
         WHERE w.recorded_at::date BETWEEN $1 AND $2 ${empFilter}
           AND w.url NOT LIKE '[Incognito]%' AND w.url != 'Desktop'
         GROUP BY e.name, w.url, w.browser, w.recorded_at::date
         ORDER BY e.name, mins DESC`, params);
      rows.rows.forEach(function(r, i) {
        const row = ws.addRow({ name:r.emp_name, url:r.url, browser:r.browser||'—', mins:parseInt(r.mins)||0, cat:'—', date:r.date });
        styleData(row, i%2===0);
      });
    }

    // ── SHEET 3: App Usage ────────────────────────────────────────────────────
    if (inclApps) {
      const ws = wb.addWorksheet('App Usage', { properties:{ tabColor:{ argb:'FF10B981' } } });
      ws.columns = [
        { header:'Employee',  key:'name',   width:20 },
        { header:'App',       key:'app',    width:26 },
        { header:'Minutes',   key:'mins',   width:12 },
        { header:'Date',      key:'date',   width:14 },
      ];
      styleHeader(ws.getRow(1), 'FF0A1E18');

      const empFilter = employee_id ? 'AND a.employee_id=$3' : '';
      const params    = [fromDate, toDate];
      if (employee_id) params.push(employee_id);
      const rows = await pool.query(
        `SELECT e.name as emp_name, a.app_name,
          a.recorded_at::date as date,
          COUNT(DISTINCT date_trunc('minute',a.recorded_at)) as mins
         FROM app_usage a JOIN employees e ON a.employee_id=e.id
         WHERE a.recorded_at::date BETWEEN $1 AND $2 ${empFilter}
           AND LOWER(a.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost')
         GROUP BY e.name, a.app_name, a.recorded_at::date
         ORDER BY e.name, mins DESC`, params);
      rows.rows.forEach(function(r, i) {
        const row = ws.addRow({ name:r.emp_name, app:r.app_name, mins:parseInt(r.mins)||0, date:r.date });
        styleData(row, i%2===0);
      });
    }

    // ── SHEET 4: Daily Breakdown ──────────────────────────────────────────────
    if (inclDaily) {
      const ws = wb.addWorksheet('Daily Breakdown', { properties:{ tabColor:{ argb:'FFF59E0B' } } });
      ws.columns = [
        { header:'Date',          key:'date',  width:14 },
        { header:'Employee',      key:'name',  width:20 },
        { header:'Screenshots',   key:'ss',    width:14 },
        { header:'Web (min)',      key:'web',   width:12 },
        { header:'Apps (min)',     key:'apps',  width:12 },
        { header:'First Seen',    key:'first', width:16 },
        { header:'Last Seen',     key:'last',  width:16 },
      ];
      styleHeader(ws.getRow(1), 'FF1E1200');

      const empFilter = employee_id ? 'AND e.id=$3' : '';
      const params    = [fromDate, toDate];
      if (employee_id) params.push(employee_id);
      const rows = await pool.query(
        `SELECT e.name as emp_name,
          h.recorded_at::date as date,
          COUNT(DISTINCT h.recorded_at::date) as active_days,
          COUNT(DISTINCT s.id) as ss_count,
          COUNT(DISTINCT date_trunc('minute',w.recorded_at)) as web_mins,
          COUNT(DISTINCT date_trunc('minute',au.recorded_at)) as app_mins,
          MIN(h.recorded_at) as first_seen,
          MAX(h.recorded_at) as last_seen
         FROM heartbeats h
         JOIN employees e ON h.employee_id=e.id
         LEFT JOIN screenshots s ON s.employee_id=e.id AND s.recorded_at::date=h.recorded_at::date
         LEFT JOIN web_activity w ON w.employee_id=e.id AND w.recorded_at::date=h.recorded_at::date
         LEFT JOIN app_usage au ON au.employee_id=e.id AND au.recorded_at::date=h.recorded_at::date
         WHERE h.recorded_at::date BETWEEN $1 AND $2 ${empFilter}
         GROUP BY e.name, h.recorded_at::date
         ORDER BY h.recorded_at::date DESC, e.name`, params);
      rows.rows.forEach(function(r, i) {
        const fmt = function(d){ return d ? new Date(d).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false}) : '—'; };
        const row = ws.addRow({ date:r.date, name:r.emp_name, ss:parseInt(r.ss_count)||0, web:parseInt(r.web_mins)||0, apps:parseInt(r.app_mins)||0, first:fmt(r.first_seen), last:fmt(r.last_seen) });
        styleData(row, i%2===0);
      });
    }

    // Write and send
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const filename = `workpulse-report-${ts}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
    await auditLog(req, 'Report Exported', `${fromDate} to ${toDate}`);

  } catch(err) {
    console.error('[Report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ---- EMAIL CONFIG & MFA -----------------------------------
// ============================================================
(async function initEmailConfigTable() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS email_config (
      id SERIAL PRIMARY KEY,
      smtp_host VARCHAR(200),
      smtp_port INTEGER DEFAULT 587,
      smtp_user VARCHAR(200),
      smtp_pass VARCHAR(500),
      smtp_from_name VARCHAR(100) DEFAULT 'WorkPulse',
      smtp_tls BOOLEAN DEFAULT true,
      mfa_enabled BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS otp_tokens (
      id SERIAL PRIMARY KEY,
      email VARCHAR(200) NOT NULL,
      otp VARCHAR(10) NOT NULL,
      purpose VARCHAR(20) DEFAULT 'mfa',
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Clean expired OTPs daily
    setInterval(async function(){ await pool.query("DELETE FROM otp_tokens WHERE expires_at < NOW() OR used=true"); }, 3600000);
  } catch(e) { console.error('[EmailConfig] Init error:', e.message); }
})();

// Nodemailer helper
async function getMailer() {
  const nodemailer = require('nodemailer');
  const cfg = await pool.query('SELECT * FROM email_config LIMIT 1');
  if (!cfg.rows.length || !cfg.rows[0].smtp_host) throw new Error('Email not configured. Go to Admin → Email Configuration.');
  const c = cfg.rows[0];
  return nodemailer.createTransport({
    host: c.smtp_host,
    port: c.smtp_port || 587,
    secure: false,
    auth: { user: c.smtp_user, pass: c.smtp_pass },
    tls: { rejectUnauthorized: false },
  });
}

async function sendOTP(email, otp, purpose) {
  const transporter = await getMailer();
  const cfg = await pool.query('SELECT smtp_from_name, smtp_user FROM email_config LIMIT 1');
  const fromName = cfg.rows[0]?.smtp_from_name || 'WorkPulse';
  const fromEmail = cfg.rows[0]?.smtp_user || '';
  const subject = purpose === 'reset' ? 'WorkPulse — Password Reset OTP' : 'WorkPulse — Login Verification Code';
  const html = `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;background:#0d1117;color:#e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#00e5ff;padding:20px 28px"><h2 style="color:#0d1117;margin:0;font-size:20px">WorkPulse</h2></div>
    <div style="padding:28px">
      <p style="font-size:15px;margin-bottom:8px">${purpose==='reset'?'Password Reset Request':'Login Verification'}</p>
      <p style="color:#94a3b8;font-size:13px;margin-bottom:24px">${purpose==='reset'?'Use this OTP to reset your password:':'Use this code to complete your login:'}</p>
      <div style="background:#181c22;border:1px solid #1e242e;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#00e5ff;font-family:monospace">${otp}</span>
      </div>
      <p style="color:#64748b;font-size:11px">This code expires in <strong style="color:#e2e8f0">10 minutes</strong>. Do not share it with anyone.</p>
    </div>
  </div>`;
  await transporter.sendMail({ from:`"${fromName}" <${fromEmail}>`, to:email, subject, html });
}

function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

// Get email config
app.get('/api/admin/email-config', requireLogin, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT smtp_host, smtp_port, smtp_user, smtp_from_name, smtp_tls, mfa_enabled FROM email_config LIMIT 1');
    res.json(r.rows[0] || {});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save email config
app.post('/api/admin/email-config', requireLogin, requireAdmin, async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name, smtp_tls } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM email_config LIMIT 1');
    if (existing.rows.length) {
      const updates = ['smtp_host=$1','smtp_port=$2','smtp_user=$3','smtp_from_name=$4','smtp_tls=$5','updated_at=NOW()'];
      const params  = [smtp_host, smtp_port||587, smtp_user, smtp_from_name||'WorkPulse', smtp_tls!==false];
      if (smtp_pass) { updates.push('smtp_pass=$'+(params.length+1)); params.push(smtp_pass); }
      params.push(existing.rows[0].id);
      await pool.query(`UPDATE email_config SET ${updates.join(',')} WHERE id=$${params.length}`, params);
    } else {
      await pool.query('INSERT INTO email_config (smtp_host,smtp_port,smtp_user,smtp_pass,smtp_from_name,smtp_tls) VALUES ($1,$2,$3,$4,$5,$6)',
        [smtp_host, smtp_port||587, smtp_user, smtp_pass, smtp_from_name||'WorkPulse', smtp_tls!==false]);
    }
    await auditLog(req, 'Email Config Updated', smtp_host);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Test email config
app.post('/api/admin/email-config/test', requireLogin, requireAdmin, async (req, res) => {
  try {
    const adminRow = await pool.query('SELECT email FROM admins WHERE id=$1', [req.session.adminId]);
    const email = adminRow.rows[0]?.email;
    if (!email) return res.status(400).json({ error: 'Admin email not found' });
    const transporter = await getMailer();
    const cfg = await pool.query('SELECT smtp_from_name, smtp_user FROM email_config LIMIT 1');
    const fromName = cfg.rows[0]?.smtp_from_name || 'WorkPulse';
    await transporter.sendMail({
      from: `"${fromName}" <${cfg.rows[0]?.smtp_user}>`,
      to: email,
      subject: 'WorkPulse — SMTP Test Successful ✓',
      html: '<div style="font-family:sans-serif;padding:20px"><h2 style="color:#00e5ff">✓ SMTP is working!</h2><p>Your WorkPulse email configuration is set up correctly.</p></div>',
    });
    await auditLog(req, 'Email Config Tested', email);
    res.json({ success: true, sent_to: email });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save MFA setting
app.post('/api/admin/email-config/mfa', requireLogin, requireAdmin, async (req, res) => {
  const { mfa_enabled, totp_global_enabled } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM email_config LIMIT 1');
    if (existing.rows.length) {
      await pool.query('UPDATE email_config SET mfa_enabled=$1 WHERE id=$2', [mfa_enabled, existing.rows[0].id]);
    } else {
      await pool.query('INSERT INTO email_config (mfa_enabled) VALUES ($1)', [mfa_enabled]);
    }
    // If TOTP global disabled, disable totp for all users
    if (totp_global_enabled === false) {
      await pool.query('UPDATE admins SET totp_enabled=false, totp_secret=NULL');
      await pool.query('UPDATE dashboard_users SET totp_enabled=false, totp_secret=NULL');
    }
    await auditLog(req, mfa_enabled ? 'MFA Enabled' : 'MFA Disabled', '');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── MFA: verify OTP after password check ─────────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp, purpose } = req.body;
  try {
    const row = await pool.query(
      "SELECT * FROM otp_tokens WHERE email=$1 AND otp=$2 AND purpose=$3 AND used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
      [email, otp, purpose || 'mfa']
    );
    if (!row.rows.length) return res.status(401).json({ error: 'Invalid or expired OTP' });
    await pool.query('UPDATE otp_tokens SET used=true WHERE id=$1', [row.rows[0].id]);

    if (purpose === 'reset') {
      // Return a short-lived reset token stored in session
      req.session.resetEmail  = email;
      req.session.resetExpiry = Date.now() + 15 * 60 * 1000;
      return res.json({ success: true, can_reset: true });
    }

    // MFA — complete the login that was pending
    if (!req.session.pendingLogin) return res.status(401).json({ error: 'No pending login' });
    const p = req.session.pendingLogin;
    req.session.adminId   = p.adminId;
    req.session.adminName = p.adminName;
    req.session.adminRole = p.adminRole;
    req.session.isUser    = p.isUser;
    if (p.allowedEmployees) req.session.allowedEmployees = p.allowedEmployees;
    delete req.session.pendingLogin;
    res.json({ success: true, name: p.adminName, role: p.adminRole });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Send OTP for login (MFA) ──────────────────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!req.session.pendingLogin && req.body.purpose !== 'reset')
    return res.status(401).json({ error: 'No pending login' });
  try {
    const otp = generateOTP();
    await pool.query('INSERT INTO otp_tokens (email,otp,purpose,expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL\'10 minutes\')',
      [email, otp, req.body.purpose || 'mfa']);
    await sendOTP(email, otp, req.body.purpose || 'mfa');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Forgot password — request OTP ────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    // Check admins and dashboard_users
    const adminRow = await pool.query('SELECT email FROM admins WHERE email=$1', [email]);
    const userRow  = await pool.query('SELECT email FROM dashboard_users WHERE email=$1 AND active=true', [email]);
    if (!adminRow.rows.length && !userRow.rows.length) {
      // Don't reveal if email exists — always return success
      return res.json({ success: true });
    }
    const otp = generateOTP();
    await pool.query('INSERT INTO otp_tokens (email,otp,purpose,expires_at) VALUES ($1,$2,\'reset\',NOW()+INTERVAL\'10 minutes\')', [email, otp]);
    await sendOTP(email, otp, 'reset');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Reset password after OTP verified ────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, password } = req.body;
  if (!req.session.resetEmail || req.session.resetEmail !== email || Date.now() > req.session.resetExpiry)
    return res.status(401).json({ error: 'Reset session expired. Please start over.' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const adminUpd = await pool.query('UPDATE admins SET password_hash=$1 WHERE email=$2 RETURNING id', [hash, email]);
    if (!adminUpd.rows.length) {
      await pool.query('UPDATE dashboard_users SET password_hash=$1 WHERE email=$2', [hash, email]);
    }
    delete req.session.resetEmail;
    delete req.session.resetExpiry;
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Patch login routes to support MFA ────────────────────────────────────────
// Replace /api/user-login to check MFA setting
app.post('/api/login-check-mfa', async (req, res) => {
  // This is called by frontend to know if MFA is on
  try {
    const cfg = await pool.query('SELECT mfa_enabled FROM email_config LIMIT 1');
    res.json({ mfa_enabled: cfg.rows[0]?.mfa_enabled === true });
  } catch(err) { res.json({ mfa_enabled: false }); }
});


// ============================================================
// ---- TOTP AUTHENTICATOR MFA --------------------------------
// ============================================================
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');

(async function initTOTP() {
  try {
    await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(200)");
    await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(200)");
    await pool.query("ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false");
  } catch(e) { console.error('[TOTP] Init:', e.message); }
})();

async function getTotpUser(session) {
  if (!session.isUser) {
    const r = await pool.query('SELECT totp_secret, totp_enabled FROM admins WHERE id=$1', [session.adminId]);
    return r.rows[0];
  } else {
    const r = await pool.query('SELECT totp_secret, totp_enabled FROM dashboard_users WHERE id=$1', [session.adminId]);
    return r.rows[0];
  }
}

// Get TOTP status
app.get('/api/auth/totp/status', requireLogin, async (req, res) => {
  try {
    const u = await getTotpUser(req.session);
    res.json({ totp_enabled: u?.totp_enabled === true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Start TOTP setup — generate secret + QR
app.post('/api/auth/totp/setup', requireLogin, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      length: 20,
      name: encodeURIComponent('WorkPulse (' + req.session.adminName + ')'),
      issuer: 'WorkPulse'
    });
    req.session.totpTempSecret = secret.base32;
    const qr = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ success: true, secret: secret.base32, qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verify setup code and activate
app.post('/api/auth/totp/activate', requireLogin, async (req, res) => {
  const { token } = req.body;
  const secret = req.session.totpTempSecret;
  if (!secret) return res.status(400).json({ error: 'No setup in progress. Click Setup again.' });
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: String(token), window: 2 });
  if (!valid) return res.status(401).json({ error: 'Invalid code. Try again.' });
  try {
    if (!req.session.isUser) {
      await pool.query('UPDATE admins SET totp_secret=$1, totp_enabled=true WHERE id=$2', [secret, req.session.adminId]);
    } else {
      await pool.query('UPDATE dashboard_users SET totp_secret=$1, totp_enabled=true WHERE id=$2', [secret, req.session.adminId]);
    }
    delete req.session.totpTempSecret;
    await auditLog(req, 'TOTP Activated', req.session.adminName);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Disable TOTP
app.post('/api/auth/totp/disable', requireLogin, async (req, res) => {
  try {
    if (!req.session.isUser) {
      await pool.query('UPDATE admins SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [req.session.adminId]);
    } else {
      await pool.query('UPDATE dashboard_users SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [req.session.adminId]);
    }
    await auditLog(req, 'TOTP Disabled', req.session.adminName);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verify TOTP during login
app.post('/api/auth/totp/verify-login', async (req, res) => {
  const { token } = req.body;
  if (!req.session.pendingLogin) return res.status(401).json({ error: 'No pending login' });
  const p = req.session.pendingLogin;
  try {
    let row;
    if (!p.isUser) {
      const r = await pool.query('SELECT totp_secret FROM admins WHERE id=$1', [p.adminId]);
      row = r.rows[0];
    } else {
      const r = await pool.query('SELECT totp_secret FROM dashboard_users WHERE id=$1', [p.adminId]);
      row = r.rows[0];
    }
    if (!row?.totp_secret) return res.status(400).json({ error: 'Authenticator not set up for this account' });
    const valid = speakeasy.totp.verify({ secret: row.totp_secret, encoding: 'base32', token: String(token), window: 2 });
    if (!valid) return res.status(401).json({ error: 'Invalid code. Check your authenticator app.' });
    // Complete login
    req.session.adminId   = p.adminId;
    req.session.adminName = p.adminName;
    req.session.adminRole = p.adminRole;
    req.session.isUser    = p.isUser;
    if (p.allowedEmployees) req.session.allowedEmployees = p.allowedEmployees;
    delete req.session.pendingLogin;
    res.json({ success: true, name: p.adminName, role: p.adminRole });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ---- END TOTP ----


// System settings
app.get('/api/admin/sys-settings', requireLogin, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='sys_settings' LIMIT 1");
    if (r.rows.length) res.json(JSON.parse(r.rows[0].value));
    else res.json({ timezone: 'Asia/Kolkata', company_name: 'WorkPulse', date_format: 'DD/MM/YYYY', default_theme: 'system' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/sys-settings', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY, value TEXT)");
    const val = JSON.stringify(req.body);
    await pool.query("INSERT INTO settings(key,value) VALUES('sys_settings',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [val]);
    await auditLog(req, 'System Settings Updated', '');
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// ---- REPORT JOB QUEUE ----------------------------------
// ============================================================

// Create reports directory
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

// Submit a report job
app.post('/api/admin/report-job', requireLogin, requireAdmin, async (req, res) => {
  const { employee_id, from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Date range required' });
  try {
    // Get employee name
    let empName = 'All Employees';
    if (employee_id) {
      const er = await pool.query('SELECT name FROM employees WHERE id=$1', [employee_id]);
      if (er.rows.length) empName = er.rows[0].name;
    }
    const job = await pool.query(
      "INSERT INTO report_jobs (admin_id, admin_name, employee_id, employee_name, from_date, to_date, status, progress) VALUES ($1,$2,$3,$4,$5,$6,'queued',0) RETURNING id",
      [req.session.adminId, req.session.adminName, employee_id||null, empName, from, to]
    );
    res.json({ success: true, job_id: job.rows[0].id });
    // Trigger worker
    processNextJob();
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get all jobs for current admin
app.get('/api/admin/report-jobs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const jobs = await pool.query(
      'SELECT id, admin_name, employee_name, from_date, to_date, status, progress, filename, error_msg, created_at, completed_at FROM report_jobs WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.session.adminId]
    );
    res.json(jobs.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Download a completed report
app.get('/api/admin/report-download/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });
    const j = job.rows[0];
    if (j.status !== 'done') return res.status(400).json({ error: 'Report not ready' });
    if (!fs.existsSync(j.file_path)) return res.status(404).json({ error: 'File not found' });
    res.download(j.file_path, j.filename);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete a job
app.delete('/api/admin/report-job/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    if (job.rows.length && job.rows[0].file_path && fs.existsSync(job.rows[0].file_path)) {
      fs.unlinkSync(job.rows[0].file_path);
    }
    await pool.query('DELETE FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Background worker
var jobWorkerRunning = false;
async function processNextJob() {
  if (jobWorkerRunning) return;
  jobWorkerRunning = true;
  try {
    while (true) {
      const next = await pool.query("SELECT * FROM report_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1");
      if (!next.rows.length) break;
      const job = next.rows[0];
      await pool.query("UPDATE report_jobs SET status='generating', progress=5 WHERE id=$1", [job.id]);
      try {
        await generateReportJob(job);
      } catch(e) {
        console.error('[Report Job] Error:', e.message);
        await pool.query("UPDATE report_jobs SET status='failed', error_msg=$1 WHERE id=$2", [e.message, job.id]);
      }
    }
  } finally {
    jobWorkerRunning = false;
  }
}

async function generateReportJob(job) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkPulse';
  wb.created = new Date();
  const fromDate = job.from_date.toISOString().split('T')[0];
  const toDate   = job.to_date.toISOString().split('T')[0];

  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0D1117' } };
  const borderThin = { style:'thin', color:{ argb:'FF1E242E' } };
  const allBorders = { top:borderThin, left:borderThin, bottom:borderThin, right:borderThin };
  function styleHeader(row) {
    row.eachCell(function(cell) {
      cell.fill = headerFill;
      cell.font = { bold:true, color:{ argb:'FFE2E8F0' }, size:10 };
      cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
      cell.border = allBorders;
    });
    row.height = 22;
  }
  function styleData(row, even) {
    row.eachCell(function(cell) {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: even ? 'FF181C22' : 'FF111418' } };
      cell.font = { color:{ argb:'FFE2E8F0' }, size:10 };
      cell.alignment = { vertical:'middle' };
      cell.border = allBorders;
    });
    row.height = 18;
  }

  // Employees
  let empQuery = 'SELECT * FROM employees WHERE active=true';
  const empParams = [];
  if (job.employee_id) { empParams.push(job.employee_id); empQuery += ' AND id=$1'; }
  const emps = await pool.query(empQuery, empParams);

  await pool.query("UPDATE report_jobs SET progress=20 WHERE id=$1", [job.id]);

  // Sheet 1: Summary
  const ws1 = wb.addWorksheet('Summary');
  ws1.columns = [
    { header:'Employee', key:'name', width:22 },
    { header:'Department', key:'dept', width:16 },
    { header:'Screenshots', key:'ss', width:14 },
    { header:'Web (min)', key:'web', width:14 },
    { header:'Apps (min)', key:'apps', width:14 },
    { header:'Top App', key:'topapp', width:20 },
    { header:'Top Website', key:'topsite', width:24 },
  ];
  styleHeader(ws1.getRow(1));
  for (const emp of emps.rows) {
    const ss = await pool.query('SELECT COUNT(*) FROM screenshots WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3', [emp.id, fromDate, toDate]);
    const web = await pool.query(`SELECT COUNT(DISTINCT date_trunc('minute',recorded_at)) as mins, url FROM web_activity WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3 GROUP BY url ORDER BY mins DESC LIMIT 1`, [emp.id, fromDate, toDate]);
    const webTotal = await pool.query(`SELECT COUNT(DISTINCT date_trunc('minute',recorded_at)) as mins FROM web_activity WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3`, [emp.id, fromDate, toDate]);
    const apps = await pool.query(`SELECT app_name, COUNT(DISTINCT date_trunc('minute',recorded_at)) as mins FROM app_usage WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3 GROUP BY app_name ORDER BY mins DESC LIMIT 1`, [emp.id, fromDate, toDate]);
    const appsTotal = await pool.query(`SELECT COUNT(DISTINCT date_trunc('minute',recorded_at)) as mins FROM app_usage WHERE employee_id=$1 AND recorded_at::date BETWEEN $2 AND $3`, [emp.id, fromDate, toDate]);
    const row = ws1.addRow({ name:emp.name, dept:emp.department||'—', ss:parseInt(ss.rows[0].count)||0, web:parseInt(webTotal.rows[0].mins)||0, apps:parseInt(appsTotal.rows[0].mins)||0, topapp:apps.rows[0]?.app_name||'—', topsite:web.rows[0]?.url||'—' });
    styleData(row, ws1.rowCount%2===0);
  }

  await pool.query("UPDATE report_jobs SET progress=50 WHERE id=$1", [job.id]);

  // Sheet 2: Web Activity
  const ws2 = wb.addWorksheet('Web Activity');
  ws2.columns = [{ header:'Employee', key:'name', width:20 },{ header:'Website', key:'url', width:30 },{ header:'Browser', key:'browser', width:14 },{ header:'Minutes', key:'mins', width:12 },{ header:'Date', key:'date', width:14 }];
  styleHeader(ws2.getRow(1));
  const empFilter2 = job.employee_id ? 'AND w.employee_id=$3' : '';
  const params2 = [fromDate, toDate]; if (job.employee_id) params2.push(job.employee_id);
  const webRows = await pool.query(`SELECT e.name as emp_name, w.url, w.browser, w.recorded_at::date as date, COUNT(DISTINCT date_trunc('minute',w.recorded_at)) as mins FROM web_activity w JOIN employees e ON w.employee_id=e.id WHERE w.recorded_at::date BETWEEN $1 AND $2 ${empFilter2} AND w.url NOT LIKE '[Incognito]%' AND w.url != 'Desktop' GROUP BY e.name, w.url, w.browser, w.recorded_at::date ORDER BY e.name, mins DESC`, params2);
  webRows.rows.forEach(function(r,i){ const row=ws2.addRow({name:r.emp_name,url:r.url,browser:r.browser||'—',mins:parseInt(r.mins)||0,date:r.date}); styleData(row,i%2===0); });

  await pool.query("UPDATE report_jobs SET progress=75 WHERE id=$1", [job.id]);

  // Sheet 3: App Usage
  const ws3 = wb.addWorksheet('App Usage');
  ws3.columns = [{ header:'Employee', key:'name', width:20 },{ header:'App', key:'app', width:26 },{ header:'Minutes', key:'mins', width:12 },{ header:'Date', key:'date', width:14 }];
  styleHeader(ws3.getRow(1));
  const empFilter3 = job.employee_id ? 'AND a.employee_id=$3' : '';
  const params3 = [fromDate, toDate]; if (job.employee_id) params3.push(job.employee_id);
  const appRows = await pool.query(`SELECT e.name as emp_name, a.app_name, a.recorded_at::date as date, COUNT(DISTINCT date_trunc('minute',a.recorded_at)) as mins FROM app_usage a JOIN employees e ON a.employee_id=e.id WHERE a.recorded_at::date BETWEEN $1 AND $2 ${empFilter3} AND LOWER(a.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost') GROUP BY e.name, a.app_name, a.recorded_at::date ORDER BY e.name, mins DESC`, params3);
  appRows.rows.forEach(function(r,i){ const row=ws3.addRow({name:r.emp_name,app:r.app_name,mins:parseInt(r.mins)||0,date:r.date}); styleData(row,i%2===0); });

  await pool.query("UPDATE report_jobs SET progress=90 WHERE id=$1", [job.id]);

  // Save file
  const filename = `workpulse-report-${fromDate}-to-${toDate}-${Date.now()}.xlsx`;
  const filePath = path.join(reportsDir, filename);
  await wb.xlsx.writeFile(filePath);
  await pool.query("UPDATE report_jobs SET status='done', progress=100, filename=$1, file_path=$2, completed_at=NOW() WHERE id=$3", [filename, filePath, job.id]);
  console.log('[Report Job] Done:', filename);

  // Send email notification to admin
  try {
    const adminRow = await pool.query('SELECT email FROM admins WHERE id=$1', [job.admin_id]);
    const adminEmail = adminRow.rows[0]?.email;
    if (adminEmail) {
      const mailer = await getMailer();
      const fromDate2 = job.from_date.toISOString().split('T')[0];
      const toDate2   = job.to_date.toISOString().split('T')[0];
      await mailer.sendMail({
        from: `"WorkPulse" <${(await pool.query('SELECT smtp_user FROM email_config LIMIT 1')).rows[0]?.smtp_user}>`,
        to: adminEmail,
        subject: `WorkPulse Report Ready — ${job.employee_name} (${fromDate2} to ${toDate2})`,
        html: `<div style="font-family:sans-serif;padding:24px;max-width:500px">
          <h2 style="color:#00e5ff;margin-bottom:8px">📊 Your Report is Ready</h2>
          <p style="color:#555;margin-bottom:16px">Your WorkPulse report has been generated and is ready to download.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr><td style="padding:8px;color:#888;font-size:12px">Employee</td><td style="padding:8px;font-weight:600">${job.employee_name}</td></tr>
            <tr style="background:#f9f9f9"><td style="padding:8px;color:#888;font-size:12px">Date Range</td><td style="padding:8px;font-weight:600">${fromDate2} → ${toDate2}</td></tr>
            <tr><td style="padding:8px;color:#888;font-size:12px">File</td><td style="padding:8px;font-family:monospace;font-size:11px">${filename}</td></tr>
          </table>
          <p style="color:#888;font-size:12px">Log in to WorkPulse → Reports → Report Queue to download your file.</p>
        </div>`
      });
      console.log('[Report Job] Email sent to:', adminEmail);
    }
  } catch(emailErr) {
    console.error('[Report Job] Email notification failed:', emailErr.message);
  }
}

// Start worker on boot for any queued jobs
setTimeout(processNextJob, 5000);
// ---- END REPORT JOB QUEUE ----


// ============================================================
// ---- REPORT JOB QUEUE ----------------------------------
// ============================================================

// Create reports directory

// Submit a report job
app.post('/api/admin/report-job', requireLogin, requireAdmin, async (req, res) => {
  const { employee_id, from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Date range required' });
  try {
    // Get employee name
    let empName = 'All Employees';
    if (employee_id) {
      const er = await pool.query('SELECT name FROM employees WHERE id=$1', [employee_id]);
      if (er.rows.length) empName = er.rows[0].name;
    }
    const job = await pool.query(
      "INSERT INTO report_jobs (admin_id, admin_name, employee_id, employee_name, from_date, to_date, status, progress) VALUES ($1,$2,$3,$4,$5,$6,'queued',0) RETURNING id",
      [req.session.adminId, req.session.adminName, employee_id||null, empName, from, to]
    );
    res.json({ success: true, job_id: job.rows[0].id });
    // Trigger worker
    processNextJob();
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get all jobs for current admin
app.get('/api/admin/report-jobs', requireLogin, requireAdmin, async (req, res) => {
  try {
    const jobs = await pool.query(
      'SELECT id, admin_name, employee_name, from_date, to_date, status, progress, filename, error_msg, created_at, completed_at FROM report_jobs WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.session.adminId]
    );
    res.json(jobs.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Download a completed report
app.get('/api/admin/report-download/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });
    const j = job.rows[0];
    if (j.status !== 'done') return res.status(400).json({ error: 'Report not ready' });
    if (!fs.existsSync(j.file_path)) return res.status(404).json({ error: 'File not found' });
    res.download(j.file_path, j.filename);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete a job
app.delete('/api/admin/report-job/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    if (job.rows.length && job.rows[0].file_path && fs.existsSync(job.rows[0].file_path)) {
      fs.unlinkSync(job.rows[0].file_path);
    }
    await pool.query('DELETE FROM report_jobs WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Background worker
var jobWorkerRunning = false;
async function processNextJob() {
  if (jobWorkerRunning) return;
  jobWorkerRunning = true;
  try {
    while (true) {
      const next = await pool.query("SELECT * FROM report_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1");
      if (!next.rows.length) break;
      const job = next.rows[0];
      await pool.query("UPDATE report_jobs SET status='generating', progress=5 WHERE id=$1", [job.id]);
      try {
        await generateReportJob(job);
      } catch(e) {
        console.error('[Report Job] Error:', e.message);
        await pool.query("UPDATE report_jobs SET status='failed', error_msg=$1 WHERE id=$2", [e.message, job.id]);
      }
    }
  } finally {
    jobWorkerRunning = false;
  }
}


// ---- END SCHEDULED REPORTS ----


// ---- REPORT SCHEDULE ROUTES ----
app.get('/api/admin/report-schedules', requireLogin, requireAdmin, async (req, res) => {
  try {
    const rows = await pool.query('SELECT * FROM report_schedules WHERE admin_id=$1 ORDER BY created_at DESC', [req.session.adminId]);
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/report-schedules', requireLogin, requireAdmin, async (req, res) => {
  const { employee_id, frequency, day_of_week, day_of_month, email, send_hour } = req.body;
  try {
    let empName = 'All Employees';
    if (employee_id) {
      const er = await pool.query('SELECT name FROM employees WHERE id=$1', [employee_id]);
      if (er.rows.length) empName = er.rows[0].name;
    }
    const nextRun = calcNextRun(frequency, day_of_week, day_of_month, send_hour||8);
    await pool.query(
      'INSERT INTO report_schedules (admin_id, admin_name, employee_id, employee_name, frequency, day_of_week, day_of_month, email, next_run) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [req.session.adminId, req.session.adminName, employee_id||null, empName, frequency, day_of_week||null, day_of_month||null, email||null, nextRun]
    );
    await auditLog(req, 'Report Schedule Created', empName + ' - ' + frequency);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/report-schedules/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE report_schedules SET active=$1 WHERE id=$2 AND admin_id=$3', [req.body.active, req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/report-schedules/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM report_schedules WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// ---- END REPORT SCHEDULE ROUTES ----


// System Activity Timeline
app.get('/api/dashboard/system-timeline', requireLogin, async (req, res) => {
  const { employee_id, date } = req.query;
  const allowed = getAllowedEmployees(req);
  try {
    let empQ = `SELECT e.id, e.name, r.start_time as shift_start, r.end_time as shift_end, r.name as roster_name
      FROM employees e LEFT JOIN duty_rosters r ON e.roster_id=r.id WHERE e.active=true`;
    const empP = [];
    if (employee_id) { empP.push(employee_id); empQ += ` AND e.id=$${empP.length}`; }
    if (allowed) { empP.push(allowed); empQ += ` AND e.id=ANY($${empP.length}::int[])`; }
    const emps = await pool.query(empQ, empP);

    const results = [];
    for (const emp of emps.rows) {
      let evQ = `SELECT event_type, recorded_at FROM system_events WHERE employee_id=$1`;
      const evP = [emp.id];
      // Calculate window with 2hr grace period based on roster
      if (date) {
        const d = new Date(date);
        let fromDt, toDt;
        if (emp.shift_start && emp.shift_end) {
          const [sh, sm] = emp.shift_start.split(':').map(Number);
          const [eh, em] = emp.shift_end.split(':').map(Number);
          const isOvernight = eh < sh || (eh === 0 && sh > 0);
          // From: shift_start - 2hrs
          fromDt = new Date(d);
          fromDt.setHours(sh - 2, sm, 0, 0);
          if (fromDt.getHours() < 0) { fromDt.setDate(fromDt.getDate()-1); fromDt.setHours(fromDt.getHours()+24); }
          // To: shift_end + 2hrs (next day if overnight)
          toDt = new Date(d);
          if (isOvernight) toDt.setDate(toDt.getDate()+1);
          toDt.setHours(eh + 2, em, 0, 0);
        } else {
          // No roster - full day
          fromDt = new Date(d); fromDt.setHours(0,0,0,0);
          toDt   = new Date(d); toDt.setHours(23,59,59,999);
        }
        evP.push(fromDt.toISOString()); evQ += ` AND recorded_at>=$${evP.length}`;
        evP.push(toDt.toISOString());   evQ += ` AND recorded_at<=$${evP.length}`;
      } else {
        evQ += ` AND recorded_at::date=CURRENT_DATE`;
      }
      evQ += ' ORDER BY recorded_at ASC';
      const evs = await pool.query(evQ, evP);
      if (!evs.rows.length) continue;

      const raw = evs.rows.map(r => ({ type: r.event_type, time: new Date(r.recorded_at) }));

      // Step 1: Collapse rapid sleep/wakeup cycles (screen timeout) < 5 min into nothing
      // Only keep sleep if it lasts more than 5 minutes before next wakeup
      const filtered = [];
      for (let i = 0; i < raw.length; i++) {
        const ev = raw[i];
        if (ev.type === 'sleep' || ev.type === 'idle_lock') {
          // Find next wakeup/startup
          let nextWake = null;
          for (let j = i+1; j < raw.length; j++) {
            if (raw[j].type === 'wakeup' || raw[j].type === 'startup') { nextWake = raw[j]; break; }
            if (raw[j].type === 'shutdown') break;
          }
          // Only keep sleep if gap > 5 minutes
          if (!nextWake || (nextWake.time - ev.time) > 5*60*1000) {
            filtered.push(ev);
          }
          // else skip this sleep (screen timeout)
        } else {
          filtered.push(ev);
        }
      }

      // Step 2: Deduplicate consecutive same-type within 2 min
      const deduped = [];
      for (const ev of filtered) {
        const last = deduped[deduped.length-1];
        if (last && last.type === ev.type && (ev.time - last.time) < 120000) continue;
        deduped.push(ev);
      }

      // Step 3: Merge consecutive wakeups/sleeps + remove wakeup immediately after startup
      const clean = [];
      for (const ev of deduped) {
        const last = clean[clean.length-1];
        // Skip duplicate same type
        if (last && last.type === ev.type && (ev.type === 'wakeup' || ev.type === 'sleep' || ev.type === 'idle_lock' || ev.type === 'startup')) continue;
        // Skip wakeup within 60s of startup
        if (ev.type === 'wakeup' && last && last.type === 'startup' && (ev.time - last.time) < 60000) continue;
        // Skip startup within 60s of another startup
        if (ev.type === 'startup' && last && last.type === 'startup' && (ev.time - last.time) < 60000) continue;
        clean.push(ev);
      }

      // Step 4: Calculate active time — only wakeup/startup to sleep/shutdown gaps > 5min
      let totalActiveMs = 0;
      let activeStart = null;
      for (const ev of clean) {
        if (ev.type === 'startup' || ev.type === 'wakeup') {
          activeStart = ev.time;
        } else if ((ev.type === 'sleep' || ev.type === 'idle_lock' || ev.type === 'shutdown') && activeStart) {
          const gap = ev.time - activeStart;
          if (gap > 60000) totalActiveMs += gap; // only count gaps > 1 min
          activeStart = null;
        }
      }
      if (activeStart) totalActiveMs += new Date() - activeStart;

      // Calculate productive time within roster hours only
      let productiveMs = 0;
      if (emp.shift_start && emp.shift_end && date) {
        const [sh, sm] = emp.shift_start.split(':').map(Number);
        const [eh, em] = emp.shift_end.split(':').map(Number);
        const baseDate = new Date(date);
        let shiftFrom = new Date(baseDate); shiftFrom.setHours(sh, sm, 0, 0);
        let shiftTo   = new Date(baseDate);
        const isOvernight = eh < sh;
        if (isOvernight) shiftTo.setDate(shiftTo.getDate()+1);
        shiftTo.setHours(eh, em, 0, 0);

        let pStart = null;
        for (const ev of clean) {
          if (ev.type === 'startup' || ev.type === 'wakeup') {
            pStart = ev.time < shiftFrom ? shiftFrom : ev.time;
          } else if ((ev.type === 'sleep' || ev.type === 'idle_lock' || ev.type === 'shutdown') && pStart) {
            const pEnd = ev.time > shiftTo ? shiftTo : ev.time;
            if (pEnd > pStart) productiveMs += pEnd - pStart;
            pStart = null;
          }
        }
        if (pStart) {
          const pEnd = new Date() > shiftTo ? shiftTo : new Date();
          if (pEnd > pStart) productiveMs += pEnd - pStart;
        }
      } else {
        productiveMs = totalActiveMs;
      }

      results.push({
        employee_id: emp.id,
        employee_name: emp.name,
        roster_name: emp.roster_name,
        shift_start: emp.shift_start,
        shift_end: emp.shift_end,
        events: clean.map(e => ({ type: e.type, time: e.time.toISOString() })),
        total_active_ms: totalActiveMs,
        productive_ms: productiveMs
      });
    }
    res.json(results);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`WorkPulse server running on port ${PORT}`);
});
