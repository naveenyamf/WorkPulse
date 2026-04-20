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

// ─── HELPER: Get effective roster for employee on a given date ───
async function getEffectiveRoster(employeeId, date) {
  try {
    if (date) {
      const ov = await pool.query(
        `SELECT r.id, r.name, r.start_time, r.end_time FROM temp_shift_overrides t
         JOIN duty_rosters r ON t.roster_id = r.id
         WHERE t.employee_id=$1 AND t.override_date=$2::date`,
        [employeeId, date]
      );
      if (ov.rows.length) return ov.rows[0];
    }
    const def = await pool.query(
      `SELECT r.id, r.name, r.start_time, r.end_time FROM employees e
       JOIN duty_rosters r ON e.roster_id = r.id
       WHERE e.id=$1`, [employeeId]
    );
    return def.rows[0] || null;
  } catch(e) { return null; }
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
    let query = `SELECT e.*, (SELECT active_app FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as current_app, (SELECT idle FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as is_idle, (SELECT recorded_at FROM heartbeats WHERE employee_id=e.id ORDER BY recorded_at DESC LIMIT 1) as last_seen, (SELECT agent_version FROM heartbeats WHERE employee_id=e.id AND agent_version IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) as agent_version FROM employees e WHERE e.active=true`;
    const params = [];
    if (allowed) { params.push(allowed); query += ` AND e.id = ANY($1::int[])`; }
    query += " ORDER BY e.name";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees', requireLogin, async (req, res) => {
  const { name, email, department, roster_id } = req.body;
  const token = require('crypto').randomBytes(32).toString('hex');
  try {
    // Check if employee exists but was deleted
    const existing = await pool.query(
      'SELECT id FROM employees WHERE email=$1', [email]
    );
    if (existing.rows.length) {
      // Reactivate with new token
      const result = await pool.query(
        'UPDATE employees SET name=$1, department=$2, agent_token=$3, active=true, roster_id=$5 WHERE email=$4 RETURNING *',
        [name, department, token, email, roster_id||null]
      );
      return res.json(result.rows[0]);
    }
    // New employee
	const result = await pool.query(
      'INSERT INTO employees (name, email, department, agent_token, roster_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, email, department, token, roster_id||null]
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
  const { active_app, idle, urls, apps, version } = req.body;
  const empId = req.employee.id;
  try {
    // Save heartbeat
    await pool.query(
      'INSERT INTO heartbeats (employee_id, active_app, idle, agent_version) VALUES ($1,$2,$3,$4)',
      [empId, active_app || 'Unknown', idle || false, version || null]
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
  const perPage = req.query.date ? 50 : 2; // show all emps when date selected
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
    // Apply temp shift overrides if date selected
    if (date) {
      for (let i = 0; i < allEmps.length; i++) {
        const ov = await getEffectiveRoster(allEmps[i].id, date);
        if (ov) allEmps[i] = Object.assign({}, allEmps[i], {shift_start:ov.start_time, shift_end:ov.end_time, roster_name:ov.name});
      }
    }
    // When date selected, show all employees on one page
    // Otherwise pack employees into pages of max 50 sites
    let pages_arr;
    if (date) {
      pages_arr = [allEmps];
    } else {
      const siteLimit = 50;
      pages_arr = [[]];
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
    const perPage = date ? 50 : 2;

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
    // Apply temp shift overrides if date selected
    if (date) {
      for (let i = 0; i < allEmps.length; i++) {
        const ov = await getEffectiveRoster(allEmps[i].id, date);
        if (ov) allEmps[i] = Object.assign({}, allEmps[i], {shift_start:ov.start_time, shift_end:ov.end_time, roster_name:ov.name});
      }
    }
    const total = allEmps.length;
    const pages = Math.ceil(total / perPage) || 1;
    const emps = allEmps.slice((page-1)*perPage, page*perPage);
    if (!emps.length) return res.json({ rows: [], total, page, pages });

    const empIds = emps.map(e => e.id);

    // Build per-employee shift time ranges for SQL filtering
    const shiftParams = []; // [{id, start, end, overnight}]
    emps.forEach(emp => {
      if (emp.shift_start && emp.shift_end) {
        const s = emp.shift_start.slice(0,5);
        const e = emp.shift_end.slice(0,5);
        shiftParams.push({ id: emp.id, start: s, end: e, overnight: e <= s });
      }
    });
    console.log('[AppUsage] shiftParams:', JSON.stringify(shiftParams));
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
        COUNT(DISTINCT DATE_TRUNC('minute', a.recorded_at)) * 60 as total_seconds

      FROM app_usage a JOIN employees e ON a.employee_id=e.id
      LEFT JOIN duty_rosters r ON e.roster_id=r.id
      WHERE e.active=true
        AND LOWER(a.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost','textinputhost')
        AND a.app_name NOT SIMILAR TO '[0-9]%'
        AND a.employee_id = ANY($1::int[])
        ${date ? dateFilter : ''}
        AND (
          ${shiftParams.length === 0 ? 'true' :
            shiftParams.map(sp => sp.overnight ?
              `(a.employee_id=${sp.id} AND (a.recorded_at::time >= '${sp.start}' OR a.recorded_at::time < '${sp.end}'))` :
              `(a.employee_id=${sp.id} AND a.recorded_at::time >= '${sp.start}' AND a.recorded_at::time < '${sp.end}')`
            ).join(' OR ')}
        )
      GROUP BY 1, a.employee_id, e.name
    ),
    emp_totals AS (
      SELECT employee_id,
        COUNT(DISTINCT DATE_TRUNC('minute', a.recorded_at)) * 60 as unique_total_seconds
      FROM app_usage a JOIN employees e ON a.employee_id=e.id
      WHERE e.active=true AND a.employee_id = ANY($1::int[])
        ${date ? dateFilter : ''}
        AND (
          ${shiftParams.length === 0 ? 'true' :
            shiftParams.map(sp => sp.overnight ?
              `(a.employee_id=${sp.id} AND (a.recorded_at::time >= '${sp.start}' OR a.recorded_at::time < '${sp.end}'))` :
              `(a.employee_id=${sp.id} AND a.recorded_at::time >= '${sp.start}' AND a.recorded_at::time < '${sp.end}')`
            ).join(' OR ')}
        )
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
    // Recalculate shift_active_seconds using effective roster (temp override applied)
    const rows = result.rows.map(r => {
      const emp = rosterMap[r.employee_id];
      const shiftStart = emp?.shift_start || null;
      const shiftEnd = emp?.shift_end || null;
      let shiftActiveSecs = parseInt(r.shift_active_seconds) || 0;
      // If temp override changed the shift, recalculate proportionally
      if (emp && shiftStart && shiftEnd) {
        const [sh, sm] = shiftStart.slice(0,5).split(':').map(Number);
        const [eh, em] = shiftEnd.slice(0,5).split(':').map(Number);
        const sMin = sh*60+sm, eMin = eh*60+em;
        const overnight = eMin <= sMin;
        const shiftMins = overnight ? (1440-sMin+eMin) : (eMin-sMin);
        // Use proportion: shift_active = total * (shift_mins / 1440)
        const total = parseInt(r.total_seconds) || 0;
        // Only recalculate if roster was overridden
        if (emp.roster_name !== r.roster_name) {
          shiftActiveSecs = Math.round(total * shiftMins / 1440);
        }
      }
      return Object.assign({}, r, {
        shift_start: shiftStart,
        shift_end: shiftEnd,
        roster_name: emp?.roster_name || null,
        shift_active_seconds: shiftActiveSecs
      });
    });

    res.json({ rows, total, page, pages, emps });
  } catch (err) {
    console.error("[AppUsage] Error:", err.message, err.stack);
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
    const { machine_id } = req.query;
    const result = await pool.query(
      'SELECT agent_token, machine_id, name FROM employees WHERE email=$1 AND active=true',
      [req.params.email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Employee not found' });
    const emp = result.rows[0];
    // Check if this email is already registered on a different machine
    if (machine_id && emp.machine_id && emp.machine_id !== machine_id) {
      return res.status(409).json({ 
        error: 'already_registered',
        message: 'This employee is already monitored on another PC (' + emp.machine_id + '). Contact your administrator.'
      });
    }
    // Register machine_id if not set
    if (machine_id && !emp.machine_id) {
      await pool.query('UPDATE employees SET machine_id=$1 WHERE email=$2', [machine_id, req.params.email]);
    }
    res.json({ token: emp.agent_token, name: emp.name });
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
    const { employee_id, flagged } = req.query;
    let query = `SELECT s.recorded_at::date::text as date, COUNT(*) as count FROM screenshots s JOIN employees e ON s.employee_id=e.id WHERE e.active=true AND s.recorded_at >= NOW() - INTERVAL '90 days'`;
    const params = [];
    if (flagged === 'true') { query += ` AND s.flagged=true`; }
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
    const date = req.query.date || null;
    const dateFilter = date ? ' AND recorded_at::date=$2' : '';
    const params = date ? [id, date] : [id];
    const screenshots = await pool.query('SELECT COUNT(*) FROM screenshots WHERE employee_id=$1'+dateFilter, params);
    const webSites = await pool.query("SELECT COUNT(DISTINCT url) FROM web_activity WHERE employee_id=$1 AND url NOT LIKE '[Incognito]%'"+dateFilter, params);
    const webIncognito = await pool.query("SELECT COUNT(DISTINCT url) FROM web_activity WHERE employee_id=$1 AND url LIKE '[Incognito]%'"+dateFilter, params);
    const appUsage = await pool.query('SELECT COUNT(DISTINCT app_name) FROM app_usage WHERE employee_id=$1'+dateFilter, params);
    // Get roster info
    const empInfo = await pool.query(`SELECT e.*, r.name as roster_name, r.start_time as shift_start, r.end_time as shift_end FROM employees e LEFT JOIN duty_rosters r ON e.roster_id=r.id WHERE e.id=$1`, [id]);
    let emp = empInfo.rows[0] || {};
    // Apply temp shift override if date selected
    const dateParam = req.query.date;
    if (dateParam) {
      const effRoster = await getEffectiveRoster(id, dateParam);
      if (effRoster) {
        emp = Object.assign({}, emp, {
          shift_start: effRoster.start_time,
          shift_end: effRoster.end_time,
          roster_name: effRoster.name
        });
      }
    }
    const PRODUCTIVE = ['github','gitlab','jira','confluence','notion','slack','teams','zoom','docs.google','sheets','gmail','outlook','office','sharepoint','figma','linear','asana','trello','monday','clickup','stackoverflow','aws','azure','cloudflare','workpulse','claude','chatgpt','erp'];
    const NONPROD = ['youtube','facebook','instagram','twitter','tiktok','netflix','reddit','whatsapp','telegram','snapchat','pinterest','tumblr','twitch'];

    function inShiftFn(recordedAt, shiftStart, shiftEnd) {
      const t = new Date(recordedAt);
      const tM = t.getHours()*60+t.getMinutes();
      const s = shiftStart.split(':'); const sM=parseInt(s[0])*60+parseInt(s[1]);
      const e = shiftEnd.split(':'); const eM=parseInt(e[0])*60+parseInt(e[1]);
      return eM>sM ? (tM>=sM&&tM<eM) : (tM>=sM||tM<eM);
    }

    // WEB ACTIVITY — per minute with url and shift info
    const webRows = await pool.query("SELECT url, COUNT(DISTINCT date_trunc('minute',recorded_at)) as mins FROM web_activity WHERE employee_id=$1 AND url NOT LIKE '[Incognito]%'"+dateFilter+" GROUP BY url", params);
    let webProd=0, webNonProd=0, webTotal=0;
    webRows.rows.forEach(r=>{ const m=parseInt(r.mins)||0; webTotal+=m; if(PRODUCTIVE.some(k=>r.url.includes(k))) webProd+=m; else if(NONPROD.some(k=>r.url.includes(k))) webNonProd+=m; });
    const webNeutral = webTotal - webProd - webNonProd;

    // WEB — on/off shift + productivity breakdown per shift
    let webOnShift=0, webOffShift=0;
    let webOnProd=0, webOnNeutral=0, webOnNonProd=0;
    let webOffProd=0, webOffNeutral=0, webOffNonProd=0;
    if(emp.shift_start && emp.shift_end) {
      // Get one row per distinct minute — pick dominant url for that minute
      const webShiftRows = await pool.query(
        "SELECT date_trunc('minute',recorded_at) as minute, MIN(recorded_at) as ra, "+
        "mode() WITHIN GROUP (ORDER BY url) as url "+
        "FROM web_activity WHERE employee_id=$1 AND url NOT LIKE '[Incognito]%'"+dateFilter+
        " GROUP BY date_trunc('minute',recorded_at)", params);
      webShiftRows.rows.forEach(r=>{
        const isOn=inShiftFn(r.ra,emp.shift_start,emp.shift_end);
        const isProd=PRODUCTIVE.some(k=>r.url.includes(k));
        const isNonProd=NONPROD.some(k=>r.url.includes(k));
        if(isOn){
          webOnShift++;
          if(isProd) webOnProd++; else if(isNonProd) webOnNonProd++; else webOnNeutral++;
        } else {
          webOffShift++;
          if(isProd) webOffProd++; else if(isNonProd) webOffNonProd++; else webOffNeutral++;
        }
      });
    }

    // APP USAGE — on/off shift
    let appOnShift=0, appOffShift=0;
    if(emp.shift_start && emp.shift_end) {
      const appShiftRows = await pool.query("SELECT DISTINCT date_trunc('minute',recorded_at) as m, MIN(recorded_at) as ra FROM app_usage WHERE employee_id=$1"+dateFilter+" GROUP BY date_trunc('minute',recorded_at)", params);
      appShiftRows.rows.forEach(r=>{ inShiftFn(r.ra,emp.shift_start,emp.shift_end)?appOnShift++:appOffShift++; });
    }

    // SYSTEM EVENTS — first seen / last seen
    let firstSeen=null, lastSeen=null;
    let sysActiveMins=0, sysOnShiftMins=0, sysOffShiftMins=0;
    const tz = 'Asia/Kolkata';
    // Get all system events for the day to calculate active/on-shift/off-shift time
    const sysAllRows = await pool.query(
      "SELECT event_type, recorded_at FROM system_events WHERE employee_id=$1"+dateFilter+" ORDER BY recorded_at ASC", params
    );
    if(sysAllRows.rows.length) {
      // First/last seen (no shift filter)
      firstSeen = new Date(sysAllRows.rows[0].recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:tz});
      lastSeen  = new Date(sysAllRows.rows[sysAllRows.rows.length-1].recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:tz});
      // Calculate active time from sessions
      const startEvs = ['startup','wakeup','unlocked'];
      const endEvs   = ['shutdown','sleep','locked','idle_lock'];
      let sessStart = null;
      for(const row of sysAllRows.rows) {
        if(startEvs.includes(row.event_type) && !sessStart) {
          sessStart = new Date(row.recorded_at);
        } else if(endEvs.includes(row.event_type) && sessStart) {
          const sessEnd = new Date(row.recorded_at);
          const durMins = (sessEnd - sessStart) / 60000;
          sysActiveMins += durMins;
          // Check if in shift
          if(emp.shift_start && emp.shift_end) {
            const t = sessStart; const h=t.getHours(); const m=t.getMinutes();
            const tMins=h*60+m;
            const [sh,sm]=emp.shift_start.split(':').map(Number); const sMins=sh*60+sm;
            const [eh,em]=emp.shift_end.split(':').map(Number);   const eMins=eh*60+em;
            const inShift = eMins>sMins?(tMins>=sMins&&tMins<eMins):(tMins>=sMins||tMins<eMins);
            if(inShift) sysOnShiftMins+=durMins; else sysOffShiftMins+=durMins;
          } else {
            sysOffShiftMins+=durMins;
          }
          sessStart=null;
        }
      }
      if(sessStart) {
        const durMins=(new Date()-sessStart)/60000;
        sysActiveMins+=durMins; sysOffShiftMins+=durMins;
      }
    }

    res.json({
      screenshots: parseInt(screenshots.rows[0].count),
      websites: parseInt(webSites.rows[0].count),
      web_incognito: parseInt(webIncognito.rows[0].count),
      apps: parseInt(appUsage.rows[0].count),
      roster_name: emp.roster_name||null,
      shift_start: emp.shift_start||null,
      shift_end: emp.shift_end||null,
      // Web activity totals
      web_prod_mins: webProd,
      web_neutral_mins: webNeutral,
      web_nonprod_mins: webNonProd,
      web_total_mins: webTotal,
      web_on_shift: webOnShift,
      web_off_shift: webOffShift,
      // Web on-shift breakdown
      web_on_prod: webOnProd,
      web_on_neutral: webOnNeutral,
      web_on_nonprod: webOnNonProd,
      // Web off-shift breakdown
      web_off_prod: webOffProd,
      web_off_neutral: webOffNeutral,
      web_off_nonprod: webOffNonProd,
      // App usage
      app_on_shift: appOnShift,
      app_off_shift: appOffShift,
      // System events
      first_seen: firstSeen,
      last_seen: lastSeen,
      sys_active_mins: Math.round(sysActiveMins),
      sys_on_shift_mins: Math.round(sysOnShiftMins),
      sys_off_shift_mins: Math.round(sysOffShiftMins)
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
  // Add machine_id column to employees
  try {
    await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS machine_id VARCHAR(255)');
  } catch(err) { console.error('[MachineID] Init error:', err.message); }
  // Temp shift overrides table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS temp_shift_overrides (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        override_date DATE NOT NULL,
        roster_id INTEGER REFERENCES duty_rosters(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(employee_id, override_date)
      )
    `);
  } catch(err) { console.error('[TempShift] Init error:', err.message); }
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
      await pool.query('INSERT INTO system_events (employee_id, event_type, recorded_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.employee.id, event_type, new Date(recorded_at)]);
    } else {
      await pool.query('INSERT INTO system_events (employee_id, event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.employee.id, event_type]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/system-activity', requireLogin, async (req, res) => {
  const { employee_id, date } = req.query;
  try {
    const allowed = getAllowedEmployees(req);
    const params = [];
    let where = 'WHERE e.active=true';
    if (employee_id) { params.push(employee_id); where += ` AND s.employee_id=$${params.length}`; }
    // Default to today if no date
    const selectedDate = date || new Date().toISOString().split('T')[0];
    params.push(selectedDate); where += ` AND s.recorded_at::date=$${params.length}`;
    if (allowed) { params.push(allowed); where += ` AND s.employee_id = ANY($${params.length}::int[])`; }
    // Get all events for the day ordered ASC
    const result = await pool.query(
      `SELECT s.event_type, s.recorded_at, e.name as employee_name, e.id as employee_id,
        r.name as roster_name, r.start_time as shift_start, r.end_time as shift_end
       FROM system_events s
       JOIN employees e ON s.employee_id=e.id
       LEFT JOIN duty_rosters r ON e.roster_id=r.id
       ${where} ORDER BY s.employee_id, s.recorded_at ASC`,
      params
    );
    // Apply temp shift overrides
    const tempOverrides = {};
    for(const row of result.rows) {
      if(!tempOverrides[row.employee_id]) {
        const ov = await getEffectiveRoster(row.employee_id, selectedDate);
        tempOverrides[row.employee_id] = ov || null;
      }
    }
    // Group by employee
    const grouped = {};
    for(const row of result.rows) {
      const key = row.employee_id;
      const ov = tempOverrides[key];
      if(!grouped[key]) grouped[key] = {
        employee_id: row.employee_id,
        employee_name: row.employee_name,
        roster_name: ov ? ov.name : (row.roster_name||null),
        shift_start: ov ? ov.start_time : (row.shift_start||null),
        shift_end: ov ? ov.end_time : (row.shift_end||null),
        events: []
      };
      grouped[key].events.push({ type: row.event_type, time: row.recorded_at });
    }
    res.json({ date: selectedDate, employees: Object.values(grouped) });
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

// Restore screenshots from existing server backup file
app.post('/api/admin/restore/screenshots/frompath', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'No filename provided' });
  const safeName = path.basename(filename);
  const filepath = path.join(backupsDir, safeName);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found: ' + safeName });
  const ssDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
  const { execFile } = require('child_process');
  execFile('tar', ['-xzf', filepath, '-C', __dirname], {}, async (err) => {
    if (err) {
      console.error('[SS Restore FromPath] tar failed:', err.message);
      return res.status(500).json({ error: 'Extract failed: ' + err.message });
    }
    await auditLog(req, 'Screenshots Restored From Server', safeName);
    res.json({ success: true });
  });
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
         WHERE (w.recorded_at AT TIME ZONE '${tz}')::date BETWEEN $1::date AND $2::date ${empFilter}
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
         WHERE (a.recorded_at AT TIME ZONE '${tz}')::date BETWEEN $1::date AND $2::date ${empFilter}
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
    const r = await pool.query('SELECT smtp_host, smtp_port, smtp_user, smtp_from_name, smtp_tls, mfa_enabled, totp_global_enabled FROM email_config LIMIT 1');
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
      await pool.query('UPDATE email_config SET mfa_enabled=$1, totp_global_enabled=$2 WHERE id=$3', [mfa_enabled, totp_global_enabled !== false, existing.rows[0].id]);
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
app.post('/api/admin/report-job', requireLogin, async (req, res) => {
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
app.get('/api/admin/report-jobs', requireLogin, async (req, res) => {
  try {
    const jobs = await pool.query(
      'SELECT id, admin_name, employee_name, from_date::text, to_date::text, status, progress, filename, error_msg, created_at, completed_at FROM report_jobs WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.session.adminId]
    );
    res.json(jobs.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Download a completed report
app.get('/api/admin/report-download/:id', requireLogin, async (req, res) => {
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
app.delete('/api/admin/report-job/:id', requireLogin, async (req, res) => {
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
  wb.creator = 'WorkPulse'; wb.created = new Date();
  // Use local date to avoid UTC timezone rollback
  function pgDateToStr(d) {
    if (!d) return null;
    if (typeof d === 'string') return d.split('T')[0].split(' ')[0];
    // PostgreSQL DATE stored as midnight UTC but represents local date
    // Add IST offset (5h30m = 19800 seconds) to get correct local date
    const tz = global.sysTimezone || 'Asia/Kolkata';
    const dt = new Date(d);
    const localStr = dt.toLocaleDateString('en-CA', { timeZone: global.sysTimezone || 'Asia/Kolkata' }); // returns YYYY-MM-DD
    return localStr;
  }
  const tz = global.sysTimezone || 'Asia/Kolkata';
  const fromDate = pgDateToStr(job.from_date);
  const toDate   = pgDateToStr(job.to_date);
  console.log('[Report] from_date raw:', job.from_date, 'parsed:', fromDate, 'to:', toDate);

  const C = { dark:'FF0D1117', mid:'FF181C22', border:'FF2D3748',
    accent:'FF00E5FF', green:'FF10B981', red:'FFEF4444', amber:'FFF59E0B',
    purple:'FF7C3AED', text:'FFE2E8F0', sub:'FF94A3B8' };
  const bt = () => ({ style:'thin', color:{ argb:C.border } });
  const allB = () => ({ top:bt(), left:bt(), bottom:bt(), right:bt() });

  function hdr(row, bg='FF1A2035') {
    row.height = 24;
    row.eachCell(cell => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:bg } };
      cell.font = { bold:true, color:{ argb:C.accent }, size:10, name:'Calibri' };
      cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
      cell.border = allB();
    });
  }
  function dat(row, even, isTemp) {
    row.height = 18;
    const bg = isTemp ? 'FF1A2810' : even ? 'FF181C22' : 'FF111418';
    row.eachCell(cell => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:bg } };
      cell.font = { color:{ argb:C.text }, size:10, name:'Calibri' };
      cell.alignment = { vertical:'middle' };
      cell.border = allB();
    });
  }
  function fmtMins(m) { m=Math.round(m); const h=Math.floor(m/60); const mm=m%60; return h>0?h+'h '+mm+'m':mm+'m'; }
  function inShift(t, ss, se) {
    if (!ss || !se) return false;
    const [sh,sm]=ss.slice(0,5).split(':').map(Number);
    const [eh,em]=se.slice(0,5).split(':').map(Number);
    const sM=sh*60+sm, eM=eh*60+em;
    const dt=new Date(t); const tM=dt.getHours()*60+dt.getMinutes();
    return eM>sM ? (tM>=sM&&tM<eM) : (tM>=sM||tM<eM);
  }
  function addTitle(ws, text, cols) {
    ws.mergeCells('A1:'+String.fromCharCode(64+cols)+'1');
    const c=ws.getCell('A1');
    c.value=text; c.font={bold:true,size:13,color:{argb:C.accent},name:'Calibri'};
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0A0E17'}};
    c.alignment={vertical:'middle',horizontal:'center'};
    ws.getRow(1).height=30;
  }

  // Get employees with roster
  let empQuery = `SELECT e.*, r.name as roster_name, r.start_time as shift_start, r.end_time as shift_end
    FROM employees e LEFT JOIN duty_rosters r ON e.roster_id=r.id WHERE e.active=true`;
  const empParams = [];
  if (job.employee_id) { empParams.push(job.employee_id); empQuery += ' AND e.id=$1'; }
  const emps = await pool.query(empQuery, empParams);
  const empMap = {};
  emps.rows.forEach(e => { empMap[e.id] = e; });

  // Get temp shift overrides
  const tempOv = {};
  for (const emp of emps.rows) {
    const ov = await pool.query(
      `SELECT t.override_date::text as date, r.name, r.start_time, r.end_time
       FROM temp_shift_overrides t JOIN duty_rosters r ON t.roster_id=r.id
       WHERE t.employee_id=$1 AND t.override_date BETWEEN $2::date AND $3::date`,
      [emp.id, fromDate, toDate]
    );
    tempOv[emp.id] = {};
    ov.rows.forEach(r => { tempOv[emp.id][r.date.split('T')[0]] = r; });
  }

  function getShift(empId, date) {
    const ov = tempOv[empId]?.[date];
    const emp = empMap[empId] || {};
    if (ov) return { name:ov.name, start:ov.start_time, end:ov.end_time, isTemp:true };
    return { name:emp.roster_name, start:emp.shift_start, end:emp.shift_end, isTemp:false };
  }

  const PROD=['github','gitlab','jira','notion','slack','teams','zoom','docs.google','sheets','gmail','outlook','office','figma','linear','asana','trello','monday','clickup','stackoverflow','aws','azure','workpulse','claude','erp'];
  const NONPROD=['youtube','facebook','instagram','twitter','tiktok','netflix','reddit','whatsapp','telegram','snapchat','pinterest','twitch'];

  await pool.query("UPDATE report_jobs SET progress=10 WHERE id=$1", [job.id]);

  // ── SHEET 1: EMPLOYEE SUMMARY ──────────────────────────────────
  const ws1 = wb.addWorksheet('Employee Summary');
  ws1.views = [{ state:'frozen', ySplit:2 }];
  addTitle(ws1, 'WorkPulse Productivity Report — '+fromDate+(fromDate!==toDate?' to '+toDate:''), 12);
  ws1.columns = [
    {key:'name',width:22},{key:'dept',width:16},{key:'date',width:13},
    {key:'roster',width:26},{key:'hours',width:14},{key:'temp',width:8},
    {key:'firstSeen',width:13},{key:'lastSeen',width:13},
    {key:'webOn',width:14},{key:'webOff',width:14},
    {key:'appOn',width:14},{key:'appOff',width:14}
  ];
  const h1=ws1.getRow(2);
  h1.values=['Employee','Department','Date','Shift Roster','Shift Hours','Temp?','First Seen','Last Seen','Web On-Shift','Web Off-Shift','App On-Shift','App Off-Shift'];
  hdr(h1);

  for (const emp of emps.rows) {
    const dates=[];
    let d=new Date(fromDate);
    while(d<=new Date(toDate)){ dates.push(d.toISOString().split('T')[0]); d.setDate(d.getDate()+1); }
    for (const date of dates) {
      const shift = getShift(emp.id, date);
      const ss=shift.start?.slice(0,5), se=shift.end?.slice(0,5);
      const webQ = await pool.query(
        `SELECT date_trunc('minute',recorded_at) as m, MIN(recorded_at) as ra FROM web_activity
         WHERE employee_id=$1 AND (recorded_at AT TIME ZONE '${tz}')::date=$2::date AND url NOT LIKE '[Incognito]%' AND url != 'Desktop' GROUP BY 1`,
        [emp.id, date]);
      let webOn=0,webOff=0;
      webQ.rows.forEach(r=>{ inShift(r.ra,ss,se)?webOn++:webOff++; });
      const appQ = await pool.query(
        `SELECT date_trunc('minute',recorded_at) as m, MIN(recorded_at) as ra FROM app_usage
         WHERE employee_id=$1 AND (recorded_at AT TIME ZONE '${tz}')::date=$2::date
         AND LOWER(app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost') GROUP BY 1`,
        [emp.id, date]);
      let appOn=0,appOff=0;
      appQ.rows.forEach(r=>{ inShift(r.ra,ss,se)?appOn++:appOff++; });
      if(webOn+webOff+appOn+appOff===0) continue;
      // Get first/last seen from system events
      const sysQ=await pool.query(
        `SELECT MIN(recorded_at) as first_seen, MAX(recorded_at) as last_seen FROM system_events WHERE employee_id=$1 AND (recorded_at AT TIME ZONE '${tz}')::date=$2::date`,
        [emp.id, date]);
      const firstSeen=sysQ.rows[0]?.first_seen?new Date(sysQ.rows[0].first_seen).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}):'—';
      const lastSeen=sysQ.rows[0]?.last_seen?new Date(sysQ.rows[0].last_seen).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}):'—';
      const row=ws1.addRow({name:emp.name,dept:emp.department||'—',date,
        roster:shift.name||'Not Assigned',hours:ss&&se?ss+' – '+se:'—',
        temp:shift.isTemp?'⚡ Yes':'No',firstSeen,lastSeen,
        webOn:fmtMins(webOn),webOff:fmtMins(webOff),appOn:fmtMins(appOn),appOff:fmtMins(appOff)});
      dat(row, ws1.rowCount%2===0, shift.isTemp);
      row.getCell('roster').font={bold:true,color:{argb:shift.isTemp?C.amber:C.accent},size:10,name:'Calibri'};
      if(shift.isTemp) row.getCell('temp').font={bold:true,color:{argb:C.amber},size:10,name:'Calibri'};
    }
  }

  await pool.query("UPDATE report_jobs SET progress=35 WHERE id=$1", [job.id]);

  // ── SHEET 2: WEB ACTIVITY ──────────────────────────────────────
  const ws2 = wb.addWorksheet('Web Activity');
  ws2.views=[{state:'frozen',ySplit:2}];
  addTitle(ws2,'Web Activity — Shift Based',8);
  ws2.columns=[{key:'name',width:20},{key:'date',width:13},{key:'roster',width:24},
    {key:'url',width:34},{key:'browser',width:14},{key:'mins',width:11},{key:'onOff',width:12},{key:'prod',width:15}];
  const h2=ws2.getRow(2);
  h2.values=['Employee','Date','Shift','Website','Browser','Time Spent','On/Off Shift','Productivity'];
  hdr(h2);

  const p2=[fromDate,toDate]; if(job.employee_id) p2.push(job.employee_id);
  const f2=job.employee_id?'AND w.employee_id=$3':'';
  const webRows=await pool.query(
    `SELECT e.id as eid, e.name as emp_name, w.url, w.browser,
     (w.recorded_at AT TIME ZONE '${tz}')::date as date,
     MIN(w.recorded_at) as ra, COUNT(DISTINCT date_trunc('minute',w.recorded_at AT TIME ZONE '${tz}')) as mins
     FROM web_activity w JOIN employees e ON w.employee_id=e.id
     WHERE (w.recorded_at AT TIME ZONE '${tz}')::date BETWEEN $1::date AND $2::date ${f2}
     AND w.url NOT LIKE '[Incognito]%' AND w.url != 'Desktop' AND w.url != 'Unknown' AND length(w.url)<150
     GROUP BY e.id,e.name,w.url,w.browser,(w.recorded_at AT TIME ZONE '${tz}')::date ORDER BY e.name,date,mins DESC`, p2);
  webRows.rows.forEach((r,i)=>{
    const date=pgDateToStr(r.date);
    const shift=getShift(r.eid,date);
    const ss=shift.start?.slice(0,5),se=shift.end?.slice(0,5);
    const on=inShift(r.ra,ss,se);
    const url=r.url||'';
    const isProd=PROD.some(k=>url.includes(k));
    const isNP=NONPROD.some(k=>url.includes(k));
    const row=ws2.addRow({name:r.emp_name,date,roster:shift.name||'—',url,browser:r.browser||'—',
      mins:fmtMins(parseInt(r.mins)||0),onOff:on?'On Shift':'Off Shift',prod:isProd?'Productive':isNP?'Non-Productive':'Neutral'});
    dat(row,i%2===0,shift.isTemp);
    row.getCell('onOff').font={bold:true,color:{argb:on?C.green:C.red},size:10,name:'Calibri'};
    row.getCell('prod').font={color:{argb:isProd?C.green:isNP?C.red:C.amber},size:10,name:'Calibri'};
    if(shift.isTemp) row.getCell('roster').font={bold:true,color:{argb:C.amber},size:10,name:'Calibri'};
  });

  await pool.query("UPDATE report_jobs SET progress=60 WHERE id=$1", [job.id]);

  // ── SHEET 3: APP USAGE ─────────────────────────────────────────
  const ws3 = wb.addWorksheet('App Usage');
  ws3.views=[{state:'frozen',ySplit:2}];
  addTitle(ws3,'App Usage — Shift Based',7);
  ws3.columns=[{key:'name',width:20},{key:'date',width:13},{key:'roster',width:24},
    {key:'app',width:28},{key:'mins',width:11},{key:'onOff',width:12},{key:'temp',width:8}];
  const h3=ws3.getRow(2);
  h3.values=['Employee','Date','Shift','App Name','Time Spent','On/Off Shift','Temp?'];
  hdr(h3);

  const p3=[fromDate,toDate]; if(job.employee_id) p3.push(job.employee_id);
  const f3=job.employee_id?'AND a.employee_id=$3':'';
  const appRows=await pool.query(
    `SELECT e.id as eid, e.name as emp_name, a.app_name,
     (a.recorded_at AT TIME ZONE '${tz}')::date as date,
     MIN(a.recorded_at) as ra, COUNT(DISTINCT date_trunc('minute',a.recorded_at AT TIME ZONE '${tz}')) as mins
     FROM app_usage a JOIN employees e ON a.employee_id=e.id
     WHERE (a.recorded_at AT TIME ZONE '${tz}')::date BETWEEN $1::date AND $2::date ${f3}
     AND LOWER(a.app_name) NOT IN ('applicationframehost','desktop','unknown','','searchhost','textinputhost')
     AND a.app_name NOT SIMILAR TO '[0-9]%'
     GROUP BY e.id,e.name,a.app_name,(a.recorded_at AT TIME ZONE '${tz}')::date ORDER BY e.name,date,mins DESC`, p3);
  appRows.rows.forEach((r,i)=>{
    const date=pgDateToStr(r.date);
    const shift=getShift(r.eid,date);
    const ss=shift.start?.slice(0,5),se=shift.end?.slice(0,5);
    const on=inShift(r.ra,ss,se);
    const row=ws3.addRow({name:r.emp_name,date,roster:shift.name||'—',app:r.app_name,
      mins:fmtMins(parseInt(r.mins)||0),onOff:on?'On Shift':'Off Shift',temp:shift.isTemp?'⚡ Yes':'No'});
    dat(row,i%2===0,shift.isTemp);
    row.getCell('onOff').font={bold:true,color:{argb:on?C.green:C.red},size:10,name:'Calibri'};
    if(shift.isTemp){ row.getCell('roster').font={bold:true,color:{argb:C.amber},size:10,name:'Calibri'}; row.getCell('temp').font={bold:true,color:{argb:C.amber},size:10,name:'Calibri'}; }
  });

  await pool.query("UPDATE report_jobs SET progress=80 WHERE id=$1", [job.id]);

  // ── SHEET 4: SYSTEM ACTIVITY ───────────────────────────────────
  const ws4 = wb.addWorksheet('System Activity');
  ws4.views=[{state:'frozen',ySplit:2}];
  addTitle(ws4,'System Activity — Sessions',8);
  ws4.columns=[{key:'name',width:20},{key:'date',width:13},{key:'roster',width:24},
    {key:'event',width:18},{key:'time',width:16},{key:'onOff',width:10},{key:'dur',width:14},{key:'temp',width:8}];
  const h4=ws4.getRow(2);
  h4.values=['Employee','Date','Shift','Session / Event','Start → End Time','In Shift?','Duration','Temp?'];
  hdr(h4);

  const p4=[fromDate,toDate]; if(job.employee_id) p4.push(job.employee_id);
  const f4=job.employee_id?'AND s.employee_id=$3':'';
  const sysRows=await pool.query(
    `SELECT e.id as eid, e.name as emp_name, s.event_type, s.recorded_at,
     (s.recorded_at AT TIME ZONE '${tz}')::date as date
     FROM system_events s JOIN employees e ON s.employee_id=e.id
     WHERE (s.recorded_at AT TIME ZONE '${tz}')::date BETWEEN $1::date AND $2::date ${f4}
     ORDER BY e.name, s.recorded_at ASC`, p4);
  // Build sessions from events
  const startEvs=['startup','wakeup','unlocked'];
  const endEvs=['shutdown','sleep','locked','idle_lock'];
  const EL={startup:'Startup',shutdown:'Shutdown',sleep:'Sleep',wakeup:'Wake from Sleep',
    locked:'Win+L Lock',unlocked:'Unlocked',idle_lock:'Idle Lock'};
  // Group by employee
  const empEvents={};
  sysRows.rows.forEach(r=>{
    if(!empEvents[r.eid]) empEvents[r.eid]=[];
    empEvents[r.eid].push(r);
  });
  let sessNum=0;
  for(const [eid,events] of Object.entries(empEvents)){
    let si=0;
    while(si<events.length){
      const ev=events[si];
      if(startEvs.includes(ev.event_type)){
        sessNum++;
        const sessStart=ev;
        let sessEnd=null;
        let ni=si+1;
        while(ni<events.length){
          if(endEvs.includes(events[ni].event_type)){ sessEnd=events[ni]; break; }
          ni++;
        }
        const date=pgDateToStr(sessStart.date);
        const shift=getShift(parseInt(eid),date);
        const ss=shift.start?.slice(0,5),se=shift.end?.slice(0,5);
        const onShift=inShift(sessStart.recorded_at,ss,se);
        const startTime=new Date(sessStart.recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'});
        const endTime=sessEnd?new Date(sessEnd.recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}):'Active';
        const endLabel=sessEnd?EL[sessEnd.event_type]||sessEnd.event_type:'—';
        let dur='Active';
        if(sessEnd){ const dm=Math.round((new Date(sessEnd.recorded_at)-new Date(sessStart.recorded_at))/60000); dur=fmtMins(dm); }
        const row=ws4.addRow({name:sessStart.emp_name,date,roster:shift.name||'—',
          event:'Session '+sessNum+': '+EL[sessStart.event_type],
          time:startTime+' → '+endTime,onOff:onShift?'Yes':'No',dur,temp:shift.isTemp?'⚡ Yes':'No'});
        dat(row,sessNum%2===0,shift.isTemp);
        row.getCell('onOff').font={bold:true,color:{argb:onShift?C.green:C.red},size:10,name:'Calibri'};
        row.getCell('event').font={bold:true,color:{argb:C.green},size:10,name:'Calibri'};
        row.getCell('time').font={color:{argb:C.sub},size:10,name:'Calibri'};
        row.getCell('dur').font={bold:true,color:{argb:C.accent},size:10,name:'Calibri'};
        if(shift.isTemp) row.getCell('roster').font={bold:true,color:{argb:C.amber},size:10,name:'Calibri'};
        si=sessEnd?ni+1:events.length;
      } else { si++; }
    }
  }

  await pool.query("UPDATE report_jobs SET progress=95 WHERE id=$1", [job.id]);

  // Save
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
      const fromDate2 = pgDateToStr ? pgDateToStr(job.from_date) : job.from_date.toISOString().split('T')[0];
      const toDate2   = pgDateToStr ? pgDateToStr(job.to_date) : job.to_date.toISOString().split('T')[0];
      const smtpUser = (await pool.query('SELECT smtp_user FROM email_config LIMIT 1')).rows[0]?.smtp_user;
      await mailer.sendMail({
        from: `"WorkPulse" <${smtpUser}>`,
        to: adminEmail,
        subject: `WorkPulse Report Ready — ${job.employee_name} (${fromDate2} to ${toDate2})`,
        html: `<div style="font-family:sans-serif;padding:24px;max-width:500px">
          <h2 style="color:#00e5ff;margin-bottom:8px">📊 Your Report is Ready</h2>
          <p style="color:#555;margin-bottom:16px">Your WorkPulse report has been generated and is attached to this email.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr><td style="padding:8px;color:#888;font-size:12px">Employee</td><td style="padding:8px;font-weight:600">${job.employee_name}</td></tr>
            <tr style="background:#f9f9f9"><td style="padding:8px;color:#888;font-size:12px">Date Range</td><td style="padding:8px;font-weight:600">${fromDate2} → ${toDate2}</td></tr>
            <tr><td style="padding:8px;color:#888;font-size:12px">File</td><td style="padding:8px;font-family:monospace;font-size:11px">${filename}</td></tr>
          </table>
          <p style="color:#888;font-size:12px">You can also log in to WorkPulse → Reports → Report Queue to download your file.</p>
        </div>`,
        attachments: [{
          filename: filename,
          path: filePath
        }]
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
app.post('/api/admin/report-job', requireLogin, async (req, res) => {
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
app.get('/api/admin/report-jobs', requireLogin, async (req, res) => {
  try {
    const jobs = await pool.query(
      'SELECT id, admin_name, employee_name, from_date::text, to_date::text, status, progress, filename, error_msg, created_at, completed_at FROM report_jobs WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.session.adminId]
    );
    res.json(jobs.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Download a completed report
app.get('/api/admin/report-download/:id', requireLogin, async (req, res) => {
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
app.delete('/api/admin/report-job/:id', requireLogin, async (req, res) => {
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


function calcNextRun(frequency, dayOfWeek, dayOfMonth, sendHour) {
  const tz = global.sysTimezone || 'Asia/Kolkata';
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const next = new Date(nowInTz);
  next.setHours(sendHour||8, 0, 0, 0);
  if (frequency === 'daily') {
    if (next <= nowInTz) next.setDate(next.getDate() + 1);
  } else if (frequency === 'weekly') {
    const dow = parseInt(dayOfWeek) || 1;
    next.setDate(next.getDate() + ((dow - next.getDay() + 7) % 7 || 7));
  } else if (frequency === 'monthly') {
    const dom = parseInt(dayOfMonth) || 1;
    next.setDate(dom);
    if (next <= nowInTz) { next.setMonth(next.getMonth() + 1); next.setDate(dom); }
  }
  return next;
}

// ---- REPORT SCHEDULE ROUTES ----
app.get('/api/admin/report-schedules', requireLogin, async (req, res) => {
  try {
    const rows = await pool.query('SELECT * FROM report_schedules WHERE admin_id=$1 ORDER BY created_at DESC', [req.session.adminId]);
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/report-schedules', requireLogin, async (req, res) => {
  const { employee_id, frequency, day_of_week, day_of_month, email, send_hour } = req.body;
  try {
    let empName = 'All Employees';
    if (employee_id) {
      const er = await pool.query('SELECT name FROM employees WHERE id=$1', [employee_id]);
      if (er.rows.length) empName = er.rows[0].name;
    }
    const nextRun = calcNextRun(frequency, day_of_week, day_of_month, send_hour||8);
    const report_range = req.body.report_range || 'yesterday';
    await pool.query(
      'INSERT INTO report_schedules (admin_id, admin_name, employee_id, employee_name, frequency, day_of_week, day_of_month, email, next_run, report_range) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [req.session.adminId, req.session.adminName, employee_id||null, empName, frequency, day_of_week||null, day_of_month||null, email||null, nextRun, report_range]
    );
    await auditLog(req, 'Report Schedule Created', empName + ' - ' + frequency);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/report-schedules/:id', requireLogin, async (req, res) => {
  try {
    await pool.query('UPDATE report_schedules SET active=$1 WHERE id=$2 AND admin_id=$3', [req.body.active, req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/report-schedules/:id', requireLogin, async (req, res) => {
  try {
    await pool.query('DELETE FROM report_schedules WHERE id=$1 AND admin_id=$2', [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// ---- END REPORT SCHEDULE ROUTES ----

// Cron: check schedules every 5 minutes
schedule.scheduleJob('*/5 * * * *', async function() {
  try {
    const due = await pool.query("SELECT * FROM report_schedules WHERE active=true AND next_run <= NOW()");
    for (const sched of due.rows) {
      try {
        const now = new Date();
        const tz = global.sysTimezone || 'Asia/Kolkata';
        const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        // Format date using local parts to avoid UTC rollback
        function fmtLocal(d) {
          return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
        }
        let fromDate, toDate;
        const range = sched.report_range || 'yesterday';
        const yesterday = new Date(nowInTz); yesterday.setDate(yesterday.getDate()-1);
        toDate = fmtLocal(yesterday);
        if (range === 'yesterday') {
          fromDate = fmtLocal(yesterday);
        } else if (range === '7days') {
          const d = new Date(nowInTz); d.setDate(d.getDate()-7);
          fromDate = fmtLocal(d);
        } else if (range === '30days') {
          const d = new Date(nowInTz); d.setDate(d.getDate()-30);
          fromDate = fmtLocal(d);
        } else if (range === '3months') {
          const d = new Date(nowInTz); d.setMonth(d.getMonth()-3);
          fromDate = fmtLocal(d);
        } else if (range === '6months') {
          const d = new Date(nowInTz); d.setMonth(d.getMonth()-6);
          fromDate = fmtLocal(d);
        } else if (range === '1year') {
          const d = new Date(nowInTz); d.setFullYear(d.getFullYear()-1);
          fromDate = fmtLocal(d);
        } else {
          fromDate = fmtLocal(yesterday);
        }
        await pool.query(
          "INSERT INTO report_jobs (admin_id, admin_name, employee_id, employee_name, from_date, to_date, status, progress) VALUES ($1,$2,$3,$4,$5,$6,'queued',0)",
          [sched.admin_id, sched.admin_name, sched.employee_id, sched.employee_name, fromDate, toDate]
        );
        const nextRun = calcNextRun(sched.frequency, sched.day_of_week, sched.day_of_month, sched.send_hour||8);
        await pool.query('UPDATE report_schedules SET last_run=NOW(), next_run=$1 WHERE id=$2', [nextRun, sched.id]);
        console.log('[Scheduled Report] Queued for:', sched.employee_name, sched.frequency);
        processNextJob();
      } catch(e) { console.error('[Scheduled Report] Error:', e.message); }
    }
  } catch(e) { console.error('[Scheduled Report] Cron error:', e.message); }
});


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

// Load system timezone on startup
(async function loadSysTz() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key='sys_settings' LIMIT 1");
    if (r.rows.length) {
      const s = JSON.parse(r.rows[0].value);
      global.sysTimezone = s.timezone || 'Asia/Kolkata';
      console.log('[Timezone] Using:', global.sysTimezone);
    }
  } catch(e) { global.sysTimezone = 'Asia/Kolkata'; }
})();


// Date dot APIs for employee profile calendar
app.get('/api/dashboard/web-activity-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    let q = `SELECT recorded_at::date::text as date, COUNT(*) as count FROM web_activity w JOIN employees e ON w.employee_id=e.id WHERE e.active=true AND w.recorded_at >= NOW()-INTERVAL '90 days'`;
    const p = [];
    if (employee_id) { p.push(employee_id); q += ` AND w.employee_id=$${p.length}`; }
    if (allowed) { p.push(allowed); q += ` AND w.employee_id=ANY($${p.length}::int[])`; }
    q += ' GROUP BY recorded_at::date ORDER BY date DESC';
    const rows = await pool.query(q, p);
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/app-usage-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    let q = `SELECT recorded_at::date::text as date, COUNT(*) as count FROM app_usage a JOIN employees e ON a.employee_id=e.id WHERE e.active=true AND a.recorded_at >= NOW()-INTERVAL '90 days'`;
    const p = [];
    if (employee_id) { p.push(employee_id); q += ` AND a.employee_id=$${p.length}`; }
    if (allowed) { p.push(allowed); q += ` AND a.employee_id=ANY($${p.length}::int[])`; }
    q += ' GROUP BY recorded_at::date ORDER BY date DESC';
    const rows = await pool.query(q, p);
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/system-event-dates', requireLogin, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const allowed = getAllowedEmployees(req);
    let q = `SELECT recorded_at::date::text as date, COUNT(*) as count FROM system_events s JOIN employees e ON s.employee_id=e.id WHERE e.active=true AND s.recorded_at >= NOW()-INTERVAL '90 days'`;
    const p = [];
    if (employee_id) { p.push(employee_id); q += ` AND s.employee_id=$${p.length}`; }
    if (allowed) { p.push(allowed); q += ` AND s.employee_id=ANY($${p.length}::int[])`; }
    q += ' GROUP BY recorded_at::date ORDER BY date DESC';
    const rows = await pool.query(q, p);
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── UNREGISTER MACHINE ───
app.post('/api/agent/unregister', async (req, res) => {
  const token = req.headers['x-agent-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    await pool.query('UPDATE employees SET machine_id=NULL WHERE agent_token=$1', [token]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── TEMP SHIFT OVERRIDE ROUTES ───
app.get('/api/employees/:id/temp-shifts', requireLogin, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT t.*, r.name as roster_name, r.start_time, r.end_time
       FROM temp_shift_overrides t
       JOIN duty_rosters r ON t.roster_id = r.id
       WHERE t.employee_id=$1 ORDER BY t.override_date`, [req.params.id]
    );
    res.json(rows.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees/:id/temp-shift', requireLogin, async (req, res) => {
  const { date, roster_id } = req.body;
  if (!date || !roster_id) return res.status(400).json({ error: 'date and roster_id required' });
  try {
    const result = await pool.query(
      `INSERT INTO temp_shift_overrides (employee_id, override_date, roster_id)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (employee_id, override_date) DO UPDATE SET roster_id=$3
       RETURNING *`,
      [req.params.id, date, roster_id]
    );
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/employees/:id/temp-shift', requireLogin, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    await pool.query(
      'DELETE FROM temp_shift_overrides WHERE employee_id=$1 AND override_date=$2::date',
      [req.params.id, date]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/employees/:id/temp-shift-dates', requireLogin, async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT override_date::text as date FROM temp_shift_overrides WHERE employee_id=$1',
      [req.params.id]
    );
    res.json(rows.rows.map(r => r.date.split('T')[0]));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ── ALERT RULES API ─────────────────────────────────────────
// ============================================================

app.get('/api/alert-rules', requireLogin, async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT * FROM alert_rules WHERE admin_id=$1 ORDER BY created_at DESC',
      [req.session.adminId]
    );
    res.json(rows.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alert-rules', requireLogin, async (req, res) => {
  const { name, category, condition, value, employee_id, employee_name, severity } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO alert_rules (admin_id, admin_name, name, category, condition, value, employee_id, employee_name, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.adminId, req.session.adminName, name, category, condition,
       value||null, employee_id||null, employee_name||null, severity||'medium']
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/alert-rules/:id', requireLogin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE alert_rules SET active=$1 WHERE id=$2 AND admin_id=$3',
      [req.body.active, req.params.id, req.session.adminId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alert-rules/:id', requireLogin, async (req, res) => {
  try {
    await pool.query('DELETE FROM alert_rules WHERE id=$1 AND admin_id=$2',
      [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ── SITE CATEGORIES API (per admin) ─────────────────────────
// ============================================================

app.get('/api/site-categories', requireLogin, async (req, res) => {
  try {
    const rows = await pool.query(
      'SELECT * FROM site_categories WHERE admin_id=$1 ORDER BY domain ASC',
      [req.session.adminId]
    );
    res.json(rows.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/site-categories', requireLogin, async (req, res) => {
  const { domain, category } = req.body;
  if (!domain || !category) return res.status(400).json({ error: 'domain and category required' });
  const clean = domain.toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].trim();
  try {
    const r = await pool.query(
      `INSERT INTO site_categories (admin_id, domain, category)
       VALUES ($1,$2,$3)
       ON CONFLICT (admin_id, domain)
       DO UPDATE SET category=$3 RETURNING *`,
      [req.session.adminId, clean, category]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/site-categories/:id', requireLogin, async (req, res) => {
  try {
    await pool.query('DELETE FROM site_categories WHERE id=$1 AND admin_id=$2',
      [req.params.id, req.session.adminId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ── ALERTS API (per admin) ───────────────────────────────────
// ============================================================

app.get('/api/alerts', requireLogin, async (req, res) => {
  try {
    const allowed = getAllowedEmployees(req);
    let q = `SELECT a.*, e.name as employee_name
             FROM alerts a JOIN employees e ON a.employee_id=e.id
             WHERE e.active=true AND (a.admin_id=$1 OR a.admin_id IS NULL)`;
    const params = [req.session.adminId];
    if (allowed) { q += ` AND e.id = ANY($2::int[])`; params.push(allowed); }
    q += ' ORDER BY a.created_at DESC LIMIT 200';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/alerts/:id/resolve', requireLogin, async (req, res) => {
  await pool.query('UPDATE alerts SET resolved=true WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/alerts/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM alerts WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ============================================================
// ── ALERT RULE EVALUATOR ─────────────────────────────────────
// ============================================================

async function triggerAlert(rule, employeeId, employeeName, message) {
  const existing = await pool.query(
    `SELECT id FROM alerts WHERE rule_id=$1 AND employee_id=$2
     AND created_at > NOW() - INTERVAL '1 hour' AND resolved=false LIMIT 1`,
    [rule.id, employeeId]
  );
  if (existing.rows.length) return;
  await pool.query(
    `INSERT INTO alerts (employee_id, message, severity, resolved, admin_id, rule_id, rule_name, created_at)
     VALUES ($1,$2,$3,false,$4,$5,$6,NOW())`,
    [employeeId, message, rule.severity||'medium', rule.admin_id, rule.id, rule.name]
  );
}

async function evaluateRule(rule) {
  const today = new Date().toISOString().split('T')[0];
  const empCond = rule.employee_id ? `AND e.id=${parseInt(rule.employee_id)}` : 'AND e.active=true';

  if (rule.category === 'web') {
    if (rule.condition === 'nonprod_over') {
      const mins = parseInt(rule.value)||30;
      const rows = await pool.query(`
        SELECT w.employee_id, e.name, ROUND(SUM(w.duration_seconds)/60) as m
        FROM web_activity w JOIN employees e ON w.employee_id=e.id
        WHERE w.visited_at::date=$1 AND w.productivity='Non-productive' ${empCond}
        GROUP BY w.employee_id,e.name HAVING SUM(w.duration_seconds)/60>$2
      `, [today, mins]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} spent ${r.m}m on non-productive sites today (limit: ${mins}m)`);
    }
    if (rule.condition === 'domain_visited') {
      const rows = await pool.query(`
        SELECT DISTINCT w.employee_id, e.name FROM web_activity w
        JOIN employees e ON w.employee_id=e.id
        WHERE w.visited_at::date=$1 AND LOWER(w.url) LIKE LOWER($2) ${empCond}
      `, [today, `%${rule.value||''}%`]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} visited "${rule.value}" today`);
    }
    if (rule.condition === 'web_over') {
      const mins = parseInt(rule.value)||60;
      const rows = await pool.query(`
        SELECT w.employee_id, e.name, ROUND(SUM(w.duration_seconds)/60) as m
        FROM web_activity w JOIN employees e ON w.employee_id=e.id
        WHERE w.visited_at::date=$1 ${empCond}
        GROUP BY w.employee_id,e.name HAVING SUM(w.duration_seconds)/60>$2
      `, [today, mins]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} spent ${r.m}m browsing today (limit: ${mins}m)`);
    }
  }

  if (rule.category === 'app') {
    if (rule.condition === 'app_over') {
      const parts = (rule.value||'|30').split('|');
      const appName = parts[0]||''; const mins = parseInt(parts[1])||30;
      const rows = await pool.query(`
        SELECT a.employee_id, e.name, ROUND(SUM(a.duration_seconds)/60) as m
        FROM app_usage a JOIN employees e ON a.employee_id=e.id
        WHERE a.recorded_at::date=$1 AND LOWER(a.app_name) LIKE LOWER($2) ${empCond}
        GROUP BY a.employee_id,e.name HAVING SUM(a.duration_seconds)/60>$3
      `, [today, `%${appName}%`, mins]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} used ${appName} for ${r.m}m today (limit: ${mins}m)`);
    }
    if (rule.condition === 'total_app_over') {
      const mins = parseInt(rule.value)||120;
      const rows = await pool.query(`
        SELECT a.employee_id, e.name, ROUND(SUM(a.duration_seconds)/60) as m
        FROM app_usage a JOIN employees e ON a.employee_id=e.id
        WHERE a.recorded_at::date=$1 ${empCond}
        GROUP BY a.employee_id,e.name HAVING SUM(a.duration_seconds)/60>$2
      `, [today, mins]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} total app usage ${r.m}m today (limit: ${mins}m)`);
    }
  }

  if (rule.category === 'login') {
    if (rule.condition === 'not_online_by') {
      const [rh,rm] = (rule.value||'09:00').split(':').map(Number);
      const now = new Date(); if (now.getHours()<rh||(now.getHours()===rh&&now.getMinutes()<rm)) return;
      const rows = await pool.query(`
        SELECT e.id, e.name FROM employees e WHERE e.active=true ${empCond}
        AND e.id NOT IN (SELECT DISTINCT employee_id FROM heartbeats WHERE recorded_at::date=CURRENT_DATE)
      `);
      for (const r of rows.rows) await triggerAlert(rule, r.id, r.name,
        `${r.name} has not logged in by ${rule.value} today`);
    }
    if (rule.condition === 'outside_shift') {
      const rows = await pool.query(`
        SELECT DISTINCT h.employee_id, e.name FROM heartbeats h
        JOIN employees e ON h.employee_id=e.id
        LEFT JOIN duty_rosters dr ON e.roster_id=dr.id
        WHERE h.recorded_at::date=CURRENT_DATE AND dr.id IS NOT NULL ${empCond}
        AND (h.recorded_at::time < dr.start_time OR h.recorded_at::time > dr.end_time)
      `);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name} was active outside shift hours today`);
    }
  }

  if (rule.category === 'idle' && rule.condition === 'idle_over') {
    const mins = parseInt(rule.value)||30;
    const rows = await pool.query(`
      SELECT h.employee_id, e.name, COUNT(*)*0.33 as idle_mins
      FROM heartbeats h JOIN employees e ON h.employee_id=e.id
      WHERE h.recorded_at > NOW()-INTERVAL '2 hours' AND h.idle=true ${empCond}
      GROUP BY h.employee_id,e.name HAVING COUNT(*)*0.33>$1
    `, [mins]);
    for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
      `${r.name} has been idle for over ${mins} minutes`);
  }

  if (rule.category === 'screenshot' && rule.condition === 'flagged') {
    const rows = await pool.query(`
      SELECT DISTINCT s.employee_id, e.name FROM screenshots s
      JOIN employees e ON s.employee_id=e.id
      WHERE s.flagged=true AND s.taken_at::date=CURRENT_DATE ${empCond}
    `);
    for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
      `${r.name} has flagged screenshots today`);
  }

  if (rule.category === 'system') {
    if (rule.condition === 'shutdown') {
      const rows = await pool.query(`
        SELECT DISTINCT s.employee_id, e.name FROM system_events s
        JOIN employees e ON s.employee_id=e.id
        WHERE s.event_type='shutdown' AND s.recorded_at::date=CURRENT_DATE ${empCond}
      `);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name}'s PC was shut down today`);
    }
    if (rule.condition === 'locked_over') {
      const count = Math.max(1, Math.floor(parseInt(rule.value||'60')/10));
      const rows = await pool.query(`
        SELECT s.employee_id, e.name, COUNT(*) as c FROM system_events s
        JOIN employees e ON s.employee_id=e.id
        WHERE s.event_type='locked' AND s.recorded_at::date=CURRENT_DATE ${empCond}
        GROUP BY s.employee_id,e.name HAVING COUNT(*)>$1
      `, [count]);
      for (const r of rows.rows) await triggerAlert(rule, r.employee_id, r.name,
        `${r.name}'s screen was locked ${r.c} times today`);
    }
  }
}

async function evaluateAlertRules() {
  try {
    const rules = await pool.query("SELECT * FROM alert_rules WHERE active=true");
    for (const rule of rules.rows) {
      try { await evaluateRule(rule); } catch(e) { console.error('[Rule]', rule.name, e.message); }
    }
  } catch(e) { console.error('[AlertEval]', e.message); }
}

setInterval(evaluateAlertRules, 5 * 60 * 1000);
setTimeout(evaluateAlertRules, 30000);

app.listen(PORT, () => {
  console.log(`WorkPulse server running on port ${PORT}`);
});
