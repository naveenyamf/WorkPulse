const axios = require('axios');
const screenshot = require('screenshot-desktop');
const activeWin = require('active-win');
const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// ---- CONFIGURE THESE TWO LINES ----
const SERVER_URL = 'http://10.10.11.251';
const AGENT_TOKEN = 'ffc40d640ceaa0cb5852a870c4e885dcd0f329c05cb4bd19884d52e45f319923';
// -----------------------------------

const headers = { 'x-agent-token': AGENT_TOKEN };

let urlBuffer = [];
let appBuffer = [];
let appStartTime = Date.now();
let currentApp = '';

async function getActiveApp() {
  try {
    const win = await activeWin();
    return win ? win.owner.name : 'Unknown';
  } catch (e) {
    return 'Unknown';
  }
}

function isIdle() {
  return false; // Basic version — always not idle
}

// Send heartbeat every 1 minute
schedule.scheduleJob('*/1 * * * *', async () => {
  try {
    const app = await getActiveApp();

    // Track app usage time
    if (currentApp && currentApp !== app) {
      const seconds = Math.round((Date.now() - appStartTime) / 1000);
      if (seconds > 5) appBuffer.push({ name: currentApp, seconds });
      appStartTime = Date.now();
    }
    currentApp = app;

    await axios.post(`${SERVER_URL}/api/agent/heartbeat`, {
      active_app: app,
      idle: isIdle(),
      urls: urlBuffer.splice(0),
      apps: appBuffer.splice(0)
    }, { headers });

    console.log(`[${new Date().toLocaleTimeString()}] Heartbeat sent — App: ${app}`);
  } catch (e) {
    console.error('Heartbeat failed:', e.message);
  }
});

// Take screenshot every 5 minutes
schedule.scheduleJob('*/5 * * * *', async () => {
  try {
    const imgBuffer = await screenshot({ format: 'jpg' });
    const tmpFile = path.join(__dirname, 'tmp_screenshot.jpg');
    fs.writeFileSync(tmpFile, imgBuffer);

    const form = new FormData();
    form.append('screenshot', fs.createReadStream(tmpFile));

    await axios.post(`${SERVER_URL}/api/agent/screenshot`, form, {
      headers: { ...headers, ...form.getHeaders() }
    });

    fs.unlinkSync(tmpFile);
    console.log(`[${new Date().toLocaleTimeString()}] Screenshot sent`);
  } catch (e) {
    console.error('Screenshot failed:', e.message);
  }
});

console.log('WorkPulse Agent started...');
console.log('Server:', SERVER_URL);
console.log('Sending heartbeat every 1 minute');
console.log('Sending screenshot every 5 minutes');
