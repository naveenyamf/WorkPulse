const axios = require('axios');
const schedule = require('node-schedule');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const CONFIG_FILE = 'C:\\WorkPulse\\config.json';
let SERVER_URL = 'http://10.10.11.251';

let AGENT_TOKEN = '';
let currentApp = '';
let appStartTime = Date.now();
var lastIdleState = false;
var systemCheckInterval = 60; // seconds

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    AGENT_TOKEN = config.token;
    if (config.server_url) SERVER_URL = config.server_url;
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
    const result = runPS(`
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class WinAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  }
"@
$hwnd = [WinAPI]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'Desktop'; exit }
if ([WinAPI]::IsIconic($hwnd)) { Write-Output 'Desktop'; exit }
$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
if ($pid -eq 0) { Write-Output 'Desktop'; exit }
try {
  $proc = Get-Process -Id $pid -ErrorAction Stop
  if ($proc.Name -match 'ApplicationFrameHost|ShellExperienceHost|SearchUI|SearchApp') {
    Write-Output 'Desktop'
  } else {
    Write-Output $proc.Name
  }
} catch { Write-Output 'Desktop' }
`);
    return result || 'Desktop';
  } catch (e) {
    return 'Desktop';
  }
}

var lastEventCheck = new Date(Date.now() - 5 * 60 * 1000);

async function checkWindowsEvents() {
  try {
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
        await axios.post(SERVER_URL + '/api/agent/system-event',
          { event_type: ev.type, recorded_at: ev.time },
          { headers: { 'x-agent-token': AGENT_TOKEN }, timeout: 5000 }
        );
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

	return { url: cleanUrl, browser: i.browser || "Browser", seconds: 20 };
    });
  } catch(e) { return []; }
}



function getAllApps(activeApp) {
  // Only track the foreground active app — not all open apps
  if (!activeApp || activeApp === 'Desktop' || activeApp === '') return [];
  return [{ name: activeApp, seconds: 20 }];
}

function takeScreenshot(callback) {
  try {
    const tmpFile = path.join(os.tmpdir(), 'wp_screenshot.png').replace(/\\/g, '/');
const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$left = [int]::MaxValue; $top = [int]::MaxValue; $right = [int]::MinValue; $bottom = [int]::MinValue
foreach ($s in $screens) {
  if ($s.Bounds.Left -lt $left) { $left = $s.Bounds.Left }
  if ($s.Bounds.Top -lt $top) { $top = $s.Bounds.Top }
  if ($s.Bounds.Right -gt $right) { $right = $s.Bounds.Right }
  if ($s.Bounds.Bottom -gt $bottom) { $bottom = $s.Bounds.Bottom }
}
$width = $right - $left
$height = $bottom - $top
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
foreach ($screen in $screens) {
  $destX = $screen.Bounds.Left - $left
  $destY = $screen.Bounds.Top - $top
  $graphics.CopyFromScreen($screen.Bounds.Location, (New-Object System.Drawing.Point($destX, $destY)), $screen.Bounds.Size)
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

// Heartbeat every 20 Seconds
schedule.scheduleJob('*/20 * * * * *', async function() {
  if (!AGENT_TOKEN) return;
  try {
    const app = getActiveWindow();
    const idleSeconds = getIdleSeconds();
    const isIdle = idleSeconds > 300;

// Detect idle/away transition
    if (!lastIdleState && isIdle && idleSeconds > 600) {
      try {
        await axios.post(SERVER_URL + '/api/agent/system-event',
          { event_type: 'idle_lock' },
          { headers: { 'x-agent-token': AGENT_TOKEN }, timeout: 5000 }
        );
      } catch(e) {}
    }
    lastIdleState = isIdle;

    const urls = getBrowserActivity().map(function(u) {
  return Object.assign({}, u, { idle_seconds: isIdle ? idleSeconds : 0 });
});
    // Only track app if not idle — don't log time when user is away
    const apps = isIdle ? [] : getAllApps(app);

    await axios.post(SERVER_URL + '/api/agent/heartbeat', {
      active_app: app,
      idle: isIdle,
      apps: apps,
      urls: urls
    }, {
      headers: { 'x-agent-token': AGENT_TOKEN },
      timeout: 10000
    });

    console.log('[' + new Date().toLocaleTimeString() + '] OK - ' + app + ' - Idle: ' + idleSeconds + 's - URLs: ' + urls.length + ' - Apps: ' + apps.length);
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
        } catch(e) {
          console.error('Screenshot upload error:', e.message);
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
