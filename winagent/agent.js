const axios = require('axios');
const schedule = require('node-schedule');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const AGENT_VERSION = '3.0.2';
const CONFIG_FILE = 'C:\\WorkPulse\\config.json';
let SERVER_URL = 'http://10.10.11.251';

let AGENT_TOKEN = '';
let currentApp = '';
let appStartTime = Date.now();
var lastIdleState = false;
var lastLockState = false;

const LOG_FILE = 'C:\\WorkPulse\\agent.log';
const MAX_LOG_SIZE = 1 * 1024 * 1024;

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

var offlineQueue = [];
var isRetrying = false;
var hbCounter = 0;
var QUEUE_FILE = 'C:\\WorkPulse\\offline_queue.json';

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(offlineQueue)); } catch(e) {}
}

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      offlineQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || [];
      if (offlineQueue.length > 20) {
        log('[Queue] Queue too large (' + offlineQueue.length + '), trimming to last 20');
        offlineQueue = offlineQueue.slice(-20);
        saveQueue();
      }
      log('[Queue] Loaded ' + offlineQueue.length + ' offline items');
    }
  } catch(e) { offlineQueue = []; }
}

async function retryQueue() {
  if (isRetrying || !offlineQueue.length) return;
  isRetrying = true;
  try {
    var remaining = [];
    var total = offlineQueue.length;
    for (var i = 0; i < offlineQueue.length; i++) {
      var item = offlineQueue[i];
      var num = (i + 1) + '/' + total;
      log('[Queue] Retrying ' + num + ': ' + item.path);
      try {
        await axios.post(SERVER_URL + item.path, item.body, {
          headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, item.headers||{}),
          timeout: 0
        });
        log('[Queue] ' + num + ' Sent OK');
      } catch(e) {
        log('[Queue] ' + num + ' Failed - keeping (' + (e.message||'unknown') + ')');
        remaining.push(item);
      }
    }
    offlineQueue = remaining;
    saveQueue();
    if (offlineQueue.length === 0) {
      log('[Queue] All items synced');
    } else {
      log('[Queue] ' + offlineQueue.length + ' items still pending');
    }
    retryPendingScreenshots();
  } finally {
    isRetrying = false;
  }
}

async function retryPendingScreenshots() {
  var pendingDir = 'C:\\WorkPulse\\pending_screenshots';
  if (!fs.existsSync(pendingDir)) return;
  var files = fs.readdirSync(pendingDir).filter(function(f){ return f.endsWith('.png'); });
  if (!files.length) return;
  log('[SS] Retrying ' + files.length + ' pending screenshots...');
  for (var file of files) {
    var filePath = pendingDir + '\\' + file;
    try {
      var form = new FormData();
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
    offlineQueue.push({ path: path, body: body, headers: headers||{} });
    saveQueue();
  }
}

var systemCheckInterval = 60;

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    AGENT_TOKEN = config.token;
    if (config.server_url) SERVER_URL = config.server_url;
    log('WorkPulse Agent v' + AGENT_VERSION);
    log('Agent started for: ' + config.email);
    log('Server: ' + SERVER_URL);
    return true;
  } catch (e) {
    log('Config not found at ' + CONFIG_FILE);
    return false;
  }
}

function runPS(script) {
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return execSync(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded,
      { timeout: 8000, windowsHide: true }
    ).toString().trim();
  } catch (e) { return ''; }
}

var cachedActiveWindow = 'Desktop';
var lastPolledWindow = 'Desktop';

setInterval(function() {
  try {
    var psScript = [
      'Add-Type @"',
      '  using System;',
      '  using System.Runtime.InteropServices;',
      '  public class WinAPI {',
      '    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);',
      '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
      '  }',
      '"@',
      '$hwnd = [WinAPI]::GetForegroundWindow()',
      'if ($hwnd -eq [IntPtr]::Zero) { Write-Output "Desktop"; exit }',
      'if ([WinAPI]::IsIconic($hwnd)) { Write-Output "Desktop"; exit }',
      '$procId = 0',
      '[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null',
      'if ($procId -eq 0) { Write-Output "Desktop"; exit }',
      'try {',
      '  $proc = Get-Process -Id $procId -ErrorAction Stop',
      '  if ($proc.Name -match "ApplicationFrameHost|ShellExperienceHost|SearchUI|SearchApp") {',
      '    Write-Output "Desktop"',
      '  } else {',
      '    Write-Output $proc.Name',
      '  }',
      '} catch { Write-Output "Desktop" }'
    ].join('\n');
    var result = runPS(psScript);
    if (result && result !== 'Desktop' && result !== '') {
      if (result === lastPolledWindow) {
        cachedActiveWindow = result;
      }
      lastPolledWindow = result;
    }
  } catch(e) {}
}, 3000);

function getActiveWindow() {
  return cachedActiveWindow;
}

var lastEventCheck = new Date(Date.now() - 24 * 60 * 60 * 1000);
var lastFullBackfill = Date.now();

async function checkWindowsEvents() {
  try {
    var now = Date.now();
    if (now - lastFullBackfill > 6 * 60 * 60 * 1000) {
      lastEventCheck = new Date(now - 24 * 60 * 60 * 1000);
      lastFullBackfill = now;
      log('[Events] 6hr backfill - checking last 24hrs');
    }
    var since = lastEventCheck.toISOString();
    lastEventCheck = new Date();
    var script = `
$since = [DateTime]::Parse('${since}').ToLocalTime()
$events = @()
try {
  $lock = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4800,4801;StartTime=$since} -ErrorAction SilentlyContinue
  foreach($e in $lock) {
    $type = if($e.Id -eq 4800){'locked'}else{'unlocked'}
    $events += [PSCustomObject]@{type=$type;time=$e.TimeCreated.ToUniversalTime().ToString('o')}
  }
} catch {}
try {
  $sys = Get-WinEvent -FilterHashtable @{LogName='System';Id=1,12,13,42,6006,6008;StartTime=$since} -ErrorAction SilentlyContinue
  foreach($e in $sys) {
    $type = switch($e.Id) {
      42 {'sleep'} 1 {'wakeup'} 12 {'startup'} 13 {'shutdown'} 6006 {'shutdown'} 6008 {'shutdown'} default {$null}
    }
    if($type) { $events += [PSCustomObject]@{type=$type;time=$e.TimeCreated.ToUniversalTime().ToString('o')} }
  }
} catch {}
if($events.Count -eq 0) { Write-Output '[]' } else { $events | ConvertTo-Json -Compress }
`;
    var result = runPS(script);
    if (!result || result === '[]' || result === 'null') return;
    var events;
    try { events = JSON.parse(result); } catch(e) { return; }
    if (!Array.isArray(events)) events = [events];
    for (var ev of events) {
      try {
        await safePost('/api/agent/system-event', { event_type: ev.type, recorded_at: ev.time });
      } catch(e) {}
    }
  } catch(e) {}
}

function getIdleSeconds() {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IdleTimer {
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint GetIdle() {
    var i = new LASTINPUTINFO();
    i.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(i);
    GetLastInputInfo(ref i);
    return (uint)(Environment.TickCount - i.dwTime) / 1000;
  }
}
"@
[IdleTimer]::GetIdle()`;
    const result = runPS(script);
    return parseInt(result) || 0;
  } catch (e) { return 0; }
}

function getBrowserActivity() {
  try {
    const script = `
$result = @()
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "chrome|msedge|firefox|opera|brave|vivaldi" -and $_.MainWindowTitle -ne "" }
foreach ($p in $procs) {
  $browser = switch -Regex ($p.Name) { "chrome" { "Chrome" } "msedge" { "Edge" } "firefox" { "Firefox" } "opera" { "Opera" } "brave" { "Brave" } default { "Browser" } }
  $title = $p.MainWindowTitle -replace " - Google Chrome$","" -replace " - Microsoft Edge$","" -replace " - Mozilla Firefox$","" -replace " - Opera$","" -replace " - Brave$","" -replace " and [0-9]+ more.*$","" -replace " - Work - Microsoft.*$","" -replace "^\([0-9]+\) ",""
  $title = $title.Trim()
  if ($title.Length -gt 2 -and $title -notmatch "^New Tab$|^New tab$|^Speed Dial|^about:|^chrome:|^edge:") {
    $result += [PSCustomObject]@{ url=$title; browser=$browser }
  }
}
if ($result.Count -eq 0) { Write-Output "[]" } else {
  $result | Group-Object url | ForEach-Object { [PSCustomObject]@{ url=$_.Name; browser=($_.Group | Select-Object -First 1).browser } } | ConvertTo-Json -Compress
}`;
    const result = runPS(script);
    if (!result || result === "null" || result === "[]") return [];
    let items;
    try { items = JSON.parse(result); } catch(e) { return []; }
    const arr = Array.isArray(items) ? items : [items];
    return arr.filter(function(i){ return i && i.url && i.url.length > 2; }).map(function(i){
      var cleanUrl = i.url;
      var urlInTitle = i.url.match(/https?:\/\/(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2})?)/);
      if (urlInTitle) {
        cleanUrl = urlInTitle[1].toLowerCase();
      } else {
        var domainMatch = i.url.match(/^([a-zA-Z0-9][a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2})?)/);
        if (domainMatch) cleanUrl = domainMatch[1].toLowerCase();
      }
      return { url: cleanUrl, browser: i.browser || "Browser", seconds: 60 };
    });
  } catch(e) { return []; }
}

function getAllApps(activeApp) {
  if (!activeApp || activeApp === 'Desktop' || activeApp === '') return [];
  return [{ name: activeApp, seconds: 20 }];
}

function takeScreenshot(callback) {
  try {
    const tmpFile = path.join(os.tmpdir(), 'wp_screenshot.png').replace(/\\/g, '/');
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GDICapture {
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
}
"@
$hdc = [GDICapture]::GetDC([IntPtr]::Zero)
$physW = [GDICapture]::GetDeviceCaps($hdc, 118)
$physH = [GDICapture]::GetDeviceCaps($hdc, 117)
[GDICapture]::ReleaseDC([IntPtr]::Zero, $hdc) | Out-Null
$screens = [System.Windows.Forms.Screen]::AllScreens
$left = 0; $top = 0; $right = 0; $bottom = 0
foreach ($s in $screens) {
  if ($s.Bounds.Left -lt $left)     { $left   = $s.Bounds.Left }
  if ($s.Bounds.Top -lt $top)       { $top     = $s.Bounds.Top }
  if ($s.Bounds.Right -gt $right)   { $right   = $s.Bounds.Right }
  if ($s.Bounds.Bottom -gt $bottom) { $bottom  = $s.Bounds.Bottom }
}
$logW = $right - $left
$logH = $bottom - $top
$primW = $screens[0].Bounds.Width
$scaleX = if ($primW -gt 0 -and $physW -gt 0) { $physW / $primW } else { 1 }
$scaleY = if ($primW -gt 0 -and $physH -gt 0) { $physH / $screens[0].Bounds.Height } else { 1 }
$totalW = [int]($logW * $scaleX)
$totalH = [int]($logH * $scaleY)
if ($totalW -le 0) { $totalW = $physW }
if ($totalH -le 0) { $totalH = $physH }
$bitmap = New-Object System.Drawing.Bitmap($totalW, $totalH)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
foreach ($screen in $screens) {
  $srcX = [int](($screen.Bounds.Left - $left) * $scaleX)
  $srcY = [int](($screen.Bounds.Top - $top) * $scaleY)
  $scrW = [int]($screen.Bounds.Width * $scaleX)
  $scrH = [int]($screen.Bounds.Height * $scaleY)
  $graphics.CopyFromScreen($screen.Bounds.Left, $screen.Bounds.Top, $srcX, $srcY, (New-Object System.Drawing.Size($scrW, $scrH)))
}
$bitmap.Save("${tmpFile}")
$graphics.Dispose()
$bitmap.Dispose()`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded,
      { windowsHide: true, timeout: 15000 },
      function(err) {
        if (err) return callback(err);
        const realPath = path.join(os.tmpdir(), 'wp_screenshot.png');
        if (fs.existsSync(realPath)) callback(null, realPath);
        else callback(new Error('Screenshot not created'));
      }
    );
  } catch(e) { callback(e); }
}

schedule.scheduleJob('*/5 * * * *', async function() {
  if (!AGENT_TOKEN) return;
  await checkWindowsEvents();
});

schedule.scheduleJob('*/20 * * * * *', async function() {
  if (!AGENT_TOKEN) return;
  logCaptureWindowOnce();
  if (!isWithinCaptureWindow()) {
    var win = captureSchedule.window;
    var winStr = (win && win.start) ? (win.start.slice(0,5) + ' - ' + win.end.slice(0,5)) : 'not set';
    log('[HB] Skipped - outside capture window (' + winStr + ')');
    await fetchSettings();
    return;
  }
  try {
    const app = getActiveWindow();
    const idleSeconds = getIdleSeconds();
    const isIdle = idleSeconds > 300;

    const lockCheckScript = [
      '$lockProc = Get-Process -Name "LockApp" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }',
      '$logonProc = Get-Process -Name "LogonUI" -ErrorAction SilentlyContinue',
      'if ($lockProc -or $logonProc) { Write-Output "locked" } else { Write-Output "unlocked" }'
    ].join('\n');
    const lockState = runPS(lockCheckScript).trim();
    const isLocked = (lockState === 'locked');

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

    const urls = getBrowserActivity().map(function(u) {
      return Object.assign({}, u, { idle_seconds: isIdle ? idleSeconds : 0 });
    });
    const apps = isIdle ? [] : getAllApps(app);

    hbCounter++;
    var hbNum = hbCounter;
    try {
      await axios.post(SERVER_URL + '/api/agent/heartbeat', {
        active_app: app,
        idle: isIdle,
        apps: apps,
        urls: urls,
        version: AGENT_VERSION
      }, {
        headers: { 'x-agent-token': AGENT_TOKEN },
        timeout: 0
      });
      log('[HB #' + hbNum + '] Sent - ' + app + ' - Idle: ' + idleSeconds + 's - URLs: ' + urls.length + ' - Apps: ' + apps.length);
      if (offlineQueue.length > 0 && !isRetrying) retryQueue();
    } catch(e) {
      offlineQueue.push({ path: '/api/agent/heartbeat', body: { active_app: app, idle: isIdle, apps: apps, urls: urls, version: AGENT_VERSION }, headers: {} });
      saveQueue();
      log('[HB #' + hbNum + '] Offline queued (' + offlineQueue.length + ' in queue) - ' + app + ' - Idle: ' + idleSeconds + 's');
    }

  } catch (e) {
    log('Heartbeat error: ' + e.message);
  }
});

var screenshotInterval = 5;
var captureSchedule = { enabled: false, window: null };
var captureLoggedDate = '';

function isWithinCaptureWindow() {
  if (!captureSchedule.enabled || !captureSchedule.window) return true;
  var win = captureSchedule.window;
  if (!win.start || !win.end) return true;
  var now = new Date();
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var start = win.start.slice(0,5).split(':');
  var end = win.end.slice(0,5).split(':');
  var startMins = parseInt(start[0]) * 60 + parseInt(start[1]);
  var endMins = parseInt(end[0]) * 60 + parseInt(end[1]);
  return nowMins >= startMins && nowMins < endMins;
}

function logCaptureWindowOnce() {
  if (!captureSchedule.enabled || !captureSchedule.window) return;
  var today = new Date().toISOString().slice(0,10);
  if (captureLoggedDate === today) return;
  captureLoggedDate = today;
  var win = captureSchedule.window;
  log('[CaptureSchedule] Capture time set from ' + (win.start||'').slice(0,5) + ' to ' + (win.end||'').slice(0,5) + ' for today (source: ' + (win.source||'custom') + ')');
}

async function fetchSettings() {
  try {
    var res = await axios.get(SERVER_URL + '/api/agent/settings', {
      headers: { 'x-agent-token': AGENT_TOKEN },
      timeout: 5000
    });
    screenshotInterval = res.data.screenshot_interval || 5;
    if (res.data.captureSchedule) {
      captureSchedule = res.data.captureSchedule;
      logCaptureWindowOnce();
    }
    log('Screenshot interval: ' + screenshotInterval + ' mins');
  } catch(e) {}
}

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
      var win = captureSchedule.window;
      log('[SS] Skipped - outside capture window (' + (win&&win.start||'').slice(0,5) + '-' + (win&&win.end||'').slice(0,5) + ')');
      await fetchSettings();
      scheduleScreenshot();
      return;
    }
    takeScreenshot(async function(err, tmpFile) {
      log('[SS] Taking screenshot...');
      if (!err) {
        try {
          var form = new FormData();
          form.append('screenshot', fs.createReadStream(tmpFile));
          await axios.post(SERVER_URL + '/api/agent/screenshot', form, {
            headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, form.getHeaders()),
            timeout: 0
          });
          fs.unlinkSync(tmpFile);
          log('[SS] Screenshot sent OK - ' + new Date().toLocaleTimeString());
          if (offlineQueue.length > 0 && !isRetrying) retryQueue();
        } catch(e) {
          var pendingDir = 'C:\\WorkPulse\\pending_screenshots';
          try {
            if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });
            var pendingFile = pendingDir + '\\ss_' + Date.now() + '.png';
            fs.renameSync(tmpFile, pendingFile);
            log('[SS] Offline - saved for retry: ' + pendingFile);
          } catch(e2) { log('Screenshot upload error: ' + e.message); }
        }
      } else {
        log('Screenshot error: ' + err.message);
      }
      await fetchSettings();
      scheduleScreenshot();
    });
  }, screenshotInterval * 60 * 1000);
}

if (loadConfig()) {
  loadQueue();
  log('WorkPulse Agent running...');
  log('Server: ' + SERVER_URL);
  axios.post(SERVER_URL + '/api/agent/system-event',
    { event_type: 'startup' },
    { headers: { 'x-agent-token': AGENT_TOKEN }, timeout: 5000 }
  ).catch(function(){});
  fetchSettings().then(function() {
    scheduleScreenshot();
  });
} else {
  process.exit(1);
}
