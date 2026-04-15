/**
 * WorkPulse Installer Route
 * Mount this in server.js BEFORE other routes:
 *
 *   const installRouter = require('./install');
 *   app.use('/install', installRouter);
 *
 * After installation, comment out or remove the above two lines.
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const { Client } = require('pg');
const bcrypt   = require('bcryptjs');

// ── Serve the installer HTML ──────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// ── Test DB connection ────────────────────────────────────────────────────────
router.post('/test-db', async (req, res) => {
  const { host, port, name, user, pass } = req.body;
  const client = new Client({
    host: host || 'localhost',
    port: parseInt(port) || 5432,
    database: name,
    user: user,
    password: pass,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const ver = await client.query('SELECT version()');
    await client.end();
    const versionStr = ver.rows[0].version.split(' ').slice(0,2).join(' ');
    res.json({ ok: true, version: versionStr });
  } catch (err) {
    try { await client.end(); } catch(e) {}
    res.json({ ok: false, error: err.message });
  }
});

// ── Run full installation (streams progress) ──────────────────────────────────
router.post('/run', async (req, res) => {
  const { db, admin } = req.body;

  // Set up streaming response
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (msg, type, pct, label, extra) => {
    res.write(JSON.stringify({ msg, type: type||'info', pct: pct||0, label: label||'', ...extra }) + '\n');
  };

  const client = new Client({
    host: db.host || 'localhost',
    port: parseInt(db.port) || 5432,
    database: db.name,
    user: db.user,
    password: db.pass,
  });

  try {
    // ── 1. Connect ────────────────────────────────────────────────────────────
    send('Connecting to PostgreSQL…', 'info', 8, 'Connecting…');
    await client.connect();
    send('✓ Database connected', 'ok', 12, 'Connected');
    await sleep(200);

    // ── 2. Tables ────────────────────────────────────────────────────────────
    const tables = [
      {
        name: 'departments',
        sql: `CREATE TABLE IF NOT EXISTS departments (
          id   SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'duty_rosters',
        sql: `CREATE TABLE IF NOT EXISTS duty_rosters (
          id          SERIAL PRIMARY KEY,
          name        VARCHAR(100) NOT NULL,
          start_time  TIME NOT NULL,
          end_time    TIME NOT NULL,
          description VARCHAR(200),
          color       VARCHAR(10) DEFAULT '#00e5ff',
          active      BOOLEAN DEFAULT true,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'employees',
        sql: `CREATE TABLE IF NOT EXISTS employees (
          id                   SERIAL PRIMARY KEY,
          name                 VARCHAR(200) NOT NULL,
          email                VARCHAR(200) UNIQUE NOT NULL,
          department           VARCHAR(100),
          agent_token          VARCHAR(100) UNIQUE NOT NULL,
          active               BOOLEAN DEFAULT true,
          screenshot_interval  INTEGER DEFAULT 5,
          data_retention_days  INTEGER DEFAULT 0,
          roster_id            INTEGER REFERENCES duty_rosters(id) ON DELETE SET NULL,
          deleted_at           TIMESTAMPTZ,
          created_at           TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'heartbeats',
        sql: `CREATE TABLE IF NOT EXISTS heartbeats (
          id          SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          active_app  VARCHAR(500),
          idle        BOOLEAN DEFAULT false,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'screenshots',
        sql: `CREATE TABLE IF NOT EXISTS screenshots (
          id          SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          filename    VARCHAR(500) NOT NULL,
          flagged     BOOLEAN DEFAULT false,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'web_activity',
        sql: `CREATE TABLE IF NOT EXISTS web_activity (
          id               SERIAL PRIMARY KEY,
          employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          url              VARCHAR(2000),
          full_url         VARCHAR(2000),
          duration_seconds INTEGER DEFAULT 0,
          idle_seconds     INTEGER DEFAULT 0,
          browser          VARCHAR(100),
          recorded_at      TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'app_usage',
        sql: `CREATE TABLE IF NOT EXISTS app_usage (
          id               SERIAL PRIMARY KEY,
          employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          app_name         VARCHAR(500),
          duration_seconds INTEGER DEFAULT 0,
          recorded_at      TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'system_events',
        sql: `CREATE TABLE IF NOT EXISTS system_events (
          id          SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          event_type  VARCHAR(50) NOT NULL,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'admins',
        sql: `CREATE TABLE IF NOT EXISTS admins (
          id            SERIAL PRIMARY KEY,
          name          VARCHAR(200) NOT NULL,
          email         VARCHAR(200) UNIQUE NOT NULL,
          password_hash VARCHAR(300) NOT NULL,
          role          VARCHAR(20) DEFAULT 'admin',
          created_at    TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'dashboard_users',
        sql: `CREATE TABLE IF NOT EXISTS dashboard_users (
          id            SERIAL PRIMARY KEY,
          name          VARCHAR(200) NOT NULL,
          email         VARCHAR(200) UNIQUE NOT NULL,
          password_hash VARCHAR(300) NOT NULL,
          role          VARCHAR(20) DEFAULT 'user',
          active        BOOLEAN DEFAULT true,
          created_by    INTEGER,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'user_employee_access',
        sql: `CREATE TABLE IF NOT EXISTS user_employee_access (
          user_id     INTEGER NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, employee_id)
        )`,
      },
      {
        name: 'alerts',
        sql: `CREATE TABLE IF NOT EXISTS alerts (
          id          SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          message     TEXT,
          severity    VARCHAR(20) DEFAULT 'medium',
          resolved    BOOLEAN DEFAULT false,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
      {
        name: 'audit_log',
        sql: `CREATE TABLE IF NOT EXISTS audit_log (
          id         SERIAL PRIMARY KEY,
          admin_id   INTEGER,
          admin_name VARCHAR(200),
          action     VARCHAR(200),
          details    TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
      },
    ];

    const totalTables = tables.length;
    send(`Creating ${totalTables} database tables…`, 'info', 15, 'Creating tables…');
    await sleep(200);

    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      send(`Creating table: ${t.name}`, 'dim', Math.round(15 + (i / totalTables) * 45), `Table ${i+1}/${totalTables}…`);
      await client.query(t.sql);
      send(`  ✓ ${t.name}`, 'ok');
      await sleep(80);
    }

    // ── 3. Indexes ────────────────────────────────────────────────────────────
    send('Creating indexes for performance…', 'info', 62, 'Creating indexes…');
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_heartbeats_emp_time    ON heartbeats      (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_screenshots_emp_time   ON screenshots     (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_web_activity_emp_time  ON web_activity    (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_app_usage_emp_time     ON app_usage       (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_system_events_emp_time ON system_events   (employee_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_emp             ON alerts          (employee_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_time         ON audit_log       (created_at DESC)`,
    ];
    for (const idx of indexes) {
      await client.query(idx);
    }
    send('✓ All indexes created', 'ok', 70, 'Indexes done');
    await sleep(150);

    // ── 4. Seed default rosters ───────────────────────────────────────────────
    send('Seeding default shift rosters…', 'info', 73, 'Seeding rosters…');
    const existing = await client.query('SELECT COUNT(*) FROM duty_rosters');
    if (parseInt(existing.rows[0].count) === 0) {
      const rosters = [
        ['General Shift (9AM–6PM)',  '09:00', '18:00', 'Standard office hours',   '#00e5ff'],
        ['Shift A (9:30AM–6:30PM)', '09:30', '18:30', 'Slightly later start',    '#10b981'],
        ['Shift B (10AM–7PM)',       '10:00', '19:00', 'Late morning shift',       '#7c3aed'],
        ['Shift C (12:30PM–9:30PM)','12:30', '21:30', 'Afternoon shift',          '#f59e0b'],
        ['Evening (6PM–3AM)',        '18:00', '03:00', 'Evening/night shift',      '#ef4444'],
        ['Night (7PM–4AM)',          '19:00', '04:00', 'Late night shift',         '#f472b6'],
      ];
      for (const [name, start, end, desc, color] of rosters) {
        await client.query(
          'INSERT INTO duty_rosters (name,start_time,end_time,description,color) VALUES ($1,$2,$3,$4,$5)',
          [name, start, end, desc, color]
        );
        send(`  ✓ Roster: ${name}`, 'dim');
      }
      send('✓ Default rosters seeded', 'ok', 80, 'Rosters done');
    } else {
      send('  (rosters already exist, skipped)', 'dim', 80, 'Rosters skipped');
    }
    await sleep(150);

    // ── 5. Create root admin ──────────────────────────────────────────────────
    send('Creating root admin account…', 'info', 83, 'Creating admin…');
    const existing_admin = await client.query('SELECT id FROM admins WHERE email=$1', [admin.email]);
    if (existing_admin.rows.length > 0) {
      send(`  Admin ${admin.email} already exists — skipping`, 'warn', 88);
    } else {
      const hash = await bcrypt.hash(admin.pass, 12);
      await client.query(
        'INSERT INTO admins (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [admin.name, admin.email, hash, 'admin']
      );
      send(`✓ Admin created: ${admin.email}`, 'ok', 90, 'Admin created');
    }
    await sleep(200);

    // ── 6. Write .env if missing ──────────────────────────────────────────────
    send('Checking .env configuration…', 'info', 92, 'Config check…');
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
      const secret = require('crypto').randomBytes(48).toString('hex');
      const envContent = [
        `DB_HOST=${db.host || 'localhost'}`,
        `DB_PORT=${db.port || 5432}`,
        `DB_NAME=${db.name}`,
        `DB_USER=${db.user}`,
        `DB_PASSWORD=${db.pass}`,
        `SESSION_SECRET=${secret}`,
        `NODE_ENV=production`,
        `PORT=3000`,
      ].join('\n') + '\n';
      fs.writeFileSync(envPath, envContent);
      send('✓ .env file created with secure session secret', 'ok', 95, 'Config saved');
    } else {
      send('  .env already exists — not overwritten', 'dim', 95);
    }
    await sleep(200);

    // ── 7. Create screenshots dir ─────────────────────────────────────────────
    const ssDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(ssDir)) {
      fs.mkdirSync(ssDir, { recursive: true });
      send('✓ Screenshots directory created', 'ok', 97);
    } else {
      send('  Screenshots directory already exists', 'dim', 97);
    }

    await client.end();

    send('', 'dim', 100, 'Complete!');
    send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');
    send('🎉 WorkPulse installation complete!', 'ok', 100, 'Done!');
    send(`   Admin: ${admin.email}`, 'dim');
    send('   Please restart the server (pm2 restart workpulse)', 'warn');
    send('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');

    res.write(JSON.stringify({
      msg: 'Installation finished.',
      type: 'ok',
      pct: 100,
      label: 'Done!',
      done: true,
      admin: { email: admin.email, pass: admin.pass }
    }) + '\n');
    res.end();

  } catch (err) {
    try { await client.end(); } catch(e) {}
    send('✗ ERROR: ' + err.message, 'err', 0, 'Failed');
    res.write(JSON.stringify({ error: err.message }) + '\n');
    res.end();
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = router;
