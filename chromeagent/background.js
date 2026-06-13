// WorkPulse Chromebook Agent - Background Service Worker
// Mirrors agent.js logic for Chromebook environment

const AGENT_VERSION = '1.2.0';

// ── Logger (stores to chrome.storage.local) ───────────────────────────────────
async function log(msg) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  console.log(line);
  try {
    const data = await chrome.storage.local.get('agent_logs');
    let logs = data.agent_logs || [];
    logs.push(line);
    if (logs.length > 200) logs = logs.slice(-200);
    await chrome.storage.local.set({ agent_logs: logs });
  } catch(e) {}
}

// ── App name map (domain → display name) ──────────────────────────────────────
const APP_MAP = [
  // Google Workspace
  { match: 'docs.google.com',        name: 'Google Docs' },
  { match: 'sheets.google.com',      name: 'Google Sheets' },
  { match: 'slides.google.com',      name: 'Google Slides' },
  { match: 'drive.google.com',       name: 'Google Drive' },
  { match: 'mail.google.com',        name: 'Gmail' },
  { match: 'calendar.google.com',    name: 'Google Calendar' },
  { match: 'meet.google.com',        name: 'Google Meet' },
  { match: 'chat.google.com',        name: 'Google Chat' },
  { match: 'classroom.google.com',   name: 'Google Classroom' },
  { match: 'forms.google.com',       name: 'Google Forms' },
  { match: 'jamboard.google.com',    name: 'Google Jamboard' },
  { match: 'sites.google.com',       name: 'Google Sites' },
  { match: 'keep.google.com',        name: 'Google Keep' },
  // Microsoft
  { match: 'teams.microsoft.com',    name: 'Microsoft Teams' },
  { match: 'outlook.live.com',       name: 'Outlook' },
  { match: 'outlook.office.com',     name: 'Outlook' },
  { match: 'office.com',            name: 'Microsoft Office' },
  { match: 'onedrive.live.com',      name: 'OneDrive' },
  { match: 'sharepoint.com',         name: 'SharePoint' },
  { match: 'word-edit',              name: 'Word Online' },
  { match: 'excel-edit',             name: 'Excel Online' },
  // Communication
  { match: 'zoom.us',                name: 'Zoom' },
  { match: 'slack.com',              name: 'Slack' },
  { match: 'discord.com',            name: 'Discord' },
  { match: 'web.whatsapp.com',       name: 'WhatsApp Web' },
  { match: 'telegram.org',           name: 'Telegram Web' },
  // Productivity
  { match: 'notion.so',              name: 'Notion' },
  { match: 'trello.com',             name: 'Trello' },
  { match: 'asana.com',              name: 'Asana' },
  { match: 'monday.com',             name: 'Monday.com' },
  { match: 'jira',                   name: 'Jira' },
  { match: 'confluence',             name: 'Confluence' },
  { match: 'clickup.com',            name: 'ClickUp' },
  { match: 'airtable.com',           name: 'Airtable' },
  { match: 'linear.app',             name: 'Linear' },
  // Dev
  { match: 'github.com',             name: 'GitHub' },
  { match: 'gitlab.com',             name: 'GitLab' },
  { match: 'stackoverflow.com',      name: 'Stack Overflow' },
  { match: 'codepen.io',             name: 'CodePen' },
  { match: 'replit.com',             name: 'Replit' },
  { match: 'colab.research.google',  name: 'Google Colab' },
  // Design
  { match: 'figma.com',              name: 'Figma' },
  { match: 'canva.com',              name: 'Canva' },
  { match: 'miro.com',               name: 'Miro' },
  // Social / Non-productive
  { match: 'youtube.com',            name: 'YouTube' },
  { match: 'facebook.com',           name: 'Facebook' },
  { match: 'instagram.com',          name: 'Instagram' },
  { match: 'twitter.com',            name: 'Twitter/X' },
  { match: 'x.com',                  name: 'Twitter/X' },
  { match: 'linkedin.com',           name: 'LinkedIn' },
  { match: 'reddit.com',             name: 'Reddit' },
  { match: 'netflix.com',            name: 'Netflix' },
  // News
  { match: 'news.google.com',        name: 'Google News' },
  // Search / General
  { match: 'google.com/search',      name: 'Google Search' },
  { match: 'bing.com',               name: 'Bing' },
  { match: 'chatgpt.com',            name: 'ChatGPT' },
  { match: 'claude.ai',              name: 'Claude AI' },
];

function getAppName(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return null;
  for (const entry of APP_MAP) {
    if (url.includes(entry.match)) return entry.name;
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname || null;
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    if (!url || url.startsWith('chrome://')) return null;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

// ── State ─────────────────────────────────────────────────────────────────────
let SERVER_URL = '';
let AGENT_TOKEN = '';
let screenshotInterval = 5; // minutes
let captureSchedule = { enabled: false, window: null };
let offlineQueue = [];
let isRetrying = false;
let hbCounter = 0;

// Active tab tracking
let activeTabId = null;
let activeWindowId = null;
let tabStartTime = Date.now();
let currentTabUrl = '';
let currentTabAppName = '';

// App usage accumulator: { appName -> seconds }
let appUsageBuffer = {};
// URL buffer: [{ url, duration_seconds }]
let urlBuffer = [];

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadState() {
  const data = await chrome.storage.local.get([
    'server_url', 'agent_token', 'offline_queue',
    'screenshot_interval', 'capture_schedule'
  ]);
  SERVER_URL      = data.server_url      || '';
  AGENT_TOKEN     = data.agent_token     || '';
  offlineQueue    = data.offline_queue   || [];
  screenshotInterval = data.screenshot_interval || 5;
  captureSchedule = data.capture_schedule || { enabled: false, window: null };
}

async function saveQueue() {
  await chrome.storage.local.set({ offline_queue: offlineQueue });
}

// ── Network helpers ───────────────────────────────────────────────────────────
async function safePost(path, body) {
  if (!SERVER_URL || !AGENT_TOKEN) return;
  try {
    const res = await fetch(SERVER_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-token': AGENT_TOKEN
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // On success, try to drain queue
    if (offlineQueue.length > 0 && !isRetrying) retryQueue();
  } catch (e) {
    offlineQueue.push({ path, body });
    if (offlineQueue.length > 50) offlineQueue = offlineQueue.slice(-50);
    await saveQueue();
  }
}

async function retryQueue() {
  if (isRetrying || !offlineQueue.length) return;
  isRetrying = true;
  try {
    const remaining = [];
    for (const item of offlineQueue) {
      try {
        const res = await fetch(SERVER_URL + item.path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-agent-token': AGENT_TOKEN
          },
          body: JSON.stringify(item.body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch {
        remaining.push(item);
      }
    }
    offlineQueue = remaining;
    await saveQueue();
  } finally {
    isRetrying = false;
  }
}

async function apiGet(path) {
  if (!SERVER_URL || !AGENT_TOKEN) return null;
  try {
    const res = await fetch(SERVER_URL + path, {
      headers: { 'x-agent-token': AGENT_TOKEN }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Capture window check (mirrors agent.js isWithinCaptureWindow) ─────────────
function isWithinCaptureWindow() {
  if (!captureSchedule.enabled || !captureSchedule.window) return true;
  const win = captureSchedule.window;
  if (!win.start || !win.end) return true;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = win.start.slice(0, 5).split(':').map(Number);
  const [eh, em] = win.end.slice(0, 5).split(':').map(Number);
  return nowMins >= (sh * 60 + sm) && nowMins < (eh * 60 + em);
}

// ── Tab focus tracking ────────────────────────────────────────────────────────
function flushCurrentTab() {
  if (!currentTabUrl || !currentTabAppName) return;
  const elapsed = Math.round((Date.now() - tabStartTime) / 1000);
  if (elapsed < 2) return; // ignore very short blips

  // Accumulate app usage
  appUsageBuffer[currentTabAppName] = (appUsageBuffer[currentTabAppName] || 0) + elapsed;

  // Accumulate URL entry
  const existing = urlBuffer.find(u => u.url === currentTabUrl);
  if (existing) {
    existing.duration_seconds += elapsed;
  } else {
    urlBuffer.push({ url: currentTabUrl, duration_seconds: elapsed });
  }
}

function setActiveTab(tabId, url) {
  flushCurrentTab();
  activeTabId   = tabId;
  currentTabUrl = url || '';
  currentTabAppName = getAppName(currentTabUrl) || '';
  tabStartTime  = Date.now();
}

// Tab activated
chrome.tabs.onActivated.addListener(async (info) => {
  activeWindowId = info.windowId;
  try {
    const tab = await chrome.tabs.get(info.tabId);
    setActiveTab(info.tabId, tab.url);
  } catch {}
});

// Tab URL updated (navigation within same tab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeTabId && changeInfo.url) {
    setActiveTab(tabId, changeInfo.url);
  }
});

// Window focus changed
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome lost focus — flush but keep tracking
    flushCurrentTab();
    currentTabAppName = '';
    currentTabUrl = '';
    return;
  }
  activeWindowId = windowId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) setActiveTab(tab.id, tab.url);
  } catch {}
});

// ── Fetch settings from server (mirrors agent.js fetchSettings) ───────────────
async function fetchSettings() {
  const data = await apiGet('/api/agent/settings');
  if (!data) return;
  screenshotInterval = data.screenshot_interval || 5;
  if (data.captureSchedule) captureSchedule = data.captureSchedule;
  await chrome.storage.local.set({
    screenshot_interval: screenshotInterval,
    capture_schedule: captureSchedule
  });
  // Reschedule screenshot alarm with new interval
  await chrome.alarms.clear('screenshot');
  chrome.alarms.create('screenshot', { periodInMinutes: screenshotInterval });
}

// ── Heartbeat (every 20 seconds via alarm) ────────────────────────────────────
async function sendHeartbeat() {
  log('[HB] sendHeartbeat called - token:', !!AGENT_TOKEN, 'server:', !!SERVER_URL);
  if (!AGENT_TOKEN || !SERVER_URL) { log('[HB] Skipped - not configured'); return; }
  if (!isWithinCaptureWindow()) {
    log('[HB] Skipped - outside capture window');
    await fetchSettings();
    return;
  }

  // Flush current tab before building payload
  flushCurrentTab();
  tabStartTime = Date.now(); // reset timer after flush

  // Build apps array from buffer
  const apps = Object.entries(appUsageBuffer).map(([app_name, duration_seconds]) => ({
    name: app_name,
    seconds: duration_seconds
  }));

  // Build URLs array
  const urls = urlBuffer.map(u => ({ url: u.url, seconds: u.duration_seconds, idle_seconds: 0, browser: 'Chrome', full_url: u.url }));

  // Get idle state
  const idleState = await new Promise(resolve => chrome.idle.queryState(300, resolve));
  const isIdle = idleState !== 'active';

  hbCounter++;
  const payload = {
    active_app: currentTabAppName || 'Chrome',
    idle: isIdle,
    apps: isIdle ? [] : apps,
    urls: isIdle ? urls.map(u => ({ ...u, idle_seconds: 300 })) : urls,
    version: AGENT_VERSION
  };

  log('[HB #' + hbCounter + '] Sending - App: ' + (currentTabAppName || 'None') + ' - Idle: ' + isIdle + ' - Apps: ' + apps.length + ' - URLs: ' + urls.length);
  await safePost('/api/agent/heartbeat', payload);
  log('[HB #' + hbCounter + '] Sent OK');

  // Clear buffers after successful heartbeat attempt
  appUsageBuffer = {};
  urlBuffer = [];
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function takeAndSendScreenshot() {
  if (!AGENT_TOKEN || !SERVER_URL) return;
  if (!isWithinCaptureWindow()) {
    await fetchSettings();
    return;
  }

  try {
    // Get current active window
    const [win] = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    if (!win) return;

    // Find focused window
    const focused = (await chrome.windows.getAll({ windowTypes: ['normal'] }))
      .find(w => w.focused) || win;

    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: 'jpeg',
      quality: 70
    });

    if (!dataUrl) return;

    // Convert dataURL to blob and send as multipart
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    const form = new FormData();
    form.append('screenshot', blob, 'screenshot.jpg');

    const res = await fetch(SERVER_URL + '/api/agent/screenshot', {
      method: 'POST',
      headers: { 'x-agent-token': AGENT_TOKEN },
      body: form
    });

    if (!res.ok) throw new Error('Upload failed: ' + res.status);

  } catch (e) {
    console.warn('[WorkPulse] Screenshot failed:', e.message);
    // Queue a marker so we know screenshot was missed (server side)
    offlineQueue.push({
      path: '/api/agent/system-event',
      body: { event_type: 'screenshot_failed', reason: e.message }
    });
    await saveQueue();
  }
}

// ── Idle / lock detection ─────────────────────────────────────────────────────
let lastIdleState = false;
chrome.idle.onStateChanged.addListener(async (newState) => {
  const isIdle = newState !== 'active';
  if (isIdle && !lastIdleState) {
    await safePost('/api/agent/system-event', { event_type: 'idle_lock' });
  }
  // Re-setup alarms when screen becomes active again (after lock/sleep)
  if (newState === 'active' && lastIdleState) {
    await loadState();
    if (AGENT_TOKEN && SERVER_URL) {
      setupAlarms();
      await log('[WorkPulse] Screen active - alarms re-created');
    }
  }
  lastIdleState = isIdle;
});

// ── Startup / shutdown events ─────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  if (AGENT_TOKEN) {
    await safePost('/api/agent/system-event', { event_type: 'startup' });
    await fetchSettings();
    setupAlarms();
  }
});

chrome.runtime.onSuspend.addListener(async () => {
  flushCurrentTab();
  await safePost('/api/agent/system-event', { event_type: 'shutdown' });
});

// ── Alarms ────────────────────────────────────────────────────────────────────
function setupAlarms() {
  // Heartbeat every 20 seconds — Chrome alarms minimum is 1 min,
  // so we use a 1-minute alarm and fire 3x manually inside
  chrome.alarms.create('heartbeat',   { periodInMinutes: 1 });
  chrome.alarms.create('screenshot',  { periodInMinutes: screenshotInterval });
  chrome.alarms.create('settings',    { periodInMinutes: 5 });
  chrome.alarms.create('retryQueue',  { periodInMinutes: 2 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await loadState(); // always re-read config in case it changed
  switch (alarm.name) {
    case 'heartbeat':
      // Fire 3 heartbeats per minute (every 20 seconds)
      await sendHeartbeat();
      setTimeout(async () => { await loadState(); await sendHeartbeat(); }, 20000);
      setTimeout(async () => { await loadState(); await sendHeartbeat(); }, 40000);
      break;
    case 'screenshot':
      await takeAndSendScreenshot();
      break;
    case 'settings':
      await fetchSettings();
      break;
    case 'retryQueue':
      if (offlineQueue.length > 0) await retryQueue();
      break;
  }
});

// ── Message handler (from popup) ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_STATUS': {
        const idleState = await new Promise(r => chrome.idle.queryState(300, r));
        sendResponse({
          configured: !!(SERVER_URL && AGENT_TOKEN),
          server_url: SERVER_URL,
          active_app: currentTabAppName || 'Idle',
          active_url: currentTabUrl,
          idle: idleState !== 'active',
          queue_size: offlineQueue.length,
          version: AGENT_VERSION
        });
        break;
      }
      case 'SAVE_CONFIG': {
        SERVER_URL  = msg.server_url.replace(/\/$/, '');
        AGENT_TOKEN = msg.token;
        await chrome.storage.local.set({
          server_url: SERVER_URL,
          agent_token: AGENT_TOKEN
        });
        // Send startup event
        await safePost('/api/agent/system-event', { event_type: 'startup' });
        await fetchSettings();
        setupAlarms();
        sendResponse({ success: true });
        break;
      }
      case 'CLEAR_CONFIG': {
        SERVER_URL = ''; AGENT_TOKEN = '';
        await chrome.storage.local.clear();
        await chrome.alarms.clearAll();
        sendResponse({ success: true });
        break;
      }
      case 'FORCE_HEARTBEAT': {
        await sendHeartbeat();
        sendResponse({ success: true });
        break;
      }
    }
  })();
  return true; // keep message channel open for async
});

// ── Init on service worker start ─────────────────────────────────────────────
(async () => {
  await loadState();
  if (AGENT_TOKEN && SERVER_URL) {
    setupAlarms();
    log('[WorkPulse] Agent initialized - alarms set');
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) setActiveTab(tab.id, tab.url);
    } catch {}
  } else {
    log('[WorkPulse] Not configured yet - waiting for setup');
  }
})();

// ── Re-setup alarms on install/update ────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  if (AGENT_TOKEN && SERVER_URL) {
    setupAlarms();
    log('[WorkPulse] Alarms re-created on install/update');
  }
});
