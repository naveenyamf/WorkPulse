// WorkPulse Chromebook Agent - Popup Script

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'msg ' + type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function getStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, resolve);
  });
}

async function init() {
  const status = await getStatus();

  const configSection = document.getElementById('configSection');
  const statusSection = document.getElementById('statusSection');

  if (!status || !status.configured) {
    configSection.style.display = 'block';
    setupConfigForm();
    return;
  }

  // Show status
  statusSection.style.display = 'block';
  document.getElementById('infoApp').textContent    = status.active_app || '—';
  document.getElementById('infoIdle').textContent   = status.idle ? 'Yes' : 'No';
  document.getElementById('infoQueue').textContent  = status.queue_size + ' item' + (status.queue_size !== 1 ? 's' : '');
  document.getElementById('infoServer').textContent = status.server_url || '—';

  if (status.idle) {
    document.getElementById('statusDot').className = 'dot offline';
    document.getElementById('statusLabel').textContent = 'Idle Detected';
    document.getElementById('statusSub').textContent = 'Employee is inactive';
  }

  // Load logs
  function renderLogs() {
    chrome.storage.local.get('agent_logs', (data) => {
      const logs = data.agent_logs || [];
      const box = document.getElementById('logBox');
      if (!logs.length) { box.innerHTML = '<span style="color:#536478">No logs yet...</span>'; return; }
      box.innerHTML = logs.slice().reverse().map(l => {
        let cls = '';
        if (l.includes('[HB')) cls = 'hb';
        else if (l.includes('[SS') || l.includes('Screenshot')) cls = 'ss';
        else if (l.includes('error') || l.includes('Error') || l.includes('failed')) cls = 'err';
        return '<div class="' + cls + '">' + l + '</div>';
      }).join('');
    });
  }
  renderLogs();
  setInterval(renderLogs, 3000); // refresh every 3 seconds

  // Clear logs button
  document.getElementById('btnClearLogs').addEventListener('click', () => {
    chrome.storage.local.set({ agent_logs: [] });
    document.getElementById('logBox').innerHTML = '<span style="color:#536478">Logs cleared</span>';
  });

  // Force heartbeat button
  document.getElementById('btnHeartbeat').addEventListener('click', async () => {
    const btn = document.getElementById('btnHeartbeat');
    btn.disabled = true; btn.textContent = 'Sending...';
    await new Promise(r => chrome.runtime.sendMessage({ type: 'FORCE_HEARTBEAT' }, r));
    btn.disabled = false; btn.textContent = 'Send Heartbeat';
    showMsg(document.getElementById('hbMsg'), 'Heartbeat sent!', 'ok');
  });

  // Disconnect button
  document.getElementById('btnDisconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect this device from WorkPulse?')) return;
    await new Promise(r => chrome.runtime.sendMessage({ type: 'CLEAR_CONFIG' }, r));
    window.location.reload();
  });
}

function setupConfigForm() {
  document.getElementById('btnConnect').addEventListener('click', async () => {
    const btn       = document.getElementById('btnConnect');
    const serverRaw = document.getElementById('serverUrl').value.trim();
    const email     = document.getElementById('empEmail').value.trim();
    const msgEl     = document.getElementById('configMsg');

    if (!serverRaw) return showMsg(msgEl, 'Server URL is required', 'err');
    if (!email)     return showMsg(msgEl, 'Employee email is required', 'err');

    // Normalize URL
    let server = serverRaw;
    if (!server.startsWith('http')) server = 'http://' + server;
    server = server.replace(/\/$/, '');

    btn.disabled = true; btn.textContent = 'Connecting...';

    try {
      // Lookup employee token (same endpoint as installer.bat)
      const machineId = 'chromebook-' + (await getMachineId());
      const res = await fetch(`${server}/api/agent/token/${encodeURIComponent(email)}?machine_id=${encodeURIComponent(machineId)}`);
      if (!res.ok) throw new Error('Employee not found (HTTP ' + res.status + ')');
      const data = await res.json();
      if (!data.token) throw new Error('No token returned. Check the email address.');

      // Save and start monitoring
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'SAVE_CONFIG',
          server_url: server,
          token: data.token
        }, resolve);
      });

      showMsg(msgEl, '✓ Connected! Monitoring started.', 'ok');
      setTimeout(() => window.location.reload(), 1200);

    } catch (e) {
      showMsg(msgEl, e.message || 'Connection failed', 'err');
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });
}

// Generate a stable machine ID from chrome.storage (set once, persisted)
async function getMachineId() {
  return new Promise(resolve => {
    chrome.storage.local.get('machine_id', async (data) => {
      if (data.machine_id) return resolve(data.machine_id);
      // Generate a random ID and persist it
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      chrome.storage.local.set({ machine_id: id });
      resolve(id);
    });
  });
}

init();
