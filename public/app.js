// AgentDeck UI: sidebar, terminal grid and dialogs.
// Talks to server.js over /api (JSON) and one WebSocket per terminal pane.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const ROLES = {
  Builder: 'Build the features and fixes you are given. Keep changes small and focused, and commit when each piece works.',
  Reviewer: "Review the other agents' branches for bugs, security problems and unclear code. Give concrete fixes; don't rewrite their work yourself.",
  Tester: 'Write and run tests. When something fails, report the exact steps, the expected result and the actual result.',
  Lead: 'Run the team: turn my goals into cards, hand them to the other agents, follow up as they finish, and keep me posted.',
  Custom: '',
};
const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const STATUS = { working: 'Working', needs: 'Needs you', done: 'Finished', ready: 'Ready', stopped: 'Stopped' };
const THEME = {
  background: '#0e1117', foreground: '#d4d7e0', cursor: '#e7e9ef', cursorAccent: '#0e1117',
  selectionBackground: '#3b3366', black: '#1b1f2a', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d7e0', brightBlack: '#5d6477',
  brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#93c5fd',
  brightMagenta: '#e9d5ff', brightCyan: '#67e8f9', brightWhite: '#ffffff',
};

let state = null;
const panes = new Map(); // agent id -> Pane
let maxed = null;        // agent id shown full size, or null
let sideSig = '';

// ------------------------------------------------------------------ server calls

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AgentDeck': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let bootId = null;

async function refresh() {
  try {
    state = await call('GET', '/api/state');
  } catch {
    return; // server restarting; try again on the next tick
  }
  // AgentDeck was restarted (maybe updated): load the new page code. Terminals reconnect by themselves.
  // (Waits while a dialog is open, so nothing you're typing is lost.)
  if (bootId && state.bootId !== bootId) {
    if ($('#modal').hidden) return location.reload();
  } else {
    bootId = state.bootId;
  }
  render();
  checkAlerts();
}

// ------------------------------------------------------------------ alerts

const seenStatus = new Map(); // agent id -> last status
const seenCards = new Map();  // card id -> last column
let alertsPrimed = false;     // no alerts for what was already true when the page opened
let audio = null;

function checkAlerts() {
  const events = [];
  for (const p of state.projects) {
    for (const a of p.agents) {
      const st = statusOf(a);
      if (alertsPrimed && st === 'needs' && seenStatus.get(a.id) !== 'needs') {
        events.push({ title: `${a.name} needs you`, body: a.session.note || 'It is waiting for your answer in its pane.', project: p, agent: a, urgent: true });
      }
      seenStatus.set(a.id, st);
    }
    for (const c of p.cards || []) {
      if (alertsPrimed && seenCards.get(c.id) === 'progress' && c.column === 'review' && c.finishedAt) {
        const a = p.agents.find((x) => x.id === c.agentId);
        events.push({ title: `${a ? a.name : 'An agent'} finished: ${c.title}`, body: plain(c.summary || 'The card moved to Review.').slice(0, 180), project: p, agent: a });
      }
      seenCards.set(c.id, c.column);
    }
  }
  alertsPrimed = true;
  events.forEach(notifyUser);
  renderAlertsRow();
}

function notifyUser(ev) {
  const away = document.hidden || !document.hasFocus();
  if (ev.urgent || away) chime(ev.urgent);
  if (away && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(ev.title, { body: ev.body, icon: '/icon.png', tag: ev.agent ? `${ev.agent.id}:${ev.urgent}` : ev.title });
    n.onclick = () => { window.focus(); openAgent(ev.project, ev.agent); n.close(); };
  } else if (!away) {
    toast(`${ev.title}${ev.urgent ? `: ${ev.body}` : ''}`, false, 6000);
  }
}

function chime(urgent) {
  try {
    audio = audio || new AudioContext();
    audio.resume();
    (urgent ? [880, 660] : [660, 880]).forEach((freq, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.14;
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.25);
    });
  } catch { /* no audio available */ }
}

function openAgent(p, agent) {
  if (p && p.id !== state.activeProject) {
    state.activeProject = p.id;
    clearPanes();
    $('#main').innerHTML = '';
    render();
    call('PUT', '/api/ui', { activeProject: p.id }).catch(() => {});
  }
  if (agent) focusAgent(agent.id);
}

function renderAlertsRow() {
  const row = $('#alertsRow');
  if (!('Notification' in window)) { row.hidden = true; return; }
  const perm = Notification.permission;
  const html = perm === 'granted' ? '<span class="dot ok"></span>Desktop alerts on'
    : perm === 'denied' ? '<span class="dot stopped"></span>Desktop alerts blocked in Chrome'
      : '<span class="dot lock"></span><button class="link" id="alertsOn">Turn on desktop alerts</button>';
  if (row.dataset.perm !== perm) {
    row.dataset.perm = perm;
    row.innerHTML = html;
    const b = $('#alertsOn');
    if (b) b.onclick = () => Notification.requestPermission().then(renderAlertsRow);
  }
}

const project = () => state?.projects.find((p) => p.id === state.activeProject);
const statusOf = (a) => a.session.display || 'stopped';

function initials(name) {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

function toast(msg, bad = false, ms = bad ? 7000 : 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ terminal pane

class Pane {
  constructor(agent) {
    this.id = agent.id;
    this.el = el(`<section class="pane">
      <div class="ph"><div class="av sm"></div><b></b><span class="meta"></span>
        <span class="sts"><span class="dot"></span><span class="stxt"></span></span>
        <button class="btn sm merge-btn" data-act="merge" title="Review and merge this agent's work" hidden></button>
        <button class="ib" data-act="max" title="Full size (or double-click the header)">⤢</button>
        <button class="ib" data-act="restart" title="Restart">↻</button>
        <button class="ib" data-act="menu" title="More">⋯</button></div>
      <div class="term"></div><div class="drop-hint"></div></section>`);
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.1,
      cursorBlink: true, scrollback: 5000, theme: THEME, allowProposedApi: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.onData((d) => this.send({ t: 'in', d }));
    this.el.addEventListener('mousedown', () => setFocused(this.id));
    $('.ph', this.el).addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(this.id); });
    $('[data-act=max]', this.el).onclick = () => toggleMax(this.id);
    $('[data-act=restart]', this.el).onclick = () => restartAgent(this.id, false);
    $('[data-act=merge]', this.el).onclick = () => reviewDialog(this.id);
    $('[data-act=menu]', this.el).onclick = (e) => paneMenu(this.agent, e.currentTarget);
    this.update(agent);
  }

  // Called once the pane is in the page, so the terminal can measure itself before output arrives.
  start() {
    this.term.open($('.term', this.el));
    this.fitNow();
    this.ro = new ResizeObserver(() => this.fitSoon());
    this.ro.observe($('.term', this.el));
    this.connect();
  }

  onKey(e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && k === 'c' && (e.shiftKey || this.term.hasSelection())) {
      const text = this.term.getSelection();
      if (text) navigator.clipboard.writeText(text).then(() => toast('Copied'));
      this.term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Let the browser paste. This is also how Whisper Push-to-Talk types into a pane.
    if (e.ctrlKey && !e.altKey && k === 'v') return false;
    // Shift+Enter = new line in Claude Code instead of sending.
    if (e.shiftKey && e.key === 'Enter') {
      this.send({ t: 'in', d: '\x1b\r' });
      e.preventDefault();
      return false;
    }
    return true;
  }

  connect() {
    this.ws = new WebSocket(`ws://${location.host}/ws?agent=${this.id}`);
    this.ws.onopen = () => {
      this.term.reset();
      this.sendSize();
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'out') this.term.write(m.d);
      else if (m.t === 'reset') this.term.reset();
    };
    this.ws.onclose = () => { if (!this.disposed) setTimeout(() => this.connect(), 1500); };
  }

  send(m) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  sendSize() {
    this.send({ t: 'resize', cols: this.term.cols, rows: this.term.rows });
  }

  fitNow() {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    try { this.fit.fit(); } catch { /* not measurable yet */ }
    this.sendSize();
  }

  fitSoon() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.fitNow());
  }

  update(agent) {
    this.agent = agent;
    this.el.style.setProperty('--c', agent.color);
    const av = $('.av', this.el);
    av.textContent = initials(agent.name);
    av.style.setProperty('--c', agent.color);
    $('b', this.el).textContent = agent.name;
    const what = agent.kind === 'shell' ? 'powershell' : `claude${agent.model ? ` · ${agent.model}` : ''}`;
    const where = agent.mode === 'worktree' ? agent.branch : agent.kind === 'shell' ? 'project folder' : `${agent.branch || 'main'} (main folder)`;
    $('.meta', this.el).innerHTML = `${agent.lead ? '<span class="badge lead">Lead</span> ' : ''}${esc(what)} <i>${esc(where)}</i>`;
    const hint = $('.drop-hint', this.el);
    hint.dataset.agent = agent.id;
    hint.dataset.kind = agent.kind;
    hint.innerHTML = agent.kind === 'claude' ? `<span>Give this task to <b>${esc(agent.name)}</b></span>` : '<span>A plain terminal can\'t take cards</span>';
    const st = statusOf(agent);
    const sts = $('.sts', this.el);
    sts.className = `sts ${st}`;
    sts.title = agent.session.note || '';
    $('.sts .dot', this.el).className = `dot ${st}`;
    $('.stxt', this.el).textContent = STATUS[st];
    this.el.classList.toggle('needs', st === 'needs');
    const mb = $('[data-act=merge]', this.el);
    mb.hidden = !agent.ahead;
    mb.textContent = `Merge ↑${agent.ahead || 0}`;
  }

  dispose() {
    this.disposed = true;
    this.ro?.disconnect();
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
  }
}

function setFocused(id) {
  for (const [pid, p] of panes) p.el.classList.toggle('focused', pid === id);
}

function focusAgent(id) {
  const p = panes.get(id);
  if (!p) return;
  if (maxed && maxed !== id) toggleMax(id);
  setFocused(id);
  p.el.classList.remove('flash');
  void p.el.offsetWidth; // restart the flash animation
  p.el.classList.add('flash');
  p.term.focus();
}

function toggleMax(id) {
  maxed = maxed === id ? null : id;
  layout();
  panes.get(id)?.term.focus();
}

// ------------------------------------------------------------------ render

function render() {
  renderTop();
  renderSide();
  renderMain();
}

function renderTop() {
  const p = project();
  const agents = p?.agents || [];
  const working = agents.filter((a) => statusOf(a) === 'working').length;
  const needs = agents.filter((a) => statusOf(a) === 'needs').length;
  $('#crumbs').innerHTML = p
    ? `<span class="name">${esc(p.name)}</span>
       ${p.git.isGit && p.git.branch ? `<span class="chip mono">⎇ ${esc(p.git.branch)}</span>` : '<span class="chip">no git</span>'}
       <span class="chip">${agents.length} / 16 agents</span>
       ${working ? `<span class="chip good"><span class="dot working"></span>${working} working</span>` : ''}
       ${needs ? `<button class="chip warn" id="needsChip" title="Show the agent that needs you"><span class="dot needs"></span>${needs} need${needs === 1 ? 's' : ''} you</button>` : ''}`
    : '';
  // Count of agents waiting on you, across all projects, in the window title (shows on the taskbar).
  const waiting = state.projects.reduce((n, x) => n + x.agents.filter((a) => statusOf(a) === 'needs').length, 0);
  document.title = waiting ? `(${waiting}) AgentDeck` : 'AgentDeck';
  $('#addAgent').disabled = $('#addShell').disabled = !p || !p.exists;
  const cols = state.columns;
  const seg = $('#columns');
  if (seg.dataset.cols !== cols) {
    seg.dataset.cols = cols;
    seg.innerHTML = ['auto', '1', '2', '3', '4']
      .map((c) => `<button data-c="${c}" class="${c === cols ? 'on' : ''}">${c === 'auto' ? 'Auto' : c}</button>`).join('');
  }
}

function renderSide() {
  const p = project();
  const sig = JSON.stringify([state.activeProject, state.projects.map((x) => [x.id, x.name, x.agents.length]),
    p?.agents.map((a) => [a.id, a.name, a.color, a.model, a.branch, a.kind, a.lead])]);
  if (sig !== sideSig) {
    sideSig = sig;
    $('#projects').innerHTML = state.projects.length
      ? state.projects.map((x) => `<button class="proj ${x.id === state.activeProject ? 'on' : ''}" data-id="${x.id}" title="${esc(x.path)}&#10;Right-click to remove from AgentDeck">
          <span class="sq"></span><span class="nm">${esc(x.name)}</span><span class="ct">${x.agents.length || ''}</span></button>`).join('')
      : '<div class="empty-side">No projects yet</div>';
    $('#agents').innerHTML = p?.agents.length
      ? p.agents.map((a) => `<button class="agent" data-id="${a.id}" data-kind="${a.kind}">
          <div class="av" style="--c:${a.color}">${esc(initials(a.name))}</div>
          <div class="ainfo"><div class="aname"><span>${esc(a.name)}</span>${a.lead ? '<span class="badge lead">Lead</span>' : ''}${a.kind === 'shell' ? '<span class="badge">Terminal</span>' : `<span class="badge">${esc(a.model ? a.model[0].toUpperCase() + a.model.slice(1) : 'Claude')}</span>`}</div>
          <div class="abr">${esc(a.mode === 'worktree' ? a.branch : 'main folder')}</div></div><span class="dot"></span></button>`).join('')
      : `<div class="empty-side">${p ? 'No agents yet' : ''}</div>`;
  }
  for (const a of p?.agents || []) {
    const row = $(`.agent[data-id="${a.id}"]`);
    if (!row) continue;
    const st = statusOf(a);
    $('.dot', row).className = `dot ${st}`;
    const abr = $('.abr', row);
    const mergeTag = a.ahead ? `<span class="to-merge" data-review="${a.id}" title="Review & merge">${a.ahead} to merge</span>` : '';
    const want = `<span class="brn">${esc(a.mode === 'worktree' ? a.branch : 'main folder')}</span>${mergeTag}`;
    if (abr.dataset.html !== want) { abr.dataset.html = want; abr.innerHTML = want; }
    row.title = `${STATUS[st]}${a.session.note ? `: ${a.session.note}` : ''}`;
    row.classList.toggle('alert', st === 'needs');
  }
  $('#agentCount').textContent = p ? `${p.agents.length} / 16` : '';
}

function renderMain() {
  const main = $('#main');
  const p = project();
  if (!p) {
    clearPanes();
    if (!$('.welcome', main)) {
      main.innerHTML = `<div class="welcome">
        <h1>Run a team of AI agents side by side</h1>
        <p>Each agent is a real Claude Code session in its own pane. Give each one its own copy of the project (a git worktree) so they can work at the same time without overwriting each other.</p>
        <div class="steps"><div><b>1</b>Add a project: one of your apps.</div><div><b>2</b>Add agents: a Builder or two, a Reviewer, a Tester.</div><div><b>3</b>Give each one a task in its pane. Hold Right Ctrl to talk instead of typing.</div></div>
        <button class="btn primary" id="welcomeAdd">+ Add a project</button></div>`;
      $('#welcomeAdd').onclick = addProjectDialog;
    }
    return;
  }

  let banner = $('.banner', main);
  let grid = $('.grid', main);
  if (!grid) {
    main.innerHTML = `<div class="banner" hidden></div>
      <div class="mid"><div class="grid"></div>
        <aside class="preview" hidden><div class="pvh">
          <select class="input" id="pvTarget" title="What to preview"></select>
          <input class="input" id="pvUrl" placeholder="http://localhost:5173" hidden>
          <button class="ib" id="pvReload" title="Reload">↻</button><button class="ib" id="pvOpen" title="Open in your browser">↗</button>
          <button class="ib" id="pvClose" title="Close the preview">✕</button></div>
          <iframe id="pvFrame" title="Live preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>
        </aside></div>
      <section class="board"><div class="bh"><div class="seg" id="boardTabs"><button data-t="cards">Board</button><button data-t="notes">Shared notes</button></div>
        <span class="hint" id="boardHint"></span>
        <button class="btn sm" id="newCard">+ New card</button></div><div class="cols"></div>
        <div class="notes-view" hidden><div class="row"><input class="input" id="noteText" maxlength="600" placeholder="A fact or rule every agent should follow, e.g. Use the brand blue #1E6BFF for buttons">
          <button class="btn" id="noteAdd">Add note</button></div><div class="notes-list"></div></div></section>`;
    banner = $('.banner', main);
    grid = $('.grid', main);
    $('#newCard').onclick = () => cardDialog(null, 'backlog');
    $('#boardTabs').onclick = (e) => {
      const t = e.target.closest('button')?.dataset.t;
      if (t) { boardTab = t; boardSig = ''; renderBoard(project()); }
    };
    const addNoteNow = async () => {
      const text = $('#noteText').value.trim();
      if (!text) return;
      try {
        await call('POST', `/api/projects/${project().id}/notes`, { text });
        $('#noteText').value = '';
        refresh();
      } catch (e) { toast(e.message, true); }
    };
    $('#noteAdd').onclick = addNoteNow;
    $('#noteText').onkeydown = (e) => { if (e.key === 'Enter') addNoteNow(); };
    $('#pvTarget').onchange = (e) => { preview.target = e.target.value; savePreviewPrefs(); renderPreview(true); };
    $('#pvUrl').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      preview.url = /^https?:\/\//.test(e.target.value) ? e.target.value : `http://${e.target.value}`;
      savePreviewPrefs();
      renderPreview(true);
    };
    $('#pvReload').onclick = () => renderPreview(true);
    $('#pvOpen').onclick = () => window.open(previewSrc(project()), '_blank');
    $('#pvClose').onclick = () => { preview.open = false; savePreviewPrefs(); renderPreview(); };
    loadPreviewPrefs();
    boardSig = '';
  }
  if (!p.exists) {
    banner.hidden = false;
    banner.innerHTML = `<span>This project's folder is missing: ${esc(p.path)}</span>`;
  } else if (!p.git.hasCommits) {
    banner.hidden = false;
    if (banner.dataset.kind !== 'git') {
      banner.dataset.kind = 'git';
      banner.innerHTML = `<span>This folder isn't a git project yet. Agents can share the main folder, but each agent needs git to get its own copy.</span><button class="btn" id="gitInit">Set up git</button>`;
      $('#gitInit').onclick = () => gitInitDialog(p);
    }
  } else {
    banner.hidden = true;
    banner.dataset.kind = '';
  }

  // Keep existing terminals alive; only add and remove panes whose agents changed.
  const ids = p.agents.map((a) => a.id);
  for (const [id, pane] of panes) if (!ids.includes(id)) { pane.dispose(); panes.delete(id); }
  if (maxed && !ids.includes(maxed)) maxed = null;
  if (p.agents.length) $('.grid-empty', grid)?.remove();
  for (const a of p.agents) {
    let pane = panes.get(a.id);
    if (!pane) {
      pane = new Pane(a);
      panes.set(a.id, pane);
      grid.append(pane.el);
      layout();
      pane.start();
    } else {
      pane.update(a);
    }
  }
  if (!p.agents.length && !$('.grid-empty', grid)) {
    grid.append(el(`<div class="welcome grid-empty"><h1>No agents yet</h1>
      <p>Add a Claude agent to start. Add a plain terminal too if you want to run the app or a dev server yourself.</p>
      <button class="btn primary">+ Agent</button></div>`));
    $('.grid-empty .btn', grid).onclick = () => addAgentDialog();
  }
  layout();
  renderBoard(p);
  renderPreview();
}

// ------------------------------------------------------------------ board

const COLUMNS = [['backlog', 'Backlog', 'var(--idle)'], ['progress', 'In progress', 'var(--ok)'],
  ['review', 'Review', 'var(--think)'], ['done', 'Done', 'var(--accent)']];
let boardSig = '';
let boardTab = 'cards'; // 'cards' or 'notes'
let dragCard = null; // id of the card being dragged

// Claude writes Markdown; show it as plain text (no ##, **, backticks).
const plain = (md) => String(md || '').replace(/^#+\s*/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '• ');

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

function renderBoard(p) {
  const board = $('.board');
  if (!board) return;
  board.hidden = !state.boardOpen;
  $('#toggleBoard').classList.toggle('on', state.boardOpen);
  const cards = p.cards || [];
  const notes = p.notes || [];
  $('#toggleBoard').textContent = cards.length ? `Board · ${cards.filter((c) => c.column !== 'done').length}` : 'Board';
  const sig = JSON.stringify([boardTab, cards, notes, p.agents.map((a) => [a.id, a.name, a.color]), Math.floor(Date.now() / 60000)]);
  if (sig === boardSig || dragCard) return; // never redraw under a drag
  boardSig = sig;
  const agentOf = (id) => p.agents.find((a) => a.id === id);
  $$('#boardTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === boardTab);
    if (b.dataset.t === 'notes') b.textContent = notes.length ? `Shared notes · ${notes.length}` : 'Shared notes';
  });
  $('#boardHint').textContent = boardTab === 'cards' ? 'Drag a card onto an agent to hand it the task'
    : 'Every agent reads these before a task, and can add its own';
  $('#newCard').hidden = boardTab !== 'cards';
  $('.board .cols').hidden = boardTab !== 'cards';
  $('.notes-view').hidden = boardTab !== 'notes';
  if (boardTab === 'notes') {
    const byName = (name) => p.agents.find((a) => a.name === name);
    $('.notes-list').innerHTML = notes.length ? [...notes].reverse().map((n) => {
      const a = byName(n.author);
      const color = n.author === 'You' ? 'var(--accent)' : a ? a.color : 'var(--idle)';
      return `<div class="note"><div class="av xs" style="--c:${color}">${esc(n.author === 'You' ? 'ME' : initials(n.author))}</div>
        <div class="nt">${esc(n.text)}<div class="nm">${esc(n.author)} · ${ago(n.at)}</div></div>
        <button class="ib" data-del-note="${n.id}" title="Delete this note">✕</button></div>`;
    }).join('') : '<div class="col-empty">No shared notes yet. Agents add facts and decisions here as they work; you can add your own rules too.</div>';
    return;
  }
  $('.board .cols').innerHTML = COLUMNS.map(([col, label, color]) => {
    const list = cards.filter((c) => c.column === col).sort((a, b) => a.order - b.order);
    return `<div class="col"><div class="chd"><i class="cdot" style="background:${color}"></i>${label}<span>${list.length}</span>
        <button class="link add-card" data-col="${col}" title="Add a card here">+</button></div>
      <div class="cards" data-col="${col}">${list.map((c) => {
        const a = agentOf(c.agentId);
        const finished = c.column === 'review' && c.summary;
        return `<div class="card${a ? '' : ' unassigned'}" draggable="true" data-id="${c.id}" style="--c:${a ? a.color : 'var(--border2)'}">
          <div class="ct">${esc(c.title)}</div>
          ${finished ? `<div class="said">${esc(plain(c.summary).replace(/\s+/g, ' ').trim().slice(0, 110))}</div>` : ''}
          <div class="cm">${a ? `<div class="av xs" style="--c:${a.color}">${esc(initials(a.name))}</div>${esc(a.name)}` : 'Unassigned'}
            ${finished ? '<span class="tag ok">finished</span>' : c.details ? '<span class="tag">details</span>' : ''}<span class="t">${ago(c.updatedAt || c.createdAt)}</span></div></div>`;
      }).join('') || '<div class="col-empty">Drop cards here</div>'}</div></div>`;
  }).join('');
}

function cardDialog(card, column = 'backlog') {
  const p = project();
  if (!p) return;
  const claudes = p.agents.filter((a) => a.kind === 'claude');
  const isNew = !card;
  const body = openModal(`<h2>${isNew ? 'New card' : 'Edit card'}</h2>
    <p class="sub">${isNew ? 'One task for one agent. Small, clear tasks work best.' : `In ${COLUMNS.find((c) => c[0] === card.column)[1]}${card.agentId && p.agents.find((a) => a.id === card.agentId) ? ` · given to ${esc(p.agents.find((a) => a.id === card.agentId).name)}` : ''}`}</p>
    <div class="field"><label>Task</label><input class="input" id="cTitle" maxlength="200" placeholder="e.g. Add a contact form to the home page" value="${esc(card?.title || '')}"></div>
    <div class="field"><label>Details (optional)</label><textarea class="input" id="cDetails" maxlength="8000" placeholder="Anything the agent should know: files, look, rules, what done means.">${esc(card?.details || '')}</textarea></div>
    ${card?.summary ? `<div class="field"><label>What ${esc(p.agents.find((a) => a.id === card.agentId)?.name || 'the agent')} said when it finished</label>
      <div class="summary">${esc(plain(card.summary))}</div></div>` : ''}
    <div class="row field">
      <div style="flex:1"><label class="lbl">Column</label><select class="input" id="cCol">${COLUMNS.map(([v, l]) => `<option value="${v}" ${v === (card?.column || column) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div style="flex:1"><label class="lbl">Give it to</label><select class="input" id="cAgent"><option value="">Nobody yet</option>${claudes.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    </div>
    <p class="note" id="cNote">Choosing an agent types this task into its pane and moves the card to In progress.</p>
    <div class="err" hidden></div>
    <div class="foot-btns">${isNew ? '' : '<button class="btn danger" id="cDel">Delete</button>'}
      ${!isNew && p.agents.find((a) => a.id === card.agentId)?.mode === 'worktree' ? '<button class="btn" id="cReview">Review &amp; merge…</button>' : ''}
      <span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="cSave">${isNew ? 'Add card' : 'Save'}</button></div>`);
  const agentSel = $('#cAgent');
  const label = () => {
    $('#cSave').textContent = agentSel.value ? `${isNew ? 'Add' : 'Save'} and send to ${agentSel.selectedOptions[0].text}` : (isNew ? 'Add card' : 'Save');
  };
  agentSel.onchange = label;
  $('#cTitle').onkeydown = (e) => { if (e.key === 'Enter') $('#cSave').click(); };
  if ($('#cReview')) $('#cReview').onclick = () => reviewDialog(card.agentId);
  if (!isNew) {
    $('#cDel').onclick = async () => {
      await call('DELETE', `/api/cards/${card.id}`).catch((e) => toast(e.message, true));
      closeModal();
      refresh();
    };
  }
  $('#cSave').onclick = async () => {
    const data = { title: $('#cTitle').value, details: $('#cDetails').value, column: $('#cCol').value };
    try {
      const saved = isNew ? await call('POST', `/api/projects/${p.id}/cards`, data) : await call('PUT', `/api/cards/${card.id}`, data);
      if (agentSel.value) await sendCard(saved.id, agentSel.value);
      closeModal();
      refresh();
    } catch (e) { showError(body, e.message); }
  };
}

async function sendCard(cardId, agentId) {
  const agent = project()?.agents.find((a) => a.id === agentId);
  await call('POST', `/api/cards/${cardId}/send`, { agentId });
  toast(`Sent to ${agent?.name || 'the agent'}. The card moved to In progress.`);
  boardSig = '';
  refresh();
}

// Drag and drop: between columns, onto a pane, or onto an agent in the sidebar.
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.card');
  if (!c) return;
  dragCard = c.dataset.id;
  e.dataTransfer.setData('text/plain', c.querySelector('.ct').textContent);
  e.dataTransfer.effectAllowed = 'move';
  c.classList.add('dragging');
  document.body.classList.add('dragging-card');
});

document.addEventListener('dragend', () => {
  dragCard = null;
  document.body.classList.remove('dragging-card');
  $$('.dragging, .over').forEach((x) => x.classList.remove('dragging', 'over'));
  $$('.drop-line').forEach((x) => x.remove());
  boardSig = '';
});

function dropTarget(e) {
  return e.target.closest?.('.cards, .drop-hint, #agents .agent');
}

document.addEventListener('dragover', (e) => {
  if (!dragCard) return;
  const t = dropTarget(e);
  if (!t) return;
  if (!t.classList.contains('cards') && t.dataset.kind !== 'claude') return; // plain terminals can't take cards
  e.preventDefault();
  $$('.over').forEach((x) => { if (x !== t) x.classList.remove('over'); });
  t.classList.add('over');
  if (t.classList.contains('cards')) {
    const before = [...t.querySelectorAll('.card:not(.dragging)')].find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    let line = $('.drop-line') || el('<div class="drop-line"></div>');
    if (before) t.insertBefore(line, before); else t.append(line);
    line.dataset.before = before ? before.dataset.id : '';
  }
});

document.addEventListener('drop', async (e) => {
  if (!dragCard) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  const id = dragCard;
  try {
    if (t.classList.contains('cards')) {
      await call('PUT', `/api/cards/${id}`, { column: t.dataset.col, before: $('.drop-line')?.dataset.before || undefined });
    } else {
      await sendCard(id, t.dataset.agent || t.dataset.id);
    }
  } catch (err) { toast(err.message, true); }
  boardSig = '';
  refresh();
});

document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-note]');
  if (del) {
    await call('DELETE', `/api/notes/${del.dataset.delNote}`).catch((err) => toast(err.message, true));
    return refresh();
  }
  const add = e.target.closest('.add-card');
  if (add) return cardDialog(null, add.dataset.col);
  const c = e.target.closest('.board .card');
  if (c) cardDialog(project()?.cards.find((x) => x.id === c.dataset.id));
});

function clearPanes() {
  for (const pane of panes.values()) pane.dispose();
  panes.clear();
  maxed = null;
}

function layout() {
  const grid = $('.grid');
  if (!grid) return;
  const n = Math.max(1, panes.size);
  const c = state.columns === 'auto' ? (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4) : Math.min(Number(state.columns), n);
  const sig = `${n}:${c}:${maxed}`;
  if (grid.dataset.sig === sig) return;
  grid.dataset.sig = sig;
  grid.style.gridTemplateColumns = `repeat(${maxed ? 1 : c}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${maxed ? 1 : Math.ceil(n / c)}, minmax(0, 1fr))`;
  grid.classList.toggle('max', !!maxed);
  for (const [id, pane] of panes) pane.el.classList.toggle('max', id === maxed);
  requestAnimationFrame(() => { for (const pane of panes.values()) pane.fitNow(); });
}

// ------------------------------------------------------------------ actions

async function restartAgent(id, fresh) {
  try {
    await call('POST', `/api/agents/${id}/restart`, { fresh });
    refresh();
  } catch (e) { toast(e.message, true); }
}

function paneMenu(agent, anchor) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const isClaude = agent.kind === 'claude';
  const menu = el(`<div class="menu">
    ${agent.mode === 'worktree' ? '<button data-a="review">Review &amp; merge changes…<small>See what it changed and merge it into main</small></button>' : ''}
    ${agent.mode === 'worktree' ? '<button data-a="preview">Preview its copy</button>' : ''}
    ${isClaude ? '<button data-a="fresh">Restart with a new conversation<small>Clears this agent\'s chat; files stay as they are</small></button>' : ''}
    <button data-a="stop">Stop</button>
    <button data-a="copy">Copy folder path<small>${esc(agent.cwd)}</small></button>
    <button data-a="remove" class="red">Remove…</button></div>`);
  document.body.append(menu);
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    closeMenu();
    try {
      if (a === 'review') reviewDialog(agent.id);
      if (a === 'preview') showPreview(agent.id);
      if (a === 'fresh') await restartAgent(agent.id, true);
      if (a === 'stop') { await call('POST', `/api/agents/${agent.id}/stop`); refresh(); }
      if (a === 'copy') { await navigator.clipboard.writeText(agent.cwd); toast('Folder path copied'); }
      if (a === 'remove') removeAgentDialog(agent);
    } catch (err) { toast(err.message, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenuOutside), 0);
}

function closeMenuOutside(e) {
  if (!e.target.closest('.menu')) closeMenu();
}

function closeMenu() {
  $('.menu')?.remove();
  document.removeEventListener('mousedown', closeMenuOutside);
}

// ------------------------------------------------------------------ dialogs

function openModal(html, { wide = false } = {}) {
  const body = $('#modalBody');
  body.classList.toggle('wide', wide);
  body.innerHTML = html;
  $('#modal').hidden = false;
  $$('[data-close]', body).forEach((b) => { b.onclick = closeModal; });
  setTimeout(() => $('input, textarea', body)?.focus(), 0);
  return body;
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
}

function showError(body, msg) {
  const e = $('.err', body);
  e.textContent = msg;
  e.hidden = false;
}

async function addProjectDialog() {
  const body = openModal(`<h2>Add a project</h2>
    <p class="sub">Pick the folder of an app you want the agents to work on.</p>
    <div class="field"><label>Folder</label>
      <div class="row"><input class="input" id="pPath" placeholder="${esc(state.appsDir)}\\my-app"><button class="btn" id="pBrowse">Browse…</button></div></div>
    <div class="field"><label>Your apps</label><div class="folders" id="pList"><div class="folder">Loading…</div></div></div>
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pAdd">Add project</button></div>`);
  const add = async (path) => {
    try {
      const p = await call('POST', '/api/projects', { path });
      closeModal();
      state.activeProject = p.id;
      clearPanes();
      refresh();
    } catch (e) { showError(body, e.message); }
  };
  $('#pAdd').onclick = () => add($('#pPath').value);
  $('#pPath').onkeydown = (e) => { if (e.key === 'Enter') add($('#pPath').value); };
  $('#pBrowse').onclick = async () => {
    const btn = $('#pBrowse');
    btn.disabled = true;
    btn.textContent = 'Picker open…';
    try {
      const r = await call('POST', '/api/pick-folder');
      if (r.busy) showError(body, 'The folder picker is already open. It may be behind this window.');
      else if (r.error) showError(body, r.error);
      else if (r.path) add(r.path);
    } catch (e) {
      showError(body, e.message);
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Browse…'; }
    }
  };
  const folders = await call('GET', '/api/folders');
  $('#pList').innerHTML = folders.map((f) => `<button class="folder" data-path="${esc(f.path)}"><span>${esc(f.name)}</span>
    <span class="tag ${f.git ? 'git' : ''}">${f.git ? 'git' : 'no git yet'}</span></button>`).join('');
  $('#pList').onclick = (e) => {
    const b = e.target.closest('.folder');
    if (b) add(b.dataset.path);
  };
}

function addAgentDialog(kind = 'claude') {
  const p = project();
  if (!p) return;
  const canWorktree = p.git.hasCommits;
  const nextName = (base) => {
    const used = new Set(p.agents.map((a) => a.name.toLowerCase()));
    for (let n = 1; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };
  if (kind === 'shell') {
    return call('POST', `/api/projects/${p.id}/agents`, { kind: 'shell', name: nextName('Terminal') })
      .then(refresh).catch((e) => toast(e.message, true));
  }
  let role = 'Builder';
  let model = '';
  let mode = canWorktree ? 'worktree' : 'main';
  let nameTouched = false;
  const lead = p.agents.find((a) => a.lead);
  const body = openModal(`<h2>New agent</h2>
    <p class="sub">Starts Claude Code in a new pane, signed in the same way as your own Claude Code.</p>
    <div class="field"><label>Role</label><div class="choices" id="aRoles">${Object.keys(ROLES).map((r) => `<button class="choice" data-r="${r}"
        ${r === 'Lead' && lead ? `disabled title="${esc(lead.name)} is already the Lead"` : ''}>${r}</button>`).join('')}</div>
      <p class="note" id="aLeadNote" hidden>The Lead plans the work and hands cards to the other agents by itself. It doesn't write code, so it works in the main folder. Tell it a goal in its pane.</p></div>
    <div class="field"><label>Name</label><input class="input" id="aName" maxlength="40"></div>
    <div class="field"><label>Standing instructions</label><textarea class="input" id="aRole" maxlength="600" placeholder="What this agent is for. It keeps this in mind for every task."></textarea></div>
    <div class="field"><label>Model</label><div class="choices" id="aModels">${MODELS.map(([v, l]) => `<button class="choice" data-m="${v}">${l}</button>`).join('')}</div></div>
    <div class="field"><label>Where it works</label>
      <button class="opt" data-mode="worktree" ${canWorktree ? '' : 'disabled'}><span class="radio"></span><span><b>Its own copy (recommended)</b>
        <small>${canWorktree ? 'A git worktree on its own branch, so several agents can edit at once without clashing.' : 'Needs git. Use "Set up git" on the project first.'}</small></span></button>
      <button class="opt" data-mode="main"><span class="radio"></span><span><b>The main project folder</b>
        <small>Edits your files directly. Fine for a single agent or for reviewing.</small></span></button></div>
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" data-close>Cancel</button><button class="btn primary" id="aStart">Start agent</button></div>`);
  const paint = () => {
    $$('#aRoles .choice', body).forEach((b) => b.classList.toggle('on', b.dataset.r === role));
    $$('#aModels .choice', body).forEach((b) => b.classList.toggle('on', b.dataset.m === model));
    $$('.opt', body).forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  };
  const pickRole = (r) => {
    role = r;
    $('#aRole').value = ROLES[r];
    if (!nameTouched) $('#aName').value = r === 'Lead' ? 'Lead' : nextName(r === 'Custom' ? 'Agent' : r);
    if (r === 'Lead') mode = 'main';
    $('#aLeadNote').hidden = r !== 'Lead';
    paint();
  };
  $('#aRoles').onclick = (e) => { const b = e.target.closest('.choice'); if (b) pickRole(b.dataset.r); };
  $('#aModels').onclick = (e) => { const b = e.target.closest('.choice'); if (b) { model = b.dataset.m; paint(); } };
  $$('.opt', body).forEach((b) => { b.onclick = () => { mode = b.dataset.mode; paint(); }; });
  $('#aName').oninput = () => { nameTouched = true; };
  pickRole('Builder');
  $('#aStart').onclick = async () => {
    const btn = $('#aStart');
    btn.disabled = true;
    btn.textContent = mode === 'worktree' ? 'Creating its copy…' : 'Starting…';
    try {
      const agent = await call('POST', `/api/projects/${p.id}/agents`, { kind: 'claude', name: $('#aName').value, role: $('#aRole').value, model, mode, lead: role === 'Lead' });
      closeModal();
      refresh();
      const shared = (agent.shared || []).filter((s) => s.files);
      toast(`${shared.length ? `Shared into its copy (no extra disk space): ${shared.map((s) => s.path).join(', ')}. ` : ''}`
        + 'If Claude asks whether you trust the folder, press ↓ then Enter to pick "Yes, I trust this folder".'
        + (agent.lead ? ' Then tell the Lead a goal in its pane.' : ''), false, 10000);
    } catch (e) {
      showError(body, e.message);
      btn.disabled = false;
      btn.textContent = 'Start agent';
    }
  };
}

function removeAgentDialog(agent) {
  const wt = agent.mode === 'worktree';
  const body = openModal(`<h2>Remove ${esc(agent.name)}?</h2>
    <p class="sub">Its pane closes and the process stops.${agent.kind === 'claude' ? ' Its conversation stays saved in Claude Code.' : ''}</p>
    ${wt ? `<label class="check"><input type="checkbox" id="rWt"><span>Also delete its copy (<code>.agentdeck\\worktrees\\${esc(agent.slug)}</code>) and its branch <code>${esc(agent.branch)}</code>.
      This only happens if all its work is committed. A branch with work that isn't merged yet is kept.</span></label>` : ''}
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" data-close>Cancel</button><button class="btn danger" id="rGo">Remove</button></div>`);
  $('#rGo').onclick = async () => {
    try {
      const { notes } = await call('DELETE', `/api/agents/${agent.id}`, { removeWorktree: wt && $('#rWt').checked });
      closeModal();
      if (notes?.length) toast(notes.join(' '));
      refresh();
    } catch (e) { showError(body, e.message); }
  };
}

const size = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(b >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

async function gitInitDialog(p) {
  const body = openModal(`<h2>Set up git for ${esc(p.name)}</h2>
    <p class="sub">Looking at what's in the folder…</p>`);
  let plan;
  try {
    plan = await call('GET', `/api/projects/${p.id}/git-plan`);
  } catch (e) {
    body.innerHTML += `<div class="err">${esc(e.message)}</div><div class="foot-btns"><button class="btn" data-close>Close</button></div>`;
    $('[data-close]', body).onclick = closeModal;
    return;
  }
  const skips = plan.skips;
  body.innerHTML = `<h2>Set up git for ${esc(p.name)}</h2>
    <p class="sub">Git keeps a history of your <b>code</b>, on this PC only. Nothing is uploaded.
      Below are the things it will <b>skip</b>: big, generated or secret files you never edit by hand.
      Untick anything you do want saved.</p>
    <div class="plan-sum" id="gSum"></div>
    ${skips.length ? `<div class="skips">${skips.map((s, i) => `<label class="skip">
        <input type="checkbox" data-i="${i}" checked>
        <span class="pat">${esc(s.pattern)}</span>
        <span class="why">${esc(s.reason)}</span>
        <span class="amt">${s.files ? `${size(s.bytes)} · ${plural(s.files, 'file')}` : 'empty now'}</span></label>`).join('')}</div>`
      : '<p class="sub">Nothing needs skipping: everything here looks like code.</p>'}
    ${skips.length ? `<p class="note">These are written to a <code>.gitignore</code> file${plan.hasGitignore ? ' (added below what is already there)' : ''}.
      Skipped folders are still shared into each agent's copy (hard links, no extra disk space), so agents can run the app.</p>` : ''}
    ${plan.partial ? '<p class="note">This folder is very large, so the sizes are a partial estimate.</p>' : ''}
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" data-close>Cancel</button><button class="btn primary" id="gGo">Set up git</button></div>`;
  $('[data-close]', body).onclick = closeModal;
  const picked = () => skips.filter((_, i) => $(`.skip input[data-i="${i}"]`, body).checked);
  const summary = () => {
    const skipped = picked().reduce((t, s) => ({ bytes: t.bytes + s.bytes, files: t.files + s.files }), { bytes: 0, files: 0 });
    const keep = { bytes: Math.max(0, plan.total.bytes - skipped.bytes), files: Math.max(0, plan.total.files - skipped.files) };
    $('#gSum').innerHTML = `<div><b>Will save</b><span>${plural(keep.files, 'file')} · about ${size(keep.bytes)}</span></div>
      <div><b>Will skip</b><span>${plural(skipped.files, 'file')} · about ${size(skipped.bytes)}</span></div>`;
  };
  $$('.skip input', body).forEach((c) => { c.onchange = summary; });
  summary();
  $('#gGo').onclick = async () => {
    const btn = $('#gGo');
    btn.disabled = true;
    btn.textContent = 'Saving first version…';
    try {
      const r = await call('POST', `/api/projects/${p.id}/git-init`, { patterns: picked().map((s) => s.pattern) });
      closeModal();
      $('.banner').dataset.kind = '';
      toast(`Git is set up. First version saved: ${plural(r.files, 'file')} (${size(r.bytes)}).`, false, 6000);
      refresh();
    } catch (e) {
      showError(body, e.message);
      btn.disabled = false;
      btn.textContent = 'Set up git';
    }
  };
}

function removeProjectDialog(p) {
  const body = openModal(`<h2>Remove ${esc(p.name)} from AgentDeck?</h2>
    <p class="sub">Its agents stop. Nothing is deleted from disk: the project folder and any agent copies stay where they are.</p>
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" data-close>Cancel</button><button class="btn danger" id="xGo">Remove from list</button></div>`);
  $('#xGo').onclick = async () => {
    try {
      await call('DELETE', `/api/projects/${p.id}`);
      closeModal();
      clearPanes();
      refresh();
    } catch (e) { showError(body, e.message); }
  };
}

// ------------------------------------------------------------------ review & merge

// A unified diff as coloured lines, with an anchor at each file so the file list can jump to it.
function diffHtml(diff) {
  let n = 0;
  return diff.split('\n').map((line) => {
    if (line.startsWith('diff --git')) {
      const file = line.replace(/^diff --git a\/.* b\//, '');
      return `<div class="df-file" id="df-${n++}">${esc(file)}</div>`;
    }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename (from|to))/.test(line)) return '';
    if (line.startsWith('@@')) return `<div class="df-hunk">${esc(line)}</div>`;
    if (line.startsWith('Binary files')) return '<div class="df-ctx">(binary file, not shown)</div>';
    const cls = line[0] === '+' ? 'df-add' : line[0] === '-' ? 'df-del' : 'df-ctx';
    return `<div class="${cls}">${esc(line) || ' '}</div>`;
  }).join('');
}

async function reviewDialog(agentId) {
  const p = project();
  const agent = p?.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const body = openModal(`<h2>${esc(agent.name)}'s changes</h2><p class="sub">Loading…</p>`, { wide: true });
  let ch;
  try {
    ch = await call('GET', `/api/agents/${agent.id}/changes`);
  } catch (e) {
    body.innerHTML = `<h2>${esc(agent.name)}'s changes</h2><div class="err">${esc(e.message)}</div><div class="foot-btns"><button class="btn" data-close>Close</button></div>`;
    $('[data-close]', body).onclick = closeModal;
    return;
  }
  const add = ch.files.reduce((t, f) => t + (f.add || 0), 0);
  const del = ch.files.reduce((t, f) => t + (f.del || 0), 0);
  const cards = (p.cards || []).filter((c) => c.agentId === agent.id && c.column === 'review');
  const kindLabel = { A: 'new', D: 'deleted', R: 'renamed', M: 'changed' };
  body.innerHTML = `<div class="rv-head"><div><h2>${esc(agent.name)}'s changes</h2>
      <p class="sub"><code>${esc(ch.branch)}</code> → <code>${esc(ch.base)}</code>${cards.length ? ` · for ${cards.map((c) => `“${esc(c.title)}”`).join(', ')}` : ''}</p></div>
      <div class="rv-stats"><span>${plural(ch.commits.length, 'commit')}</span><span>${plural(ch.files.length, 'file')}</span><span class="g">+${add}</span><span class="r">−${del}</span></div></div>
    ${ch.uncommitted.length ? `<div class="warn-box">⚠ ${plural(ch.uncommitted.length, 'file')} in its copy changed but not committed, so they are <b>not</b> part of this merge: ${esc(ch.uncommitted.slice(0, 6).join(', '))}${ch.uncommitted.length > 6 ? '…' : ''}. Ask ${esc(agent.name)} to commit them first if they matter.</div>` : ''}
    ${ch.behind ? `<div class="info-box">Main has ${plural(ch.behind, 'newer commit')} that ${esc(agent.name)}'s copy doesn't have yet. That's fine for merging; <button class="link" id="rvUpdate">update its copy</button> so its next task starts from the latest work.</div>` : ''}
    ${ch.files.length ? `<div class="rv-body">
      <div class="rv-files">${ch.commits.map((c) => `<div class="rv-commit"><code>${esc(c.hash)}</code> ${esc(c.subject)}</div>`).join('')}
        <div class="rv-sep"></div>${ch.files.map((f, i) => `<button class="rv-file" data-i="${i}"><span class="k k-${f.kind}">${kindLabel[f.kind] || f.kind}</span>
          <span class="fp">${esc(f.path)}</span><span class="g">${f.add == null ? 'bin' : `+${f.add}`}</span><span class="r">${f.del == null ? '' : `−${f.del}`}</span></button>`).join('')}</div>
      <div class="rv-diff">${diffHtml(ch.diff)}</div></div>`
      : `<p class="sub">Nothing new to merge${ch.uncommitted.length ? ' yet: its changes are not committed.' : ': this copy has no commits that main doesn\'t already have.'}</p>`}
    <div class="rv-back" hidden><textarea class="input" id="rvText" placeholder="What should ${esc(agent.name)} change? e.g. The menu prices should be in euros, and the header is too big on phones."></textarea></div>
    <div class="err" hidden></div>
    <div class="foot-btns"><button class="btn" id="rvPreview">Preview its copy</button><button class="btn" id="rvBack">Send back with feedback…</button>
      <span style="flex:1"></span><button class="btn" data-close>Close</button>
      <button class="btn primary" id="rvMerge" ${ch.commits.length ? '' : 'disabled'}>Merge into ${esc(ch.base)}</button></div>`;
  $('[data-close]', body).onclick = closeModal;
  $$('.rv-file', body).forEach((b) => { b.onclick = () => $(`#df-${b.dataset.i}`, body)?.scrollIntoView({ block: 'start' }); });
  $('#rvPreview').onclick = () => { closeModal(); showPreview(agent.id); };
  if ($('#rvUpdate')) {
    $('#rvUpdate').onclick = async () => {
      const r = await call('POST', `/api/agents/${agent.id}/update`).catch((e) => ({ note: e.message }));
      toast(`${agent.name}'s copy: ${r.note || 'done'}.`, !r.ok);
      reviewDialog(agent.id);
    };
  }
  $('#rvBack').onclick = async () => {
    const box = $('.rv-back', body);
    if (box.hidden) { box.hidden = false; $('#rvText').focus(); $('#rvBack').textContent = 'Send it back'; return; }
    try {
      await call('POST', `/api/agents/${agent.id}/send-back`, { text: $('#rvText').value });
      closeModal();
      toast(`Sent back to ${agent.name}. Its card moved back to In progress.`);
      refresh();
    } catch (e) { showError(body, e.message); }
  };
  $('#rvMerge').onclick = () => doMerge(agent, body, false);
}

async function doMerge(agent, body, saveMainFirst) {
  const btn = $('#rvMerge', body);
  btn.disabled = true;
  btn.textContent = 'Merging…';
  let r;
  try {
    r = await call('POST', `/api/agents/${agent.id}/merge`, { saveMainFirst });
  } catch (e) {
    showError(body, e.message);
    btn.disabled = false;
    btn.textContent = 'Merge into main';
    return;
  }
  if (r.mainDirty) {
    showError(body, `Your main folder has ${plural(r.mainDirty.length, 'file')} with changes that aren't saved in git (${r.mainDirty.slice(0, 5).join(', ')}${r.mainDirty.length > 5 ? '…' : ''}). AgentDeck won't mix them into a merge.`);
    btn.disabled = false;
    btn.textContent = 'Save them as a commit, then merge';
    btn.onclick = () => doMerge(agent, body, true);
    return;
  }
  if (r.conflict) {
    showError(body, `${agent.name}'s changes clash with what's already in main, in ${r.files.join(', ')}. Nothing was changed: the merge was cancelled.`);
    btn.disabled = false;
    btn.textContent = `Ask ${agent.name} to fix the clash`;
    btn.onclick = async () => {
      try {
        await call('POST', `/api/agents/${agent.id}/send-back`, { conflicts: r.files });
        closeModal();
        toast(`Asked ${agent.name} to merge main into its copy and fix the clash. Merge again when it's finished.`, false, 7000);
        refresh();
      } catch (e) { showError(body, e.message); }
    };
    return;
  }
  closeModal();
  const upd = (r.updated || []).map((u) => `${u.name}: ${u.note}`).join(', ');
  toast(`Merged ${plural(r.commits, 'commit')} from ${agent.name} into ${r.base}. Its cards are Done.${upd ? ` Other copies: ${upd}.` : ''}`, false, 8000);
  refresh();
  showPreview('main', { onlyIfOpen: true });
}

// ------------------------------------------------------------------ live preview

let preview = { open: false, target: 'main', url: 'http://localhost:5173' };
const previewKey = () => `agentdeck.preview.${state?.activeProject}`;

function loadPreviewPrefs() {
  try { Object.assign(preview, JSON.parse(localStorage.getItem(previewKey()) || '{}')); } catch { /* storage unavailable */ }
}
function savePreviewPrefs() {
  try { localStorage.setItem(previewKey(), JSON.stringify(preview)); } catch { /* storage unavailable */ }
}

function previewSrc(p) {
  if (preview.target === 'url') return preview.url;
  if (!state.previewPort) return 'about:blank';
  return `http://localhost:${state.previewPort}/${p.id}/${preview.target}/`;
}

function showPreview(target, { onlyIfOpen = false } = {}) {
  if (onlyIfOpen && !preview.open) return;
  preview.open = true;
  if (target) preview.target = target;
  savePreviewPrefs();
  renderPreview(true);
}

function renderPreview(reload = false) {
  const p = project();
  const pane = $('.preview');
  if (!p || !pane) return;
  pane.hidden = !preview.open;
  $('#togglePreview').classList.toggle('on', preview.open);
  if (!preview.open) return;
  const copies = p.agents.filter((a) => a.mode === 'worktree');
  if (preview.target !== 'main' && preview.target !== 'url' && !copies.some((a) => a.id === preview.target)) preview.target = 'main';
  const opts = [['main', 'Main folder (merged work)'], ...copies.map((a) => [a.id, `${a.name}'s copy`]), ['url', 'Dev server / any URL…']];
  const sel = $('#pvTarget');
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  }
  sel.value = preview.target;
  $('#pvUrl').hidden = preview.target !== 'url';
  if (preview.target === 'url' && document.activeElement !== $('#pvUrl')) $('#pvUrl').value = preview.url;
  const src = previewSrc(p);
  const frame = $('#pvFrame');
  if (reload || frame.dataset.src !== src) {
    frame.dataset.src = src;
    frame.src = src;
  }
}

// ------------------------------------------------------------------ wiring

$('#addProject').onclick = addProjectDialog;
$('#addAgent').onclick = () => addAgentDialog('claude');
$('#addShell').onclick = () => addAgentDialog('shell');
$('#togglePreview').onclick = () => {
  if (!project()) return;
  preview.open = !preview.open;
  savePreviewPrefs();
  renderPreview(true);
};
$('#toggleBoard').onclick = async () => {
  state.boardOpen = !state.boardOpen;
  boardSig = '';
  const p = project();
  if (p) renderBoard(p);
  await call('PUT', '/api/ui', { boardOpen: state.boardOpen }).catch(() => {});
};
$('#modal').onmousedown = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
});
$('#columns').onclick = async (e) => {
  const c = e.target.closest('button')?.dataset.c;
  if (!c) return;
  state.columns = c;
  maxed = null;
  renderTop();
  layout();
  await call('PUT', '/api/ui', { columns: c }).catch(() => {});
};
$('#projects').onclick = async (e) => {
  const b = e.target.closest('.proj');
  if (!b || b.dataset.id === state.activeProject) return;
  state.activeProject = b.dataset.id;
  clearPanes();
  $('#main').innerHTML = '';
  render();
  await call('PUT', '/api/ui', { activeProject: b.dataset.id }).catch(() => {});
};
$('#projects').oncontextmenu = (e) => {
  const b = e.target.closest('.proj');
  if (!b) return;
  e.preventDefault();
  removeProjectDialog(state.projects.find((p) => p.id === b.dataset.id));
};
$('#crumbs').onclick = (e) => {
  if (!e.target.closest('#needsChip')) return;
  const a = project()?.agents.find((x) => statusOf(x) === 'needs');
  if (a) focusAgent(a.id);
};
$('#agents').onclick = (e) => {
  const merge = e.target.closest('[data-review]');
  if (merge) return reviewDialog(merge.dataset.review);
  const b = e.target.closest('.agent');
  if (b) focusAgent(b.dataset.id);
};
window.addEventListener('resize', () => { for (const p of panes.values()) p.fitSoon(); });

refresh();
setInterval(refresh, 1200);
