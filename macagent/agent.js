const axios = require('axios');
const schedule = require('node-schedule');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const AGENT_VERSION = '1.0.0-mac';
const CONFIG_DIR  = path.join(os.homedir(), 'Library', 'Application Support', 'WorkPulse');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOG_FILE    = path.join(CONFIG_DIR, 'agent.log');
const QUEUE_FILE  = path.join(CONFIG_DIR, 'offline_queue.json');
const PENDING_SS  = path.join(CONFIG_DIR, 'pending_screenshots');
const MAX_LOG_SIZE = 1 * 1024 * 1024;

let SERVER_URL  = '';
let AGENT_TOKEN = '';
let currentApp  = '';
let appStartTime = Date.now();
let lastIdleState = false;
let lastLockState = false;

// ── Logger ────────────────────────────────────────────────────────────────────
function log(msg) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      fs.writeFileSync(LOG_FILE, line + '\n');
    } else {
      fs.appendFileSync(LOG_FILE, line + '\n');
    }
  } catch(e) {}
  process.stdout.write(line + '\n');
}

// ── Offline queue ─────────────────────────────────────────────────────────────
let offlineQueue = [];
let isRetrying   = false;
let hbCounter    = 0;

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(offlineQueue)); } catch(e) {}
}

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      offlineQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || [];
      if (offlineQueue.length > 20) offlineQueue = offlineQueue.slice(-20);
      log('[Queue] Loaded ' + offlineQueue.length + ' offline items');
    }
  } catch(e) { offlineQueue = []; }
}

async function retryQueue() {
  if (isRetrying || !offlineQueue.length) return;
  isRetrying = true;
  try {
    const remaining = [];
    for (let i = 0; i < offlineQueue.length; i++) {
      const item = offlineQueue[i];
      try {
        await axios.post(SERVER_URL + item.path, item.body, {
          headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, item.headers||{}),
          timeout: 0
        });
        log('[Queue] ' + (i+1) + '/' + offlineQueue.length + ' Sent OK');
      } catch(e) {
        remaining.push(item);
      }
    }
    offlineQueue = remaining;
    saveQueue();
    retryPendingScreenshots();
  } finally { isRetrying = false; }
}

async function retryPendingScreenshots() {
  if (!fs.existsSync(PENDING_SS)) return;
  const files = fs.readdirSync(PENDING_SS).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
  if (!files.length) return;
  log('[SS] Retrying ' + files.length + ' pending screenshots...');
  for (const file of files) {
    const filePath = path.join(PENDING_SS, file);
    try {
      const form = new FormData();
      form.append('screenshot', fs.createReadStream(filePath));
      await axios.post(SERVER_URL + '/api/agent/screenshot', form, {
        headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, form.getHeaders()),
        timeout: 0
      });
      fs.unlinkSync(filePath);
      log('[SS] Retry sent: ' + file);
    } catch(e) { break; }
  }
}

async function safePost(path, body, headers) {
  try {
    await axios.post(SERVER_URL + path, body, {
      headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, headers||{}),
      timeout: 0
    });
    if (offlineQueue.length > 0 && !isRetrying) retryQueue();
  } catch(e) {
    offlineQueue.push({ path, body, headers: headers||{} });
    saveQueue();
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    AGENT_TOKEN = config.token;
    if (config.server_url) SERVER_URL = config.server_url;
    log('WorkPulse Mac Agent v' + AGENT_VERSION);
    log('Agent started for: ' + config.email);
    log('Server: ' + SERVER_URL);
    return true;
  } catch(e) {
    log('Config not found at ' + CONFIG_FILE);
    return false;
  }
}

// ── macOS helpers ─────────────────────────────────────────────────────────────

// Run AppleScript and return stdout
function runAS(script) {
  try {
    return execSync('osascript -e ' + JSON.stringify(script), { timeout: 5000 }).toString().trim();
  } catch(e) { return ''; }
}

// Run shell command
function runSH(cmd) {
  try {
    return execSync(cmd, { timeout: 5000 }).toString().trim();
  } catch(e) { return ''; }
}

// ── Active window (app name) ──────────────────────────────────────────────────
let cachedActiveWindow = 'Desktop';
let lastPolledWindow   = 'Desktop';

setInterval(function() {
  try {
    const result = runAS('tell application "System Events" to get name of first application process whose frontmost is true');
    if (result && result !== '') {
      if (result === lastPolledWindow) cachedActiveWindow = result;
      lastPolledWindow = result;
    }
  } catch(e) {}
}, 3000);

function getActiveWindow() {
  return cachedActiveWindow;
}

// ── Idle seconds ──────────────────────────────────────────────────────────────
function getIdleSeconds() {
  try {
    // ioreg returns idle time in nanoseconds
    const out = runSH("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'");
    return Math.floor(parseFloat(out) || 0);
  } catch(e) { return 0; }
}

// ── Lock state ────────────────────────────────────────────────────────────────
function isScreenLocked() {
  try {
    // Check if screensaver or loginwindow is running
    const out = runSH("python3 -c \"import subprocess,sys; r=subprocess.run(['python3','-c','import objc; from Cocoa import NSWorkspace; print(NSWorkspace.sharedWorkspace().isApplicationHidden_(None))'],capture_output=True); sys.exit(0)\"");
    // Simpler approach: check if loginwindow owns the screen
    const locked = runSH("bash -c 'ioreg -n Root -d1 | grep CGSSessionScreenIsLocked | grep -c true'");
    return locked === '1';
  } catch(e) { return false; }
}

// ── Browser activity ──────────────────────────────────────────────────────────
const BROWSER_APPS = {
  'Google Chrome': 'Chrome',
  'Safari': 'Safari',
  'Firefox': 'Firefox',
  'Microsoft Edge': 'Edge',
  'Arc': 'Arc',
  'Brave Browser': 'Brave',
  'Opera': 'Opera',
};

let urlBuffer = {};  // url -> { url, seconds, browser }
let urlLastSeen = {};

function isAppRunning(appName) {
  try {
    const result = runSH(`pgrep -x "${appName}" 2>/dev/null`);
    return result.trim() !== '';
  } catch(e) { return false; }
}

function getBrowserActivity() {
  for (const [appName, browserName] of Object.entries(BROWSER_APPS)) {
    // Only query if browser is actually running
    if (!isAppRunning(appName)) continue;
    try {
      let url = '';
      if (appName === 'Safari') {
        url = runAS(`tell application "Safari" to if (count of windows) > 0 then get URL of current tab of front window`);
      } else {
        url = runAS(`tell application "${appName}" to if (count of windows) > 0 then get URL of active tab of front window`);
      }
      if (url && url.startsWith('http')) {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        if (!urlBuffer[domain]) urlBuffer[domain] = { url: domain, seconds: 0, browser: browserName, full_url: url, idle_seconds: 0 };
        urlBuffer[domain].seconds += 20;
        urlLastSeen[domain] = Date.now();
      }
    } catch(e) {}
  }

  // Return and reset buffer
  const result = Object.values(urlBuffer);
  urlBuffer = {};
  return result;
}

// ── App usage ─────────────────────────────────────────────────────────────────
let appBuffer = {}; // appName -> seconds

function getAllApps(activeApp) {
  if (activeApp && activeApp !== 'Desktop') {
    appBuffer[activeApp] = (appBuffer[activeApp] || 0) + 20;
  }
  const result = Object.entries(appBuffer).map(([name, seconds]) => ({ name, seconds }));
  appBuffer = {};
  return result;
}

// ── System events (login/logout/sleep/wake) ───────────────────────────────────
let lastEventCheck = new Date(Date.now() - 60 * 60 * 1000);

async function checkMacEvents() {
  try {
    const since = lastEventCheck.toISOString().replace('T', ' ').slice(0, 19);
    lastEventCheck = new Date();

    // Check system log for sleep/wake events
    const logOut = runSH(`log show --predicate 'eventMessage contains "Sleep" OR eventMessage contains "Wake" OR eventMessage contains "shutdown"' --start "${since}" --style syslog 2>/dev/null | tail -20`);

    const lines = logOut.split('\n').filter(Boolean);
    for (const line of lines) {
      let eventType = null;
      if (line.includes('Sleep')) eventType = 'sleep';
      else if (line.includes('Wake')) eventType = 'wakeup';
      else if (line.includes('shutdown')) eventType = 'shutdown';
      if (eventType) {
        await safePost('/api/agent/system-event', { event_type: eventType });
        log('[Event] ' + eventType);
      }
    }
  } catch(e) {}
}

// ── Screenshot ────────────────────────────────────────────────────────────────
function takeScreenshot(callback) {
  const tmpFile = path.join(os.tmpdir(), 'wp_screenshot_' + Date.now() + '.jpg');
  // screencapture requires Screen Recording permission
  exec('screencapture -x -t jpg -m ' + JSON.stringify(tmpFile), { timeout: 10000 }, function(err) {
    if (err) return callback(err);
    if (fs.existsSync(tmpFile)) callback(null, tmpFile);
    else callback(new Error('Screenshot not created'));
  });
}

// ── Capture schedule ──────────────────────────────────────────────────────────
let screenshotInterval = 5;
let captureSchedule = { enabled: false, window: null };
let captureLoggedDate = '';

function isWithinCaptureWindow() {
  if (!captureSchedule.enabled || !captureSchedule.window) return true;
  const win = captureSchedule.window;
  if (!win.start || !win.end) return true;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = win.start.slice(0,5).split(':').map(Number);
  const [eh, em] = win.end.slice(0,5).split(':').map(Number);
  return nowMins >= (sh*60+sm) && nowMins < (eh*60+em);
}

function logCaptureWindowOnce() {
  if (!captureSchedule.enabled || !captureSchedule.window) return;
  const today = new Date().toISOString().slice(0,10);
  if (captureLoggedDate === today) return;
  captureLoggedDate = today;
  const win = captureSchedule.window;
  log('[CaptureSchedule] Window: ' + (win.start||'').slice(0,5) + ' to ' + (win.end||'').slice(0,5));
}

async function fetchSettings() {
  try {
    const res = await axios.get(SERVER_URL + '/api/agent/settings', {
      headers: { 'x-agent-token': AGENT_TOKEN }, timeout: 5000
    });
    screenshotInterval = res.data.screenshot_interval || 5;
    if (res.data.captureSchedule) {
      captureSchedule = res.data.captureSchedule;
      logCaptureWindowOnce();
    }
    log('[Settings] Screenshot interval: ' + screenshotInterval + ' mins');
  } catch(e) {}
}

// ── Screenshot scheduler ──────────────────────────────────────────────────────
function scheduleScreenshot() {
  setTimeout(async function() {
    if (!AGENT_TOKEN) { scheduleScreenshot(); return; }
    if (lastLockState) {
      log('[SS] Skipped - screen locked');
      await fetchSettings();
      scheduleScreenshot();
      return;
    }
    if (!isWithinCaptureWindow()) {
      const win = captureSchedule.window;
      log('[SS] Skipped - outside window (' + (win&&win.start||'').slice(0,5) + '-' + (win&&win.end||'').slice(0,5) + ')');
      await fetchSettings();
      scheduleScreenshot();
      return;
    }
    log('[SS] Taking screenshot...');
    takeScreenshot(async function(err, tmpFile) {
      if (!err) {
        try {
          const form = new FormData();
          form.append('screenshot', fs.createReadStream(tmpFile));
          await axios.post(SERVER_URL + '/api/agent/screenshot', form, {
            headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, form.getHeaders()),
            timeout: 0
          });
          try { fs.unlinkSync(tmpFile); } catch(e) {}
          log('[SS] Screenshot sent OK - ' + new Date().toLocaleTimeString());
          if (offlineQueue.length > 0 && !isRetrying) retryQueue();
        } catch(e) {
          // Save for retry
          try {
            if (!fs.existsSync(PENDING_SS)) fs.mkdirSync(PENDING_SS, { recursive: true });
            const pendingFile = path.join(PENDING_SS, 'ss_' + Date.now() + '.jpg');
            fs.renameSync(tmpFile, pendingFile);
            log('[SS] Offline - saved for retry: ' + pendingFile);
          } catch(e2) { log('[SS] Upload error: ' + e.message); }
        }
      } else {
        log('[SS] Error: ' + err.message);
        // Check if permission denied
        if (err.message.includes('not permitted') || err.message.includes('permission')) {
          log('[SS] ⚠️  Screen Recording permission required!');
          log('[SS] Go to: System Settings → Privacy & Security → Screen Recording → Allow WorkPulse');
        }
      }
      await fetchSettings();
      scheduleScreenshot();
    });
  }, screenshotInterval * 60 * 1000);
}

// ── Heartbeat (every 20 seconds) ──────────────────────────────────────────────
schedule.scheduleJob('*/20 * * * * *', async function() {
  if (!AGENT_TOKEN) return;
  logCaptureWindowOnce();
  if (!isWithinCaptureWindow()) {
    await fetchSettings();
    return;
  }

  try {
    const app = getActiveWindow();
    const idleSeconds = getIdleSeconds();
    const isIdle = idleSeconds > 300;
    const isLocked = isScreenLocked();

    // Lock state events
    if (isLocked && !lastLockState) {
      await safePost('/api/agent/system-event', { event_type: 'locked' });
      log('[Lock] Screen locked');
    }
    if (!isLocked && lastLockState) {
      await safePost('/api/agent/system-event', { event_type: 'unlocked' });
      log('[Lock] Screen unlocked');
    }
    lastLockState = isLocked;

    if (!lastIdleState && isIdle && idleSeconds > 600) {
      await safePost('/api/agent/system-event', { event_type: 'idle_lock' });
    }
    lastIdleState = isIdle;

    if (isLocked) {
      log('[LOCKED] System Locked - Idle: ' + idleSeconds + 's');
      return;
    }

    const urls = getBrowserActivity().map(u => Object.assign({}, u, { idle_seconds: isIdle ? idleSeconds : 0 }));
    const apps = isIdle ? [] : getAllApps(app);

    hbCounter++;
    const hbNum = hbCounter;
    try {
      await axios.post(SERVER_URL + '/api/agent/heartbeat', {
        active_app: app,
        idle: isIdle,
        apps,
        urls,
        version: AGENT_VERSION
      }, {
        headers: { 'x-agent-token': AGENT_TOKEN },
        timeout: 0
      });
      log('[HB #' + hbNum + '] Sent - ' + app + ' - Idle: ' + idleSeconds + 's - URLs: ' + urls.length + ' - Apps: ' + apps.length);
      if (offlineQueue.length > 0 && !isRetrying) retryQueue();
    } catch(e) {
      offlineQueue.push({ path: '/api/agent/heartbeat', body: { active_app: app, idle: isIdle, apps, urls, version: AGENT_VERSION }, headers: {} });
      saveQueue();
      log('[HB #' + hbNum + '] Offline queued (' + offlineQueue.length + ') - ' + app);
    }
  } catch(e) {
    log('[HB] Error: ' + e.message);
  }
});

// ── System events check every 5 mins ─────────────────────────────────────────
schedule.scheduleJob('*/5 * * * *', async function() {
  if (!AGENT_TOKEN) return;
  await checkMacEvents();
});

// ── Startup ───────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

if (loadConfig()) {
  loadQueue();
  log('WorkPulse Mac Agent running...');
  axios.post(SERVER_URL + '/api/agent/system-event',
    { event_type: 'startup' },
    { headers: { 'x-agent-token': AGENT_TOKEN }, timeout: 5000 }
  ).catch(() => {});
  fetchSettings().then(() => scheduleScreenshot());
} else {
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  log('[Agent] SIGTERM received - shutting down');
  await safePost('/api/agent/system-event', { event_type: 'shutdown' });
  process.exit(0);
});
process.on('SIGINT', async () => {
  log('[Agent] SIGINT received - shutting down');
  await safePost('/api/agent/system-event', { event_type: 'shutdown' });
  process.exit(0);
});
