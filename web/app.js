'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const MAX_RECENT = 50;
const recentCalls = [];
let currentCall = null;
let isPlaying = false;
let wsReconnectTimer = null;
let ws = null;

// muteList: Map<tgid (number), tag (string)>  — persisted to localStorage
const muteList = new Map(
  JSON.parse(localStorage.getItem('op25_mute_list') || '[]')
);
function saveMuteList() {
  localStorage.setItem('op25_mute_list', JSON.stringify([...muteList]));
}
function isMuted(tgid) { return muteList.has(Number(tgid)); }
function toggleMute(tgid, tag) {
  tgid = Number(tgid);
  if (muteList.has(tgid)) {
    muteList.delete(tgid);
  } else {
    muteList.set(tgid, tag || 'Unknown');
  }
  saveMuteList();
  applyCurrentMute();
  renderMutedGroups();
  if (recentCalls.length) renderCallList();
  refreshTgList();
}

// lockoutList: Set<tgid (number)> with tag cache — persisted to localStorage
const lockoutList = new Map(
  JSON.parse(localStorage.getItem('op25_lockout_list') || '[]')
);
function saveLockoutList() {
  localStorage.setItem('op25_lockout_list', JSON.stringify([...lockoutList]));
}
function isLockedOut(tgid) { return lockoutList.has(Number(tgid)); }
function toggleLockout(tgid, tag) {
  tgid = Number(tgid);
  if (lockoutList.has(tgid)) {
    lockoutList.delete(tgid);
  } else {
    lockoutList.set(tgid, tag || 'Unknown');
  }
  saveLockoutList();
  refreshTgList();
  // If current call is now locked out, fire immediately
  if (currentCall && currentCall.tgid === tgid && lockoutList.has(tgid)) {
    apiPost('/api/lockout');
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusDot   = $('status-dot');
const statusLabel = $('status-label');
const systemName  = $('system-name');
const callBadge   = $('call-badge');
const tgidEl      = $('tgid');
const tgNameEl    = $('tg-name');
const freqDisplay = $('freq-display');
const srcDisplay  = $('src-display');
const nacDisplay  = $('nac-display');
const rssiBar     = $('rssi-bar');
const rssiLabel   = $('rssi-label');
const playBtn     = $('play-btn');
const iconPlay    = $('icon-play');
const iconPause   = $('icon-pause');
const audioStatus = $('audio-status');
const audioBars   = $('audio-bars');
const audioPlayer = $('audio-player');
const callList    = $('call-list');

// ── WebSocket ─────────────────────────────────────────────────────────────────
let _wsPingInterval = null;

function connectWS() {
  clearTimeout(wsReconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setConnectionState('live');
    // Keep-alive ping — store ID so we can clear it on close
    _wsPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
  };

  ws.onmessage = ({ data }) => {
    try {
      const status = JSON.parse(data);
      if (status.error) {
        setConnectionState('error');
      } else {
        setConnectionState('live');
        updateStatus(status);
      }
    } catch (_) {}
  };

  ws.onclose = ws.onerror = () => {
    clearInterval(_wsPingInterval);   // prevent interval stacking on reconnect
    _wsPingInterval = null;
    setConnectionState('disconnected');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };
}

function setConnectionState(state) {
  statusDot.className = 'status-dot';
  if (state === 'live') {
    statusDot.classList.add('live');
    statusLabel.textContent = 'LIVE';
  } else if (state === 'error') {
    statusDot.classList.add('error');
    statusLabel.textContent = 'OP25 DOWN';
  } else {
    statusLabel.textContent = 'CONNECTING';
  }
}

// ── Status update ─────────────────────────────────────────────────────────────
function updateStatus(s) {
  // System name
  if (s.rx_sys || s.system) {
    systemName.textContent = s.rx_sys || s.system;
  }

  // Current talkgroup
  const tgid = s.tgid || s.curr_tgid;
  const tgTag = s.tgid_tag || s.tag || '';
  const callActive = s.call_active || (tgid && tgid !== 0);

  if (tgid && tgid !== 0) {
    const muted = isMuted(tgid);
    tgidEl.textContent = tgid;
    tgNameEl.textContent = tgTag || 'Unknown Group';
    callBadge.textContent = muted ? 'MUTED' : 'ACTIVE';
    callBadge.className   = muted ? 'call-badge muted' : 'call-badge active';
    updateMuteBtn(tgid, tgTag, muted);
  } else {
    tgidEl.textContent = '—';
    tgNameEl.textContent = 'No active call';
    callBadge.textContent = 'IDLE';
    callBadge.className = 'call-badge';
    $('mute-tg-btn').style.display = 'none';
  }
  applyCurrentMute();

  // Frequency
  if (s.du_freq || s.freq) {
    const hz = s.du_freq || s.freq;
    const mhz = (hz / 1e6).toFixed(4);
    freqDisplay.textContent = `${mhz} MHz`;
  }

  // Source unit
  if (s.src_addr || s.source) {
    const src = s.src_addr || s.source;
    const srcTag = s.src_tag ? ` (${s.src_tag})` : '';
    srcDisplay.textContent = `SRC ${src}${srcTag}`;
  }

  // NAC
  if (s.du_nac !== undefined) {
    nacDisplay.textContent = `NAC 0x${s.du_nac.toString(16).toUpperCase().padStart(3, '0')}`;
  }

  // RSSI / signal strength
  if (s.ppm !== undefined || s.pct !== undefined) {
    const pct = s.pct !== undefined ? Math.min(100, Math.max(0, s.pct)) : 50;
    rssiBar.style.width = `${pct}%`;
    const ppmStr = s.ppm !== undefined ? ` ${s.ppm > 0 ? '+' : ''}${s.ppm.toFixed(1)} ppm` : '';
    rssiLabel.textContent = `Signal ${pct}%${ppmStr}`;
  }

  // Auto-lockout: if this TG is in our lockout list, tell OP25 immediately
  if (tgid && tgid !== 0 && isLockedOut(tgid)) {
    apiPost('/api/lockout');
  }

  // Keep Groups tab active dot in sync
  if (tgid) updateTgActiveState(tgid);

  // Track recent calls
  if (tgid && tgid !== 0) {
    if (!currentCall || currentCall.tgid !== tgid) {
      currentCall = { tgid, tag: tgTag, time: new Date() };
      addRecentCall(currentCall);
    }
  } else {
    currentCall = null;
  }
}

// ── Mute helpers ──────────────────────────────────────────────────────────────
function applyCurrentMute() {
  const tgid = currentCall?.tgid;
  audioPlayer.muted = tgid ? isMuted(tgid) : false;
}

function updateMuteBtn(tgid, tag, muted) {
  const btn = $('mute-tg-btn');
  btn.style.display = '';
  btn.classList.toggle('muted', muted);
  btn.title = muted ? 'Unmute this talkgroup' : 'Mute this talkgroup';
  $('icon-speaker').style.display = muted ? 'none' : '';
  $('icon-muted').style.display   = muted ? '' : 'none';
  // Replace listener each time (tgid may have changed)
  btn.onclick = () => toggleMute(tgid, tag);
}

function renderMutedGroups() {
  const list  = $('muted-list');
  const clear = $('muted-clear-btn');
  if (!muteList.size) {
    list.innerHTML = '<li class="muted-empty">No muted groups</li>';
    clear.disabled = true;
    return;
  }
  clear.disabled = false;
  list.innerHTML = [...muteList.entries()].map(([tgid, tag]) => `
    <li class="muted-item">
      <span class="muted-item-tgid">${tgid}</span>
      <span class="muted-item-name">${tag}</span>
      <button class="unmute-btn" data-tgid="${tgid}">Unmute</button>
    </li>`).join('');
  list.querySelectorAll('.unmute-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleMute(btn.dataset.tgid, ''));
  });
}

$('muted-clear-btn').addEventListener('click', () => {
  muteList.clear();
  saveMuteList();
  applyCurrentMute();
  renderMutedGroups();
  if (recentCalls.length) renderCallList();
});

// Render muted groups on sheet open
$('gear-btn').addEventListener('click', renderMutedGroups, { capture: true });

// ── Recent calls list ─────────────────────────────────────────────────────────
function addRecentCall({ tgid, tag, time }) {
  // Dedupe: if same tgid as top entry within 5s, skip
  if (recentCalls.length > 0) {
    const last = recentCalls[0];
    if (last.tgid === tgid && (time - last.time) < 5000) return;
  }

  recentCalls.unshift({ tgid, tag, time });
  if (recentCalls.length > MAX_RECENT) recentCalls.pop();
  renderCallList();
}

function renderCallList() {
  if (recentCalls.length === 0) {
    callList.innerHTML = '<li class="call-item-empty">No calls yet</li>';
    return;
  }

  // SVG paths for inline speaker icons in list rows
  const speakerPath = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
  const mutedPath   = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;

  callList.innerHTML = recentCalls.map((call, i) => {
    const isActive = i === 0 && currentCall && currentCall.tgid === call.tgid;
    const muted    = isMuted(call.tgid);
    const age      = formatAge(call.time);
    const icon     = muted ? mutedPath : speakerPath;
    return `
      <li class="call-item${muted ? ' is-muted' : ''}" data-tgid="${call.tgid}" data-tag="${call.tag || ''}">
        <span class="call-dot${isActive ? ' active-call' : ''}"></span>
        <span class="call-tgid">${call.tgid}</span>
        <span class="call-name">${call.tag || 'Unknown'}</span>
        <span class="call-time">${age}</span>
        <button class="call-mute-btn" data-tgid="${call.tgid}" data-tag="${call.tag || ''}" title="${muted ? 'Unmute' : 'Mute'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
        </button>
      </li>`;
  }).join('');

  // Tap row → hold; tap speaker → mute (stop propagation so both work)
  callList.querySelectorAll('.call-item[data-tgid]').forEach(el => {
    el.addEventListener('click', () => {
      const tgid = parseInt(el.dataset.tgid);
      apiPost(`/api/hold/${tgid}`);
      flashBtn(el, 'HOLD');
    });
  });

  callList.querySelectorAll('.call-mute-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleMute(btn.dataset.tgid, btn.dataset.tag);
    });
  });
}

function formatAge(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

// Update ages every 10s
setInterval(() => {
  if (recentCalls.length > 0) renderCallList();
}, 10000);

// ── Audio ─────────────────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
  if (isPlaying) {
    stopAudio();
  } else {
    startAudio();
  }
});

function startAudio() {
  // iOS Safari requires the audio src to be set after a user gesture
  audioPlayer.src = '/stream';
  audioPlayer.load();

  const playPromise = audioPlayer.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => setPlayingState(true))
      .catch(() => {
        audioStatus.textContent = 'Playback blocked — tap again';
        setPlayingState(false);
      });
  }
}

function stopAudio() {
  audioPlayer.pause();
  audioPlayer.src = '';
  setPlayingState(false);
}

function setPlayingState(playing) {
  isPlaying = playing;
  if (playing) {
    playBtn.classList.add('playing');
    iconPlay.style.display = 'none';
    iconPause.style.display = '';
    audioStatus.textContent = 'Streaming live audio';
    audioBars.classList.add('active');
  } else {
    playBtn.classList.remove('playing');
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    audioStatus.textContent = 'Tap to start audio';
    audioBars.classList.remove('active');
  }
}

audioPlayer.addEventListener('ended', () => setPlayingState(false));
audioPlayer.addEventListener('error', () => {
  audioStatus.textContent = 'Stream error — tap to retry';
  setPlayingState(false);
});

// ── Control buttons ───────────────────────────────────────────────────────────
$('btn-hold').addEventListener('click', () => apiPost('/api/hold'));
$('btn-skip').addEventListener('click', () => apiPost('/api/skip'));
$('btn-lockout').addEventListener('click', () => {
  if (confirm('Lockout this talkgroup?')) apiPost('/api/lockout');
});
$('btn-scan').addEventListener('click', () => apiPost('/api/scan'));

async function apiPost(url) {
  try {
    const r = await fetch(url, { method: 'POST' });
    return r.ok ? r.json() : null;
  } catch (e) {
    console.warn('API call failed:', url, e);
    return null;
  }
}

function flashBtn(el, label) {
  const original = el.querySelector('.call-name')?.textContent;
  if (!original) return;
  el.querySelector('.call-name').textContent = `✓ ${label}`;
  setTimeout(() => { el.querySelector('.call-name').textContent = original; }, 1000);
}

// ── Config sheet ──────────────────────────────────────────────────────────────
const gearBtn     = $('gear-btn');
const configSheet = $('config-sheet');
const backdrop    = $('sheet-backdrop');
const sheetClose  = $('sheet-close');
const rrUrlInput  = $('rr-url');
const rrFetchBtn  = $('rr-fetch-btn');
const rrStatus    = $('rr-status');
const cfgName     = $('cfg-name');
const cfgFreqs    = $('cfg-freqs');
const cfgNac      = $('cfg-nac');
const cfgWacn     = $('cfg-wacn');
const cfgSysid    = $('cfg-sysid');
const cfgSaveBtn  = $('cfg-save-btn');
const saveStatus  = $('save-status');

function openSheet() {
  configSheet.classList.add('open');
  backdrop.classList.add('open');
  configSheet.removeAttribute('aria-hidden');
}

function closeSheet() {
  configSheet.classList.remove('open');
  backdrop.classList.remove('open');
  configSheet.setAttribute('aria-hidden', 'true');
}

gearBtn.addEventListener('click', openSheet);
sheetClose.addEventListener('click', closeSheet);
backdrop.addEventListener('click', closeSheet);

// RadioReference fetch
rrFetchBtn.addEventListener('click', async () => {
  const url = rrUrlInput.value.trim();
  if (!url) return;

  rrFetchBtn.disabled = true;
  rrStatus.className = 'rr-status';
  rrStatus.textContent = 'Fetching…';

  try {
    const r = await fetch(`/api/rr/lookup?url=${encodeURIComponent(url)}`);
    const data = await r.json();

    if (!r.ok) {
      rrStatus.className = 'rr-status error';
      rrStatus.textContent = data.detail || 'Fetch failed';
      return;
    }

    // Populate fields
    if (data.name)             cfgName.value  = data.name;
    if (data.control_channels?.length) cfgFreqs.value = data.control_channels.join('\n');
    if (data.nac)              cfgNac.value   = data.nac;
    if (data.wacn)             cfgWacn.value  = data.wacn;
    if (data.sysid)            cfgSysid.value = data.sysid;

    const count = data.control_channels?.length ?? 0;
    rrStatus.className = 'rr-status success';
    rrStatus.textContent = `Found ${count} control channel${count !== 1 ? 's' : ''}`;
  } catch (e) {
    rrStatus.className = 'rr-status error';
    rrStatus.textContent = 'Network error — check server';
  } finally {
    rrFetchBtn.disabled = false;
  }
});

// Save config
cfgSaveBtn.addEventListener('click', async () => {
  const name = cfgName.value.trim();
  const freqs = cfgFreqs.value.split('\n').map(f => f.trim()).filter(Boolean);

  if (!name || freqs.length === 0) {
    saveStatus.className = 'save-status error';
    saveStatus.textContent = 'System name and at least one frequency are required';
    return;
  }

  cfgSaveBtn.disabled = true;
  saveStatus.className = 'save-status';
  saveStatus.textContent = 'Saving…';

  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        control_channels: freqs,
        nac:   cfgNac.value.trim()   || '0',
        wacn:  cfgWacn.value.trim()  || '0',
        sysid: cfgSysid.value.trim() || '0',
      }),
    });
    const data = await r.json();

    if (!r.ok) {
      saveStatus.className = 'save-status error';
      saveStatus.textContent = data.detail || 'Save failed';
    } else {
      saveStatus.className = 'save-status success';
      saveStatus.textContent = '✓ Saved — restart op25 service to apply';
    }
  } catch (e) {
    saveStatus.className = 'save-status error';
    saveStatus.textContent = 'Network error';
  } finally {
    cfgSaveBtn.disabled = false;
  }
});

// ── Tab navigation ────────────────────────────────────────────────────────────
let statusPollTimer = null;

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const page = tab.dataset.page;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`page-${page}`).classList.add('active');

    clearInterval(statusPollTimer);
    if (page === 'status') {
      refreshStatus();
      statusPollTimer = setInterval(refreshStatus, 4000);
    } else if (page === 'groups') {
      refreshTgList();
    }
  });
});

// ── Record button ─────────────────────────────────────────────────────────────
const recordBtn = $('record-btn');
let isRecording = false;
let recTimerInterval = null;
let recSeconds = 0;

recordBtn.addEventListener('click', async () => {
  if (isRecording) {
    const data = await apiPost('/api/record/stop');
    setRecordingState(false);
  } else {
    const data = await apiPost('/api/record/start');
    if (data && data.ok) setRecordingState(true);
  }
});

function setRecordingState(recording) {
  isRecording = recording;
  recordBtn.classList.toggle('recording', recording);
  clearInterval(recTimerInterval);
  if (recording) {
    recSeconds = 0;
    recTimerInterval = setInterval(() => {
      recSeconds++;
      recordBtn.title = formatDuration(recSeconds);
    }, 1000);
  } else {
    recordBtn.title = 'Record';
    // Refresh recordings list if status tab is open
    if (document.getElementById('page-status').classList.contains('active')) {
      refreshStatus();
    }
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Status page ───────────────────────────────────────────────────────────────
async function refreshStatus() {
  let data;
  try {
    const r = await fetch('/api/services');
    data = await r.json();
  } catch (e) {
    return;
  }

  // Services
  for (const [name, state] of Object.entries(data.services || {})) {
    const cardId = `svc-${name}`;
    const card = document.getElementById(cardId);
    if (!card) continue;
    const dot   = card.querySelector('.svc-dot');
    const label = card.querySelector('.svc-state');
    dot.className = 'svc-dot';
    if (state === 'active') dot.classList.add('active');
    else if (state === 'failed') dot.classList.add('failed');
    else if (state === 'inactive') dot.classList.add('inactive');
    label.textContent = state;
  }

  // Dependencies
  setDep('dep-op25api', data.op25_api,  data.op25_api  ? 'Responding' : 'Unreachable');
  setDep('dep-ffmpeg',  data.ffmpeg,    data.ffmpeg    ? 'Available'  : 'Not found');
  setDep('dep-rtlsdr',  data.rtlsdr,   data.rtlsdr   ? 'Detected'   : 'Not detected');

  // Sync recording state from server (e.g. after page reload)
  if (data.recording && !isRecording) setRecordingState(true);
  if (!data.recording && isRecording) setRecordingState(false);

  // Recordings list
  try {
    const r2 = await fetch('/api/record/list');
    const recordings = await r2.json();
    renderRecordings(recordings);
  } catch (e) {}
}

function setDep(id, ok, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector('.dep-icon').textContent = ok ? '✓' : '✗';
  el.querySelector('.dep-icon').style.color = ok ? 'var(--accent)' : 'var(--danger)';
  el.querySelector('.dep-val').textContent  = label;
}

function renderRecordings(list) {
  const ul = $('rec-list');
  if (!list.length) {
    ul.innerHTML = '<li class="call-item-empty">No recordings yet</li>';
    return;
  }
  ul.innerHTML = list.map(f => {
    const sizeMB = (f.size / 1024 / 1024).toFixed(1);
    const name   = f.name.replace('op25_', '').replace('.mp3', '').replace(/_/g, ' ');
    return `
      <li class="rec-item">
        <span class="rec-item-name" title="${f.name}">${name}</span>
        <span class="rec-item-size">${sizeMB} MB</span>
        <a class="rec-dl-btn" href="/api/record/download/${encodeURIComponent(f.name)}" download="${f.name}">↓</a>
        <button class="rec-del-btn" data-file="${f.name}" title="Delete">✕</button>
      </li>`;
  }).join('');

  ul.querySelectorAll('.rec-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete ${btn.dataset.file}?`)) return;
      await fetch(`/api/record/${encodeURIComponent(btn.dataset.file)}`, { method: 'DELETE' });
      refreshStatus();
    });
  });
}

// Restart buttons
document.querySelectorAll('.restart-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const svc = btn.dataset.svc;
    btn.disabled = true;
    btn.classList.add('restarting');
    btn.textContent = '…';

    await apiPost(`/api/services/${svc}/restart`);

    if (svc === 'op25-web') {
      // Restarting our own server — reload after delay
      btn.textContent = 'Reconnecting';
      setTimeout(() => location.reload(), 4000);
    } else {
      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('restarting');
        btn.textContent = 'Restart';
        refreshStatus();
      }, 3000);
    }
  });
});

// ── Groups tab ────────────────────────────────────────────────────────────────
let allTalkgroups = [];   // full list from OP25
let tgSearchQuery  = '';

const tgSearchEl = $('tg-search');
const tgListEl   = $('tg-list');
const groupsMeta = $('groups-meta');

tgSearchEl.addEventListener('input', () => {
  tgSearchQuery = tgSearchEl.value.trim().toLowerCase();
  renderTgList();
});

async function refreshTgList() {
  // Only fetch from server if the tab is visible or list is empty
  try {
    const r = await fetch('/api/talkgroups');
    if (r.ok) {
      allTalkgroups = await r.json();
    }
  } catch (_) {}
  renderTgList();
}

function renderTgList() {
  const filtered = tgSearchQuery
    ? allTalkgroups.filter(tg =>
        String(tg.tgid).includes(tgSearchQuery) ||
        (tg.tag || '').toLowerCase().includes(tgSearchQuery)
      )
    : allTalkgroups;

  const total   = allTalkgroups.length;
  const showing = filtered.length;
  groupsMeta.textContent = tgSearchQuery
    ? `${showing} of ${total} talkgroup${total !== 1 ? 's' : ''}`
    : `${total} talkgroup${total !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    tgListEl.innerHTML = `<li class="call-item-empty">${total ? 'No matches' : 'No talkgroups — OP25 not connected'}</li>`;
    return;
  }

  const speakerOnSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  const speakerOffSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  const lockoutOffSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;

  tgListEl.innerHTML = filtered.map(tg => {
    const muted   = isMuted(tg.tgid);
    const locked  = isLockedOut(tg.tgid);
    const active  = currentCall && currentCall.tgid === tg.tgid;
    const classes = ['tg-item', active ? 'is-active' : '', muted ? 'is-muted' : '', locked ? 'is-lockedout' : ''].filter(Boolean).join(' ');
    return `
      <li class="${classes}" data-tgid="${tg.tgid}" data-tag="${tg.tag || ''}">
        <span class="tg-active-dot"></span>
        <span class="tg-tgid">${tg.tgid}</span>
        <span class="tg-name">${tg.tag || 'Unknown'}</span>
        <div class="tg-actions">
          <button class="tg-action-btn tg-mute-btn${muted ? ' mute-on' : ''}"
            data-tgid="${tg.tgid}" data-tag="${tg.tag || ''}"
            title="${muted ? 'Unmute' : 'Mute'}">
            ${muted ? speakerOffSvg : speakerOnSvg}
          </button>
          <button class="tg-action-btn tg-lockout-btn${locked ? ' lockout-on' : ''}"
            data-tgid="${tg.tgid}" data-tag="${tg.tag || ''}"
            title="${locked ? 'Remove lockout' : 'Lockout'}">
            ${lockoutOffSvg}
          </button>
        </div>
      </li>`;
  }).join('');

  tgListEl.querySelectorAll('.tg-mute-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleMute(btn.dataset.tgid, btn.dataset.tag);
    });
  });

  tgListEl.querySelectorAll('.tg-lockout-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleLockout(btn.dataset.tgid, btn.dataset.tag);
    });
  });
}

// Keep active dot in sync without full re-render
function updateTgActiveState(tgid) {
  tgListEl.querySelectorAll('.tg-item').forEach(el => {
    const active = Number(el.dataset.tgid) === Number(tgid);
    el.classList.toggle('is-active', active);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
connectWS();
