/**
 * WorkPulse Installer Route
 * Add to server.js BEFORE other routes:
 *
 *   const installRouter = require('./install');
 *   app.use('/install', installRouter);
 *
 * Remove after first setup is complete.
 */

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const fs           = require('fs');
const { Client }   = require('pg');
const bcrypt       = require('bcryptjs');
const { execFile } = require('child_process');

// Ensure backups/tmp exists before multer uses it
const tmpDir = path.join(__dirname, 'backups', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const multer = require('multer');
const upload = multer({ dest: tmpDir });

// ── Serve installer HTML ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// ── Test DB connection ────────────────────────────────────────────────────────
router.post('/test-db', async (req, res) => {
  const { host, port, name, user, pass } = req.body;
  if (!pass || typeof pass !== 'string') {
    return res.json({ ok: false, error: 'Password is required' });
  }
  const client = new Client({
    host: host || 'localhost',
    port: parseInt(port) || 5432,
    database: name,
    user,
    password: String(pass),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const ver = await client.query('SELECT version()');
    await client.end();
    res.json({ ok: true, version: ver.rows[0].version.split(' ').slice(0, 2).join(' ') });
  } catch (err) {
    try { await client.end(); } catch(e) {}
    res.json({ ok: false, error: err.message });
  }
});

// ── Write .env helper (used by both fresh install and restore) ────────────────
function writeEnv(db, existingSecret) {
  const envPath = path.join(__dirname, '.env');
  const secret  = existingSecret || require('crypto').randomBytes(48).toString('hex');
  // Detect current user home for agent paths
  const homeDir = process.env.HOME || '/home/workpulse';
  const lines = [
    `PORT=3000`,
    `SESSION_SECRET=${secret}`,
    `DB_HOST=${db.host || 'localhost'}`,
    `DB_PORT=${db.port || 5432}`,
    `DB_NAME=${db.name}`,
    `DB_USER=${db.user}`,
    `DB_PASSWORD=${String(db.pass)}`,
    `DB_PASS=${String(db.pass)}`,   // db.js compatibility
    `NODE_ENV=development`,          // use development so HTTP cookies work; change to production after HTTPS setup
    `HOME_DIR=${homeDir}`,
  ];
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  return secret;
}

// ── Fresh install ─────────────────────────────────────────────────────────────
router.post('/run', async (req, res) => {
  const { db, admin } = req.body;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (msg, type, pct, label, extra = {}) =>
    res.write(JSON.stringify({ msg, type: type||'info', pct: pct||0, label: label||'', ...extra }) + '\n');

  // Validate password
  if (!db.pass || typeof db.pass !== 'string') {
    send('✗ Database password is required', 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: 'DB password missing' }) + '\n');
    res.end(); return;
  }

  const client = new Client({
    host: db.host || 'localhost',
    port: parseInt(db.port) || 5432,
    database: db.name,
    user: db.user,
    password: String(db.pass),
  });

  try {
    send('Connecting to PostgreSQL…', 'info', 8, 'Connecting…');
    await client.connect();
    send('✓ Database connected', 'ok', 12, 'Connected');
    await sleep(150);

    // Tables
    const tables = [
      { name: 'departments',          sql: `CREATE TABLE IF NOT EXISTS departments (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'duty_rosters',         sql: `CREATE TABLE IF NOT EXISTS duty_rosters (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL, description VARCHAR(200), color VARCHAR(10) DEFAULT '#00e5ff', active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'employees',            sql: `CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, email VARCHAR(200) UNIQUE NOT NULL, department VARCHAR(100), agent_token VARCHAR(100) UNIQUE NOT NULL, active BOOLEAN DEFAULT true, screenshot_interval INTEGER DEFAULT 5, data_retention_days INTEGER DEFAULT 0, roster_id INTEGER REFERENCES duty_rosters(id) ON DELETE SET NULL, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'heartbeats',           sql: `CREATE TABLE IF NOT EXISTS heartbeats (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, active_app VARCHAR(500), idle BOOLEAN DEFAULT false, recorded_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'screenshots',          sql: `CREATE TABLE IF NOT EXISTS screenshots (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, filename VARCHAR(500) NOT NULL, flagged BOOLEAN DEFAULT false, recorded_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'web_activity',         sql: `CREATE TABLE IF NOT EXISTS web_activity (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, url VARCHAR(2000), full_url VARCHAR(2000), duration_seconds INTEGER DEFAULT 0, idle_seconds INTEGER DEFAULT 0, browser VARCHAR(100), recorded_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'app_usage',            sql: `CREATE TABLE IF NOT EXISTS app_usage (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, app_name VARCHAR(500), duration_seconds INTEGER DEFAULT 0, recorded_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'system_events',        sql: `CREATE TABLE IF NOT EXISTS system_events (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, event_type VARCHAR(50) NOT NULL, recorded_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'admins',               sql: `CREATE TABLE IF NOT EXISTS admins (id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, email VARCHAR(200) UNIQUE NOT NULL, password_hash VARCHAR(300) NOT NULL, role VARCHAR(20) DEFAULT 'admin', created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'dashboard_users',      sql: `CREATE TABLE IF NOT EXISTS dashboard_users (id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, email VARCHAR(200) UNIQUE NOT NULL, password_hash VARCHAR(300) NOT NULL, role VARCHAR(20) DEFAULT 'user', active BOOLEAN DEFAULT true, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'user_employee_access', sql: `CREATE TABLE IF NOT EXISTS user_employee_access (user_id INTEGER NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, PRIMARY KEY (user_id, employee_id))` },
      { name: 'alerts',               sql: `CREATE TABLE IF NOT EXISTS alerts (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, message TEXT, severity VARCHAR(20) DEFAULT 'medium', resolved BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'audit_log',            sql: `CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, admin_id INTEGER, admin_name VARCHAR(200), action VARCHAR(200), details TEXT, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'email_config',         sql: `CREATE TABLE IF NOT EXISTS email_config (id SERIAL PRIMARY KEY, smtp_host VARCHAR(200), smtp_port INTEGER DEFAULT 587, smtp_user VARCHAR(200), smtp_pass VARCHAR(500), smtp_from_name VARCHAR(100) DEFAULT 'WorkPulse', smtp_tls BOOLEAN DEFAULT true, mfa_enabled BOOLEAN DEFAULT false, updated_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'otp_tokens',           sql: `CREATE TABLE IF NOT EXISTS otp_tokens (id SERIAL PRIMARY KEY, email VARCHAR(200) NOT NULL, otp VARCHAR(10) NOT NULL, purpose VARCHAR(20) DEFAULT 'mfa', expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'settings',             sql: `CREATE TABLE IF NOT EXISTS settings (id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'temp_shift_overrides', sql: `CREATE TABLE IF NOT EXISTS temp_shift_overrides (id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, override_date DATE NOT NULL, roster_id INTEGER REFERENCES duty_rosters(id) ON DELETE SET NULL, is_day_off BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(employee_id, override_date))` },
      { name: 'report_jobs',          sql: `CREATE TABLE IF NOT EXISTS report_jobs (id SERIAL PRIMARY KEY, admin_id INTEGER, report_type VARCHAR(50), parameters JSONB, status VARCHAR(20) DEFAULT 'pending', result_path VARCHAR(500), created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ)` },
      { name: 'report_schedules',     sql: `CREATE TABLE IF NOT EXISTS report_schedules (id SERIAL PRIMARY KEY, admin_id INTEGER, report_type VARCHAR(50), frequency VARCHAR(20), recipients TEXT, parameters JSONB, enabled BOOLEAN DEFAULT true, last_run TIMESTAMPTZ, next_run TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'alert_rules',          sql: `CREATE TABLE IF NOT EXISTS alert_rules (id SERIAL PRIMARY KEY, admin_id INTEGER, rule_type VARCHAR(50) NOT NULL, threshold INTEGER, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, enabled BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())` },
      { name: 'site_categories',      sql: `CREATE TABLE IF NOT EXISTS site_categories (id SERIAL PRIMARY KEY, admin_id INTEGER, domain VARCHAR(255) NOT NULL, category VARCHAR(50) NOT NULL DEFAULT 'Neutral', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(admin_id, domain))` },
    ];

    send(`Creating ${tables.length} tables…`, 'info', 15, 'Creating tables…');
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      send(`  ${t.name}`, 'dim', Math.round(15 + (i / tables.length) * 42), `Table ${i+1}/${tables.length}…`);
      await client.query(t.sql);
      send(`  ✓ ${t.name}`, 'ok');
      await sleep(50);
    }

    // Indexes
    send('Creating indexes…', 'info', 59, 'Indexes…');
    for (const idx of [
      `CREATE INDEX IF NOT EXISTS idx_heartbeats_emp_time    ON heartbeats   (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_screenshots_emp_time   ON screenshots  (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_web_activity_emp_time  ON web_activity (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_app_usage_emp_time     ON app_usage    (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_system_events_emp_time ON system_events(employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_emp             ON alerts       (employee_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_time         ON audit_log    (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_report_jobs_admin      ON report_jobs  (admin_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_report_sched_admin     ON report_schedules (admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alert_rules_admin      ON alert_rules  (admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_cats_admin        ON site_categories (admin_id)`,
      `CREATE INDEX IF NOT EXISTS idx_temp_overrides_emp     ON temp_shift_overrides (employee_id, override_date)`,
    ]) await client.query(idx);
    send('✓ Indexes created', 'ok', 66, 'Indexes done');

    // Seed default rosters
    send('Seeding default rosters…', 'info', 69, 'Rosters…');
    const rc = await client.query('SELECT COUNT(*) FROM duty_rosters');
    if (parseInt(rc.rows[0].count) === 0) {
      for (const [n, s, e, d, c] of [
        ['General Shift (9AM–6PM)',   '09:00','18:00','Standard office hours', '#00e5ff'],
        ['Shift A (9:30AM–6:30PM)',   '09:30','18:30','Slightly later start',  '#10b981'],
        ['Shift B (10AM–7PM)',        '10:00','19:00','Late morning shift',     '#7c3aed'],
        ['Shift C (12:30PM–9:30PM)', '12:30','21:30','Afternoon shift',        '#f59e0b'],
        ['Evening (6PM–3AM)',         '18:00','03:00','Evening/night shift',    '#ef4444'],
        ['Night (7PM–4AM)',           '19:00','04:00','Late night shift',       '#f472b6'],
      ]) {
        await client.query('INSERT INTO duty_rosters (name,start_time,end_time,description,color) VALUES ($1,$2,$3,$4,$5)', [n, s, e, d, c]);
        send(`  ✓ ${n}`, 'dim');
      }
      send('✓ Default rosters seeded', 'ok', 78, 'Rosters done');
    } else {
      send('  Rosters already exist — skipped', 'dim', 78);
    }

    // Create admin
    send('Creating admin account…', 'info', 81, 'Admin…');
    const ea = await client.query('SELECT id FROM admins WHERE email=$1', [admin.email]);
    if (ea.rows.length > 0) {
      send(`  ${admin.email} already exists — skipped`, 'warn', 86);
    } else {
      const hash = await bcrypt.hash(admin.pass, 12);
      await client.query('INSERT INTO admins (name,email,password_hash,role) VALUES ($1,$2,$3,$4)',
        [admin.name, admin.email, hash, 'admin']);
      send(`✓ Admin created: ${admin.email}`, 'ok', 88, 'Admin created');
    }

    await client.end();

    // Write .env — always overwrite to ensure correct values
    send('Writing configuration…', 'info', 91, 'Config…');
    writeEnv(db);
    send('✓ .env written (DB_PASSWORD + DB_PASS both set)', 'ok', 94, 'Config saved');
    send('  NODE_ENV=development set — change to production after HTTPS setup', 'warn');

    // Create directories
    for (const dir of ['screenshots', 'backups']) {
      const p = path.join(__dirname, dir);
      if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); send(`✓ ${dir}/ created`, 'ok', 96); }
      else { send(`  ${dir}/ already exists`, 'dim', 96); }
    }

    send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim', 100, 'Done!');
    send('🎉 Installation complete!', 'ok', 100, 'Done!');
    send('   Next: pm2 restart workpulse --update-env', 'warn');
    send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');
    res.write(JSON.stringify({ done: true, pct: 100, label: 'Done!', msg: 'Done.', admin: { email: admin.email, pass: admin.pass } }) + '\n');
    res.end();

  } catch (err) {
    try { await client.end(); } catch(e) {}
    send('✗ ' + err.message, 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});

// ── Restore from backup ───────────────────────────────────────────────────────
router.post('/restore', upload.single('backup'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (msg, type, pct, label, extra = {}) =>
    res.write(JSON.stringify({ msg, type: type||'info', pct: pct||0, label: label||'', ...extra }) + '\n');

  if (!req.file) {
    send('No backup file received.', 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: 'No file uploaded.' }) + '\n');
    res.end(); return;
  }

  let db;
  try { db = JSON.parse(req.body.db); } catch(e) {
    send('Invalid DB config.', 'err');
    res.write(JSON.stringify({ error: 'Invalid DB config.' }) + '\n');
    res.end(); return;
  }

  if (!db.pass || typeof db.pass !== 'string') {
    send('✗ Database password is required', 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: 'DB password missing' }) + '\n');
    res.end(); return;
  }

  const tmpFile = req.file.path;

  const client = new Client({
    host: db.host || 'localhost',
    port: parseInt(db.port) || 5432,
    database: db.name,
    user: db.user,
    password: String(db.pass),
  });

  try {
    send(`File received: ${req.file.originalname}`, 'ok', 10, 'File ready');

    // Save a copy to backups dir
    const backupsDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const savedName = `restore-import-${ts}.wpbackup`;
    fs.copyFileSync(tmpFile, path.join(backupsDir, savedName));
    send(`  Saved copy: ${savedName}`, 'dim', 15);

    // Connect and drop all tables
    send('Connecting to database…', 'info', 18, 'Connecting…');
    await client.connect();
    send('✓ Connected', 'ok', 22);
    send('Dropping existing tables…', 'warn', 25, 'Clearing…');
    await client.query(`
      DO $$ DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    send('✓ Tables cleared', 'ok', 35, 'Cleared');
    await client.end();
    await sleep(200);

    // Run psql restore
    send('Restoring database from backup…', 'info', 40, 'Restoring…');
    const env = Object.assign({}, process.env, { PGPASSWORD: String(db.pass) });
    execFile('psql', [
      '-h', db.host || 'localhost',
      '-p', String(db.port || 5432),
      '-U', db.user,
      '-d', db.name,
      '--no-password',
      '-f', tmpFile,
    ], { env }, async (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch(e) {}

      if (err) {
        send('✗ Restore failed: ' + err.message, 'err', 0, 'Failed');
        res.write(JSON.stringify({ error: err.message }) + '\n');
        res.end(); return;
      }

      if (stderr && stderr.trim()) {
        const first = stderr.trim().split('\n')[0];
        send('  ' + first, first.toLowerCase().includes('error') ? 'warn' : 'dim', 85);
      }

      send('✓ Database restored!', 'ok', 90, 'Restored!');

      // Write .env — always write on restore to ensure correct DB credentials
      writeEnv(db);
      send('✓ .env written (DB_PASSWORD + DB_PASS both set)', 'ok', 94);
      send('  NODE_ENV=development set — change to production after HTTPS setup', 'warn');

      for (const dir of ['screenshots', 'backups']) {
        const p = path.join(__dirname, dir);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      }
      send('✓ Directories verified', 'ok', 97);

      send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim', 100, 'Done!');
      send('🎉 Restore complete! Log in with your existing credentials.', 'ok', 100, 'Done!');
      send('   Next: pm2 restart workpulse --update-env', 'warn');
      send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');
      res.write(JSON.stringify({ done: true, pct: 100, label: 'Done!', msg: 'Restore done.', isRestore: true }) + '\n');
      res.end();
    });

  } catch (err) {
    try { await client.end(); } catch(e) {}
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    send('✗ ' + err.message, 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = router;
