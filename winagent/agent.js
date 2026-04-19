const axios = require('axios');
const schedule = require('node-schedule');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const AGENT_VERSION = '2.6.5';
const CONFIG_FILE = 'C:\\WorkPulse\\config.json';
let SERVER_URL = 'http://10.10.11.251';

let AGENT_TOKEN = '';
let currentApp = '';
let appStartTime = Date.now();
var lastIdleState = false;
var lastLockState = false;

// Offline queue - stores failed requests for retry
var offlineQueue = [];
var isRetrying = false;
var QUEUE_FILE = 'C:\\WorkPulse\\offline_queue.json';

function saveQueue() {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(offlineQueue)); } catch(e) {}
}

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      offlineQueue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) || [];
      console.log('[Queue] Loaded ' + offlineQueue.length + ' offline items');
    }
  } catch(e) { offlineQueue = []; }
}

async function retryQueue() {
  if (isRetrying || !offlineQueue.length) return;
  isRetrying = true;
  var remaining = [];
  for (var item of offlineQueue) {
    try {
      await axios.post(SERVER_URL + item.path, item.body, {
        headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, item.headers||{}),
        timeout: 10000
      });
    } catch(e) {
      remaining.push(item);
    }
  }
  offlineQueue = remaining;
  saveQueue();
  isRetrying = false;
  if (offlineQueue.length === 0) console.log('[Queue] All offline items synced');
  // Also retry pending screenshots
  retryPendingScreenshots();
}

async function retryPendingScreenshots() {
  var pendingDir = 'C:\\WorkPulse\\pending_screenshots';
  if (!fs.existsSync(pendingDir)) return;
  var files = fs.readdirSync(pendingDir).filter(function(f){ return f.endsWith('.png'); });
  if (!files.length) return;
  console.log('[SS] Retrying ' + files.length + ' pending screenshots...');
  for (var file of files) {
    var filePath = pendingDir + '\\' + file;
    try {
      var form = new FormData();
      form.append('screenshot', fs.createReadStream(filePath));
      await axios.post(SERVER_URL + '/api/agent/screenshot', form, {
        headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, form.getHeaders()),
        timeout: 30000
      });
      fs.unlinkSync(filePath);
      console.log('[SS] Retry sent: ' + file);
    } catch(e) {
      break; // still offline, stop trying
    }
  }
}

async function safePost(path, body, headers) {
  try {
    await axios.post(SERVER_URL + path, body, {
      headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, headers||{}),
      timeout: 10000
    });
    // If successful, retry any queued items
    if (offlineQueue.length > 0) retryQueue();
  } catch(e) {
    // Queue for later retry
    if (offlineQueue.length < 500) {
      offlineQueue.push({ path: path, body: body, headers: headers||{} });
      saveQueue();
    }
  }
}
var systemCheckInterval = 60; // seconds

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    AGENT_TOKEN = config.token;
    if (config.server_url) SERVER_URL = config.server_url;
    console.log('WorkPulse Agent v' + AGENT_VERSION);
    console.log('Agent started for:', config.email);
    console.log('Server:', SERVER_URL);
    return true;
  } catch (e) {
    console.error('Config not found at', CONFIG_FILE);
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
  } catch (e) {
    return '';
  }
}

function getActiveWindow() {
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
    const result = runPS(psScript);
    return result || 'Desktop';
  } catch (e) {
    return 'Desktop';
  }
}

var lastEventCheck = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24hr lookback on startup
var lastFullBackfill = Date.now();

async function checkWindowsEvents() {
  try {
    // Every 6 hours do a full 24hr backfill to catch missed events
    var now = Date.now();
    if (now - lastFullBackfill > 6 * 60 * 60 * 1000) {
      lastEventCheck = new Date(now - 24 * 60 * 60 * 1000);
      lastFullBackfill = now;
      console.log('[Events] 6hr backfill - checking last 24hrs');
    }
    var since = lastEventCheck.toISOString();
    lastEventCheck = new Date();
    var script = `
$since = [DateTime]::Parse('${since}').ToLocalTime()
$events = @()
# Security log - lock/unlock (needs admin)
try {
  $lock = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4800,4801;StartTime=$since} -ErrorAction SilentlyContinue
  foreach($e in $lock) {
    $type = if($e.Id -eq 4800){'locked'}else{'unlocked'}
    $events += [PSCustomObject]@{type=$type;time=$e.TimeCreated.ToUniversalTime().ToString('o')}
  }
} catch {}
# System log - sleep/wake/shutdown
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
  } catch (e) {
    return 0;
  }
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
  // Try to extract domain if title starts with domain-like pattern
  var domainMatch = i.url.match(/^([a-zA-Z0-9][a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2})?)/);
  if (domainMatch) cleanUrl = domainMatch[1].toLowerCase();
}

      return { url: cleanUrl, browser: i.browser || "Browser", seconds: 60 };
    });
  } catch(e) { return []; }
}



function getAllApps(activeApp) {
  // Only track foreground active app — not background/minimized apps
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
  } catch(e) {
    callback(e);
  }
}

// Check Windows Event Log every 5 minutes
schedule.scheduleJob('*/5 * * * *', async function() {
  if (!AGENT_TOKEN) return;
  await checkWindowsEvents();
});

// Heartbeat every 20 seconds
schedule.scheduleJob('*/20 * * * * *', async function() {
  if (!AGENT_TOKEN) return;
  try {
    const app = getActiveWindow();
    const idleSeconds = getIdleSeconds();
    const isIdle = idleSeconds > 300;

    // Detect Win+L lock by checking if LockApp has a visible main window
    const lockCheckScript = `
$lockProc = Get-Process -Name 'LockApp' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
$logonProc = Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue
if ($lockProc -or $logonProc) { Write-Output 'locked' } else { Write-Output 'unlocked' }
`;
    const lockState = runPS(lockCheckScript).trim();
    const isLocked = (lockState === 'locked');
    if (isLocked && !lastLockState) {
      try {
        await safePost('/api/agent/system-event', { event_type: 'locked' });
        console.log('[Lock] Screen locked detected via LockApp.exe');
      } catch(e) {}
    }
    if (!isLocked && lastLockState) {
      try {
        await safePost('/api/agent/system-event', { event_type: 'unlocked' });
        console.log('[Lock] Screen unlocked detected');
      } catch(e) {}
    }
    lastLockState = isLocked;

// Detect idle/away transition
    if (!lastIdleState && isIdle && idleSeconds > 600) {
      try {
        await safePost('/api/agent/system-event', { event_type: 'idle_lock' });
      } catch(e) {}
    }
    lastIdleState = isIdle;

    // Don't track URLs or apps when screen is locked
    const urls = isLocked ? [] : getBrowserActivity().map(function(u) {
      return Object.assign({}, u, { idle_seconds: isIdle ? idleSeconds : 0 });
    });
    // Only track app if not idle and not locked
    const apps = (isIdle || isLocked) ? [] : getAllApps(app);

    await safePost('/api/agent/heartbeat', {
      active_app: app,
      idle: isIdle,
      apps: apps,
      urls: urls,
      version: AGENT_VERSION
    });

    if (isLocked && !lastLockState) {
      console.log('[' + new Date().toLocaleTimeString() + '] [LOCKED] System Locked');
    } else if (!isLocked && lastLockState) {
      console.log('[' + new Date().toLocaleTimeString() + '] [UNLOCKED] System Unlocked - ' + app);
    } else if (isLocked) {
      console.log('[' + new Date().toLocaleTimeString() + '] [LOCKED] System Locked - Idle: ' + idleSeconds + 's');
    } else {
      console.log('[' + new Date().toLocaleTimeString() + '] OK - ' + app + ' - Idle: ' + idleSeconds + 's - URLs: ' + urls.length + ' - Apps: ' + apps.length);
    }
  } catch (e) {
    console.error('Heartbeat error:', e.message);
  }
});

// Dynamic screenshot interval
var screenshotInterval = 5;

async function fetchSettings() {
  try {
    var res = await axios.get(SERVER_URL + '/api/agent/settings', {
      headers: { 'x-agent-token': AGENT_TOKEN },
      timeout: 5000
    });
    screenshotInterval = res.data.screenshot_interval || 5;
    console.log('Screenshot interval: ' + screenshotInterval + ' mins');
  } catch(e) {}
}

function scheduleScreenshot() {
  setTimeout(async function() {
    if (!AGENT_TOKEN) { scheduleScreenshot(); return; }
    if (lastLockState) {
      console.log('[SS] Skipped - screen locked');
      await fetchSettings();
      scheduleScreenshot();
      return;
    }
    takeScreenshot(async function(err, tmpFile) {
	console.log('[SS] Taking screenshot...');
      if (!err) {
        try {
          var form = new FormData();
          form.append('screenshot', fs.createReadStream(tmpFile));
          await axios.post(SERVER_URL + '/api/agent/screenshot', form, {
            headers: Object.assign({ 'x-agent-token': AGENT_TOKEN }, form.getHeaders()),
            timeout: 30000
          });
          fs.unlinkSync(tmpFile);
		console.log('[SS] Screenshot sent OK - ' + new Date().toLocaleTimeString());
		if (offlineQueue.length > 0) retryQueue();
        } catch(e) {
          var pendingDir = 'C:\\WorkPulse\\pending_screenshots';
          try {
            if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir,{recursive:true});
            var pendingFile = pendingDir + '\\ss_' + Date.now() + '.png';
            fs.renameSync(tmpFile, pendingFile);
            console.log('[SS] Offline - saved for retry: ' + pendingFile);
          } catch(e2) { console.error('Screenshot upload error:', e.message); }
        }
      } else {
		console.error('Screenshot error:', err.message, err.stack||'');
      }
      await fetchSettings();
      scheduleScreenshot();
    });
  }, screenshotInterval * 60 * 1000);
}

if (loadConfig()) {
  loadQueue();
  console.log('WorkPulse Agent running...');
  console.log('Server: ' + SERVER_URL);
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
