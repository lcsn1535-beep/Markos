'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const state = {
  loginMode: 'chat', user: null, aiReady: false, setupAccounts: null,
  messages: [], sessions: [], activeSessionId: null, adminFilter: 'all', adminData: null,
  mediaStream: null, currentScreenshot: null, sending: false
};

function setHidden(element, hidden) { element?.classList.toggle('hidden', Boolean(hidden)); }
function escapeText(value) { return String(value ?? ''); }
function getHistoryKey() { return `marko.history.${state.user?.mode || 'chat'}.${state.user?.id || 'guest'}`; }
function makeSessionId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function newSession() { return { id: makeSessionId(), title: 'Neuer Chat', messages: [], updatedAt: Date.now() }; }

async function api(url, options = {}) {
  const request = { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(url, request);
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `Anfrage fehlgeschlagen (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  $('#toast-region').appendChild(toast);
  window.setTimeout(() => toast.remove(), 4400);
}

function showAuthScreen(screen) {
  setHidden($('#boot-screen'), true);
  setHidden($('#setup-screen'), screen !== 'setup');
  setHidden($('#login-screen'), screen !== 'login');
  setHidden($('#app-shell'), true);
  if (screen === 'login') updateLoginMode();
}

async function initialize() {
  try {
    const result = await api('/api/status');
    if (result.setupRequired) showAuthScreen('setup');
    else {
      showAuthScreen('login');
      try {
        const me = await api('/api/me');
        state.user = me.user;
        state.aiReady = me.aiReady;
        enterApp();
      } catch (error) {
        if (error.status !== 401) showToast(error.message, 'error');
      }
    }
  } catch (error) {
    setHidden($('#boot-screen'), true);
    showAuthScreen('login');
    $('#login-error').textContent = `Marko konnte den Server nicht erreichen: ${error.message}`;
    setHidden($('#login-error'), false);
  }
}

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#setup-button');
  const errorBox = $('#setup-error');
  const token = $('#setup-token').value;
  setHidden(errorBox, true);
  button.disabled = true;
  button.innerHTML = '<span>Konten werden sicher erstellt …</span><span aria-hidden="true">◌</span>';
  try {
    const result = await api('/api/setup/initialize', { method: 'POST', body: JSON.stringify({ token }) });
    state.setupAccounts = result.accounts;
    $('#credentials-result').classList.remove('hidden');
    $('#setup-form').classList.add('hidden');
    $('#setup-heading').textContent = 'Deine Konten sind bereit.';
    $('.auth-panel-inner > .muted').textContent = result.message;
    $('#setup-token').value = '';
    showToast('20 Konten wurden erstellt. Sichere die Datei jetzt.', 'success');
  } catch (error) {
    errorBox.textContent = error.message;
    setHidden(errorBox, false);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>20 Konten sicher erstellen</span><span aria-hidden="true">↗</span>';
  }
});

$('#download-credentials').addEventListener('click', () => {
  if (!state.setupAccounts?.length) return;
  const lines = [
    'MARKO AI — PRIVATE ZUGANGSDATEN',
    '================================',
    'WICHTIG: Diese Datei NICHT in GitHub hochladen oder öffentlich teilen.',
    'Die Passwörter werden in der Datenbank nur als Hash gespeichert.',
    'Du kannst Passwörter später im Admin-Panel neu setzen.',
    '',
    'CHAT-MODUS (marko.ai Login)',
    '---------------------------'
  ];
  for (const account of state.setupAccounts.filter(a => a.mode === 'chat')) {
    lines.push(`${account.username}${account.role === 'admin' ? ' [ADMIN]' : ''}`, `Passwort: ${account.password}`, '');
  }
  lines.push('BILDSCHIRM-MODUS (separater Login)', '----------------------------------');
  for (const account of state.setupAccounts.filter(a => a.mode === 'screen')) {
    lines.push(account.username, `Passwort: ${account.password}`, '');
  }
  lines.push('Sicherheitshinweis: Speichere diese Datei in einem Passwortmanager und lösche unnötige Kopien.');
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'MARKO-PRIVATE-ZUGANGSDATEN.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  $('#credentials-reminder').textContent = 'Datei gespeichert. Lade sie auf keinen Fall bei GitHub hoch.';
});
$('#continue-to-login').addEventListener('click', () => {
  state.setupAccounts = null;
  state.loginMode = 'chat';
  showAuthScreen('login');
});

function updateLoginMode() {
  const screen = state.loginMode === 'screen';
  $('#login-mode-label').textContent = screen ? 'SEPARATER BILDSCHIRM-ZUGANG' : 'SICHERER CHAT-ZUGANG';
  $('#login-heading').textContent = screen ? 'Screen AI wartet auf dich.' : 'Schön, dass du da bist.';
  $('#login-subtitle').textContent = screen
    ? 'Melde dich mit deinen separaten Bildschirm-Zugangsdaten an.'
    : 'Melde dich an und mach aus deinen Ideen etwas Großes.';
  $('#mode-switch-title').textContent = screen ? 'Du möchtest nur chatten?' : 'Du möchtest deinen Bildschirm nutzen?';
  $('#mode-switch-description').textContent = screen
    ? 'Der normale KI-Chat nutzt ein separates Konto.'
    : 'Der Screen-Modus nutzt separate Zugangsdaten und deine ausdrückliche Freigabe.';
  $('#switch-login-mode').innerHTML = screen ? 'Zum normalen Chat <span>→</span>' : 'Zum Bildschirm-Modus <span>→</span>';
  $('#login-username').value = '';
  $('#login-password').value = '';
  setHidden($('#login-error'), true);
}
$('#switch-login-mode').addEventListener('click', () => {
  state.loginMode = state.loginMode === 'chat' ? 'screen' : 'chat';
  updateLoginMode();
});
$('#toggle-password').addEventListener('click', () => {
  const field = $('#login-password');
  field.type = field.type === 'password' ? 'text' : 'password';
  $('#toggle-password').setAttribute('aria-label', field.type === 'password' ? 'Passwort anzeigen' : 'Passwort verbergen');
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-button');
  const errorBox = $('#login-error');
  setHidden(errorBox, true);
  button.disabled = true;
  button.innerHTML = '<span>Anmeldung läuft …</span><span aria-hidden="true">◌</span>';
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#login-username').value.trim(), password: $('#login-password').value, mode: state.loginMode })
    });
    state.user = result.user;
    try { state.aiReady = (await api('/api/me')).aiReady; } catch { state.aiReady = false; }
    enterApp();
  } catch (error) {
    errorBox.textContent = error.message;
    setHidden(errorBox, false);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>Anmelden</span><span aria-hidden="true">↗</span>';
  }
});

function loadLocalHistory() {
  try {
    const raw = localStorage.getItem(getHistoryKey());
    state.sessions = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.sessions)) state.sessions = [];
  } catch { state.sessions = []; }
  state.sessions = state.sessions.filter(session => session && typeof session.id === 'string' && Array.isArray(session.messages));
  state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!state.sessions.length) state.sessions.push(newSession());
  const selected = state.sessions.find(session => session.id === state.activeSessionId) || state.sessions[0];
  state.activeSessionId = selected.id;
  state.messages = selected.messages.map(message => ({ role: message.role, content: message.content }));
  persistHistory();
}
function activeSession() { return state.sessions.find(session => session.id === state.activeSessionId); }
function persistHistory() {
  try {
    state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.sessions = state.sessions.slice(0, 35);
    localStorage.setItem(getHistoryKey(), JSON.stringify(state.sessions));
  } catch { /* Browsers can disable localStorage; chat remains usable in memory. */ }
  renderHistoryList();
}
function updateActiveSession() {
  const current = activeSession();
  if (!current) return;
  current.messages = state.messages.map(message => ({ role: message.role, content: message.content }));
  current.updatedAt = Date.now();
  const firstUser = current.messages.find(message => message.role === 'user');
  if (firstUser) current.title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 38) || 'Neuer Chat';
  persistHistory();
}
function renderHistoryList() {
  const container = $('#history-list');
  container.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = 'Deine Unterhaltungen erscheinen hier.'; container.appendChild(empty); return;
  }
  for (const item of state.sessions) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `history-item${item.id === state.activeSessionId ? ' active' : ''}`;
    const icon = document.createElement('span'); icon.textContent = '◷';
    const title = document.createElement('span'); title.className = 'history-title'; title.textContent = item.title || 'Neuer Chat';
    button.append(icon, title);
    button.addEventListener('click', () => {
      state.activeSessionId = item.id;
      state.messages = item.messages.map(message => ({ role: message.role, content: message.content }));
      renderMessages(); renderHistoryList(); closeSidebarMobile();
    });
    container.appendChild(button);
  }
}
function renderMessages() {
  const messages = $('#messages');
  messages.replaceChildren();
  const hasMessages = state.messages.length > 0;
  setHidden($('#welcome-state'), hasMessages);
  setHidden(messages, !hasMessages);
  if (hasMessages) {
    for (const message of state.messages) messages.appendChild(createMessageNode(message));
  }
  requestAnimationFrame(() => { $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; });
}
function createMessageNode(message) {
  const row = document.createElement('article'); row.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
  const avatar = document.createElement('div'); avatar.className = message.role === 'user' ? 'user-avatar' : 'assistant-avatar';
  if (message.role === 'user') avatar.textContent = (state.user?.username || 'U').slice(0, 1).toUpperCase();
  else { avatar.append(document.createTextNode('M')); const star = document.createElement('span'); star.textContent = '✦'; avatar.appendChild(star); }
  const body = document.createElement('div'); body.className = 'message-body';
  const author = document.createElement('div'); author.className = 'message-author'; author.textContent = message.role === 'user' ? 'Du' : 'Marko AI';
  const text = document.createElement('div'); text.className = 'message-text'; text.textContent = message.content;
  body.append(author, text);
  row.append(avatar, body);
  return row;
}
function enterApp() {
  setHidden($('#boot-screen'), true); setHidden($('#setup-screen'), true); setHidden($('#login-screen'), true); setHidden($('#app-shell'), false);
  const screenMode = state.user.mode === 'screen';
  $('#app-shell').classList.toggle('screen-mode', screenMode);
  $('#sidebar-username').textContent = state.user.username;
  $('#sidebar-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  $('#sidebar-role').textContent = state.user.role === 'admin' ? 'Administrator' : screenMode ? 'Screen-Mitglied' : 'Mitglied';
  setHidden($('#admin-open'), !(state.user.role === 'admin' && !screenMode));
  setHidden($('#ai-warning'), state.aiReady);
  $('#topbar-context').textContent = screenMode ? 'Bildschirm-Modus' : 'KI-Chat';
  $('#model-chip-label').textContent = screenMode ? 'SCREEN AI' : 'MARKO AI';
  $('#top-mode-label').textContent = screenMode ? 'Zum Chat-Modus' : 'Bildschirm-Modus';
  $('#footer-mode').textContent = screenMode ? 'SCREEN ACCESS · USER CONTROLLED' : 'PERSONAL WORKSPACE';
  setHidden($('#nav-chat'), screenMode); setHidden($('#new-chat'), screenMode); setHidden($('.history-label'), screenMode); setHidden($('#history-list'), screenMode); setHidden($('.plan-card'), screenMode);
  $('#nav-chat').classList.toggle('active', !screenMode); $('#nav-screen').classList.toggle('active', screenMode);
  setHidden($('#chat-view'), screenMode); setHidden($('#screen-view'), !screenMode);
  state.messages = [];
  if (screenMode) {
    clearScreenMessages(); stopScreenShare();
  } else {
    loadLocalHistory(); renderMessages();
  }
}

function appendMessage(role, content) {
  state.messages.push({ role, content });
  renderMessages();
  updateActiveSession();
}
async function sendChatMessage(rawText) {
  const content = String(rawText || '').trim();
  if (!content || state.sending) return;
  if (!state.aiReady) { showToast('Die KI ist noch nicht verbunden. Der Admin muss OPENAI_API_KEY setzen.', 'error'); return; }
  state.sending = true;
  $('#chat-input').value = ''; autoResize($('#chat-input'));
  appendMessage('user', content);
  setHidden($('#typing-indicator'), false); $('#send-button').disabled = true;
  $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
  try {
    const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: state.messages.slice(-20) }) });
    appendMessage('assistant', result.answer);
  } catch (error) {
    appendMessage('assistant', `Entschuldigung, die Anfrage ist fehlgeschlagen: ${error.message}`);
  } finally {
    state.sending = false; $('#send-button').disabled = false; setHidden($('#typing-indicator'), true);
  }
}
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); sendChatMessage($('#chat-input').value); });
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chat-form').requestSubmit(); }
  autoResize(event.target);
});
function autoResize(textarea) { if (!textarea) return; textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`; }
$$('.suggestion-card').forEach(button => button.addEventListener('click', () => {
  $('#chat-input').value = button.dataset.prompt || ''; autoResize($('#chat-input')); $('#chat-input').focus(); $('#chat-form').requestSubmit();
}));
$('#new-chat').addEventListener('click', () => {
  const newOne = newSession(); state.sessions.unshift(newOne); state.activeSessionId = newOne.id; state.messages = []; updateActiveSession(); renderMessages(); $('#chat-input').focus(); closeSidebarMobile();
});
$('#clear-history').addEventListener('click', () => {
  if (!window.confirm('Alle lokalen Chats für diesen Account in diesem Browser löschen?')) return;
  state.sessions = [newSession()]; state.activeSessionId = state.sessions[0].id; state.messages = [];
  try { localStorage.removeItem(getHistoryKey()); } catch {}
  persistHistory(); renderMessages(); showToast('Lokale Chatliste gelöscht.', 'success');
});

function showScreenLogin() {
  logoutAndShow('screen');
}
function showChatLogin() {
  logoutAndShow('chat');
}
async function logoutAndShow(mode) {
  stopScreenShare();
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  state.user = null; state.messages = []; state.loginMode = mode;
  showAuthScreen('login');
}
$('#top-mode-toggle').addEventListener('click', () => {
  if (state.user?.mode === 'screen') showChatLogin(); else showScreenLogin();
});
$('#nav-screen').addEventListener('click', () => {
  closeSidebarMobile();
  if (state.user?.mode === 'screen') { setHidden($('#chat-view'), true); setHidden($('#screen-view'), false); return; }
  showScreenLogin();
});
$('#nav-chat').addEventListener('click', () => {
  closeSidebarMobile();
  if (state.user?.mode === 'screen') { showToast('Für den normalen Chat brauchst du ein Chat-Konto.', 'error'); return; }
  setHidden($('#screen-view'), true); setHidden($('#chat-view'), false); $('#topbar-context').textContent = 'KI-Chat'; $('#nav-chat').classList.add('active'); $('#nav-screen').classList.remove('active');
});
$('#logout-button').addEventListener('click', async () => { const nextMode = state.user?.mode || 'chat'; await logoutAndShow(nextMode); });
$('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#close-sidebar').addEventListener('click', closeSidebarMobile);
function closeSidebarMobile() { $('#sidebar').classList.remove('open'); }

// Screen share is intentionally user-initiated. A frame is captured and sent only on form submit.
$('#start-share').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) { showToast('Diese Browser-Umgebung unterstützt keine Bildschirmfreigabe. Nutze einen aktuellen Browser über HTTPS.', 'error'); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    state.mediaStream = stream;
    const video = $('#screen-video'); video.srcObject = stream;
    await video.play();
    setHidden(video, false); setHidden($('#screen-placeholder'), true); setHidden($('#start-share'), true); setHidden($('#stop-share'), false);
    $('#share-state').classList.add('active'); $('#share-state').innerHTML = '<i></i> Freigegeben';
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => stopScreenShare(), { once: true }));
    showToast('Bildschirmfreigabe aktiv. Nichts wird gesendet, bis du eine Frage abschickst.', 'success');
  } catch (error) {
    if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') showToast(`Bildschirmfreigabe nicht möglich: ${error.message}`, 'error');
  }
});
$('#stop-share').addEventListener('click', () => { stopScreenShare(); showToast('Bildschirmfreigabe beendet.'); });
function stopScreenShare() {
  if (state.mediaStream) state.mediaStream.getTracks().forEach(track => track.stop());
  state.mediaStream = null;
  const video = $('#screen-video');
  if (video) { video.pause(); video.srcObject = null; setHidden(video, true); }
  if ($('#screen-placeholder')) setHidden($('#screen-placeholder'), false);
  if ($('#start-share')) setHidden($('#start-share'), false);
  if ($('#stop-share')) setHidden($('#stop-share'), true);
  if ($('#share-state')) { $('#share-state').classList.remove('active'); $('#share-state').innerHTML = '<i></i> Nicht geteilt'; }
}
function captureScreenFrame() {
  const video = $('#screen-video');
  if (!state.mediaStream || !video || !video.videoWidth || !video.videoHeight) return null;
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}
function clearScreenMessages() {
  const container = $('#screen-messages'); container.replaceChildren();
  const empty = document.createElement('div'); empty.className = 'screen-empty-message';
  const icon = document.createElement('span'); icon.textContent = '✧';
  const text = document.createElement('p'); text.textContent = 'Zum Beispiel: „Was muss ich hier anklicken?“ oder „Erkläre mir diesen Fehler.“';
  empty.append(icon, text); container.appendChild(empty);
}
function addScreenMessage(role, text) {
  const container = $('#screen-messages');
  const empty = container.querySelector('.screen-empty-message'); if (empty) empty.remove();
  const box = document.createElement('div'); box.className = `screen-message${role === 'user' ? ' user-screen-message' : ''}`;
  const who = document.createElement('div'); who.className = 'screen-message-role'; who.textContent = role === 'user' ? 'DU' : 'MARKO AI';
  const content = document.createElement('p'); content.textContent = text;
  box.append(who, content); container.appendChild(box); container.scrollTop = container.scrollHeight;
}
$('#screen-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#screen-input').value.trim();
  if (!text) { showToast('Schreib zuerst eine Frage an Marko.', 'error'); return; }
  if (!state.aiReady) { showToast('Die KI ist noch nicht verbunden. Der Admin muss OPENAI_API_KEY setzen.', 'error'); return; }
  let screenshot = null;
  if ($('#include-screenshot').checked) {
    screenshot = captureScreenFrame();
    if (!screenshot) { showToast('Gib erst deinen Bildschirm frei oder entferne das Häkchen bei „Screenshot mitsenden“.', 'error'); return; }
  }
  $('#screen-input').value = ''; $('#screen-send-button').disabled = true;
  addScreenMessage('user', text + (screenshot ? '\n[Screenshot wird einmalig mitgesendet]' : ''));
  addScreenMessage('assistant', 'Marko denkt nach …');
  const screenHistory = Array.from($('#screen-messages').querySelectorAll('.screen-message')).slice(0, -2).slice(-18).map((node) => {
    const isUser = node.classList.contains('user-screen-message');
    const paragraph = node.querySelector('p')?.textContent || '';
    return { role: isUser ? 'user' : 'assistant', content: paragraph };
  });
  // The last two UI entries are the just-sent user message and temporary loading response.
  try {
    const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [...screenHistory, { role: 'user', content: text }].slice(-20), ...(screenshot ? { screenshot } : {}) }) });
    const messages = $('#screen-messages');
    const lastAssistant = Array.from(messages.querySelectorAll('.screen-message')).reverse().find(node => !node.classList.contains('user-screen-message'));
    if (lastAssistant?.querySelector('p')) lastAssistant.querySelector('p').textContent = result.answer;
    else addScreenMessage('assistant', result.answer);
  } catch (error) {
    const messages = $('#screen-messages');
    const lastAssistant = Array.from(messages.querySelectorAll('.screen-message')).reverse().find(node => !node.classList.contains('user-screen-message'));
    if (lastAssistant?.querySelector('p')) lastAssistant.querySelector('p').textContent = `Anfrage fehlgeschlagen: ${error.message}`;
    else addScreenMessage('assistant', `Anfrage fehlgeschlagen: ${error.message}`);
  } finally { $('#screen-send-button').disabled = false; }
});

// Admin panel
$('#admin-open').addEventListener('click', () => openModal('admin-modal'));
$('#admin-refresh').addEventListener('click', loadAdminPanel);
$$('[data-admin-filter]').forEach(button => button.addEventListener('click', () => {
  state.adminFilter = button.dataset.adminFilter;
  $$('[data-admin-filter]').forEach(tab => tab.classList.toggle('active', tab === button));
  renderAdminUsers();
}));
async function loadAdminPanel() {
  try {
    state.adminData = await api('/api/admin/users');
    renderAdminSummary(); renderAdminUsers(); renderAudit();
    setHidden($('#admin-notice'), true);
  } catch (error) { showAdminNotice(error.message); }
}
function openModal(modalId) {
  setHidden($('#modal-backdrop'), false);
  $$('.modal-panel').forEach(panel => setHidden(panel, panel.id !== modalId));
  if (modalId === 'admin-modal') loadAdminPanel();
  const firstInput = $(`#${modalId} input`); if (firstInput) window.setTimeout(() => firstInput.focus(), 50);
}
function closeModal() { setHidden($('#modal-backdrop'), true); $$('.modal-panel').forEach(panel => setHidden(panel, true)); }
$$('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
$('#modal-backdrop').addEventListener('click', event => { if (event.target === $('#modal-backdrop')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal(); });
function showAdminNotice(message) { const box = $('#admin-notice'); box.textContent = message; setHidden(box, false); }
function renderAdminSummary() {
  const summary = state.adminData?.summary; if (!summary) return;
  const cards = [ ['Konten gesamt', summary.total], ['Chat-Konten', summary.chat], ['Screen-Konten', summary.screen], ['Deaktiviert', summary.disabled] ];
  const holder = $('#admin-summary'); holder.replaceChildren();
  for (const [label, number] of cards) {
    const card = document.createElement('div'); card.className = 'summary-stat';
    const span = document.createElement('span'); span.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = number;
    card.append(span, strong); holder.appendChild(card);
  }
}
function renderAdminUsers() {
  const holder = $('#admin-users'); holder.replaceChildren();
  const users = (state.adminData?.users || []).filter(user => state.adminFilter === 'all' || user.mode === state.adminFilter);
  if (!users.length) { const empty = document.createElement('div'); empty.className = 'admin-empty'; empty.textContent = 'Keine Konten für diesen Filter.'; holder.appendChild(empty); return; }
  for (const user of users) {
    const row = document.createElement('div'); row.className = 'admin-user-row';
    const identity = document.createElement('div'); identity.className = 'admin-user-name';
    const avatar = document.createElement('div'); avatar.className = 'avatar-small'; avatar.textContent = user.username.slice(0, 1).toUpperCase();
    const words = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = user.username;
    const meta = document.createElement('small'); meta.textContent = user.lastLogin ? `Zuletzt aktiv: ${new Date(user.lastLogin).toLocaleDateString('de-DE')}` : 'Noch kein Login';
    words.append(name, meta); identity.append(avatar, words);
    const mode = document.createElement('span'); mode.className = `mode-pill ${user.mode}`; mode.textContent = user.mode === 'chat' ? 'Chat' : 'Screen';
    const role = document.createElement('span'); role.className = `role-pill ${user.role === 'admin' ? 'admin' : ''}`; role.textContent = user.role === 'admin' ? 'Admin' : 'Mitglied';
    const active = document.createElement('span'); active.className = `active-pill${user.isActive ? '' : ' disabled'}`; active.textContent = user.isActive ? 'Aktiv' : 'Aus';
    const actions = document.createElement('div'); actions.className = 'admin-user-actions';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'admin-action'; reset.textContent = '↻ Passwort'; reset.addEventListener('click', () => resetUserPassword(user));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = `admin-action${user.isActive ? ' danger' : ''}`; toggle.textContent = user.isActive ? 'Sperren' : 'Aktivieren'; toggle.addEventListener('click', () => toggleUserStatus(user));
    actions.append(reset, toggle); row.append(identity, mode, role, active, actions); holder.appendChild(row);
  }
}
function renderAudit() {
  const holder = $('#audit-list'); holder.replaceChildren();
  const events = state.adminData?.events || [];
  if (!events.length) { const empty = document.createElement('div'); empty.className = 'admin-empty'; empty.textContent = 'Noch keine Aktivitäten protokolliert.'; holder.appendChild(empty); return; }
  for (const event of events) {
    const row = document.createElement('div'); row.className = 'audit-row';
    const detail = document.createElement('span');
    const who = document.createElement('strong'); who.textContent = event.actor || 'System';
    detail.append(who, document.createTextNode(` · ${auditActionLabel(event.action)}${event.target ? ` · ${event.target}` : ''}`));
    const date = document.createElement('span'); date.textContent = new Date(event.created_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    row.append(detail, date); holder.appendChild(row);
  }
}
function auditActionLabel(action) {
  const labels = { initial_setup: 'Ersteinrichtung', login: 'Login', logout: 'Logout', change_password: 'Passwort geändert', account_enabled: 'Konto aktiviert', account_disabled: 'Konto gesperrt', password_reset: 'Passwort zurückgesetzt' };
  return labels[action] || action;
}
async function toggleUserStatus(user) {
  const verb = user.isActive ? 'sperren' : 'aktivieren';
  if (!window.confirm(`Konto „${user.username}“ wirklich ${verb}?`)) return;
  try {
    await api(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify({ active: !user.isActive }) });
    showToast(`Konto ${user.isActive ? 'gesperrt' : 'aktiviert'}.`, 'success');
    await loadAdminPanel();
  } catch (error) { showAdminNotice(error.message); }
}
async function resetUserPassword(user) {
  if (!window.confirm(`Neues Passwort für „${user.username}“ erstellen? Das aktuelle Passwort wird dadurch ungültig.`)) return;
  try {
    const result = await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: '{}' });
    $('#reset-title').textContent = `Passwort: ${result.username}`;
    $('#reset-description').textContent = `${result.mode === 'chat' ? 'Chat-Modus' : 'Bildschirm-Modus'} · Dieses Passwort wird nur jetzt angezeigt.`;
    $('#reset-password-value').value = result.password;
    openModal('reset-modal');
    await loadAdminPanel();
  } catch (error) { showAdminNotice(error.message); }
}
$('#copy-reset-password').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#reset-password-value').value); showToast('Passwort kopiert. Übergib es sicher.', 'success'); }
  catch { $('#reset-password-value').select(); document.execCommand('copy'); showToast('Passwort kopiert.', 'success'); }
});

// Self-service password change
$('#change-password-open').addEventListener('click', () => openModal('password-modal'));
$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#password-message'); setHidden(message, true);
  const currentPassword = $('#current-password').value;
  const newPassword = $('#new-password').value;
  const confirmPassword = $('#confirm-password').value;
  if (newPassword !== confirmPassword) { message.textContent = 'Die beiden neuen Passwörter stimmen nicht überein.'; setHidden(message, false); return; }
  const button = $('#password-submit'); button.disabled = true;
  try {
    const result = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    closeModal(); $('#password-form').reset(); showToast(result.message, 'success');
  } catch (error) { message.textContent = error.message; setHidden(message, false); }
  finally { button.disabled = false; }
});

// If the user navigates away, release the browser-level screen capture promptly.
window.addEventListener('beforeunload', stopScreenShare);
initialize();
