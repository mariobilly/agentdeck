// AgentDeck: run several Claude Code agents side by side, each in its own git worktree.
// Local only: binds to 127.0.0.1 and serves the UI at http://localhost:4646.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.AGENTDECK_PORT) || 4646;
const ROOT = __dirname;
// Where your projects live. The Add-project list shows its subfolders; defaults to the folder AgentDeck sits in.
const APPS_DIR = path.resolve(process.env.AGENTDECK_PROJECTS_DIR || path.join(ROOT, '..'));
const DATA_DIR = process.env.AGENTDECK_DATA || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BUFFER_LIMIT = 1_500_000; // characters of terminal output kept per agent for reconnects
const ACTIVE_MS = 1500;         // output within this window counts as "working"
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// Optional: with AGENTDECK_BLOCK_API_KEYS=1, AI-provider keys never reach an agent, so every agent uses
// the account you signed in to Claude Code with and nothing can bill an API key by accident.
const BLOCK_API_KEYS = process.env.AGENTDECK_BLOCK_API_KEYS === '1';
const BLOCKED_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
]);
// Markers of the Claude Code session that launched AgentDeck (if any). Inherited, they would make each
// agent think it is a child session and turn off its transcript saving.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH))/i;

const COLORS = ['#a78bfa', '#38bdf8', '#fb923c', '#f472b6', '#a3e635', '#2dd4bf', '#facc15', '#f87171',
  '#c084fc', '#22d3ee', '#fdba74', '#86efac', '#e879f9', '#93c5fd', '#fca5a5', '#5eead4'];
const MODELS = new Set(['', 'opus', 'sonnet', 'haiku']);
const MAX_AGENTS = 16;

const CLAUDE = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find(fs.existsSync) || 'claude.exe';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(fs.existsSync);

// ------------------------------------------------------------------ state

let state = loadState();
const BOOT_ID = crypto.randomBytes(4).toString('hex'); // changes on every restart, so open pages reload new code

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { projects: [], activeProject: null, columns: 'auto' };
  }
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const rid = () => crypto.randomBytes(5).toString('hex');
const findProject = (id) => state.projects.find((p) => p.id === id);

function findAgent(id) {
  for (const project of state.projects) {
    const agent = project.agents.find((a) => a.id === id);
    if (agent) return { project, agent };
  }
  return {};
}

// ------------------------------------------------------------------ git

// raw: keep leading spaces (needed for `status --porcelain`, where " M" and "M " mean different things).
function git(cwd, args, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 50e6 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(raw ? stdout : stdout.trim());
    });
  });
}

async function gitInfo(dir) {
  let top;
  try {
    top = path.normalize(await git(dir, ['rev-parse', '--show-toplevel']));
  } catch {
    return { isGit: false, hasCommits: false, branch: '' };
  }
  try {
    await git(dir, ['rev-parse', '--verify', 'HEAD']);
    return { isGit: true, hasCommits: true, top, branch: await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) };
  } catch {
    return { isGit: true, hasCommits: false, top, branch: '' };
  }
}

// Keep .agentdeck/ (the worktrees) out of git status without touching the project's .gitignore.
async function excludeAgentDeckDir(repo) {
  const exclude = path.resolve(repo, await git(repo, ['rev-parse', '--git-path', 'info/exclude']));
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('.agentdeck/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.agentdeck/\n`);
  }
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

// ------------------------------------------------------------------ projects + agents

async function addProject(dir) {
  dir = path.resolve(String(dir || '').trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const info = await gitInfo(dir);
  if (info.isGit) dir = info.top;
  let project = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase());
  if (!project) {
    project = { id: rid(), name: path.basename(dir), path: dir, agents: [] };
    state.projects.push(project);
  }
  state.activeProject = project.id;
  saveState();
  return project;
}

// ------------------------------------------------------------------ git setup: what not to track

const MB = 1024 * 1024;
const SCAN_LIMIT = 400_000; // files and folders looked at before the scan gives up
const DEP_DIRS = new Set(['node_modules', '.venv', 'venv', 'bower_components', 'site-packages']);
const BUILD_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.ipynb_checkpoints',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', 'dist', 'build', 'coverage', 'logs', 'tmp', 'temp']);
const CACHE_DIRS = new Set(['cache', '.cache']);
const OUTPUT_DIRS = new Set(['output', 'outputs', 'renders', 'exports']);
const VENDOR_DIRS = new Set(['vendor', 'third_party']);
const MEDIA_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'wav', 'flac', 'aif', 'aiff', 'ogg', 'm4a',
  'mp3', 'safetensors', 'ckpt', 'pt', 'pth', 'onnx', 'gguf', 'bin', 'h5', 'tflite', 'glb', 'fbx', 'blend', 'exr', 'psd',
  'tif', 'tiff', 'zip', '7z', 'rar', 'tar', 'gz']);
// Source code. A folder holding any of these is never skipped as a whole (json/md/txt count as data).
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'html', 'htm', 'css', 'scss', 'ps1', 'cmd',
  'bat', 'sh', 'glsl', 'frag', 'vert', 'wgsl', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'lua', 'sql', 'vue', 'svelte']);
const REASONS = {
  deps: 'Downloaded libraries. They can be reinstalled any time.',
  build: 'Made automatically (Python cache, builds, logs, temp files).',
  cache: "The app's cache. Rebuilt by the app.",
  output: 'Generated results (renders, exports).',
  secret: 'Secrets such as API keys. Never keep these in history.',
  media: 'Large media, model or archive files.',
  big: 'Large folder with no code in it.',
  vendor: 'Large folder of downloaded libraries.',
  bigfile: 'One very large file.',
};

function secretPattern(name) {
  if (/\.(example|sample|template)$/i.test(name)) return null;
  if (/^\.env$/i.test(name)) return '.env';
  if (/^\.env\..+/i.test(name)) return '.env.*';
  const ext = /\.(pem|key|pfx|p12)$/i.exec(name);
  if (ext) return `*.${ext[1].toLowerCase()}`;
  if (/^(id_rsa|id_ed25519|credentials\.json)$/i.test(name)) return name;
  if (/^service-account.*\.json$/i.test(name)) return 'service-account*.json';
  return null;
}

// Suggest a .gitignore: what to leave out so git tracks the code, not gigabytes of media, models and caches.
function scanForGit(root) {
  const skips = new Map();
  const add = (pattern, kind, bytes, files) => {
    const s = skips.get(pattern) || { pattern, kind, reason: REASONS[kind], bytes: 0, files: 0 };
    s.bytes += bytes;
    s.files += files;
    skips.set(pattern, s);
  };
  const dirs = [];   // folders that stay tracked: { rel, bytes, code, files }
  const media = [];  // { rel, ext, size } outside skipped folders
  const total = { bytes: 0, files: 0 };
  let seen = 0;

  const measure = (dir) => {
    let bytes = 0, files = 0;
    const stack = [dir];
    while (stack.length && seen < SCAN_LIMIT) {
      const d = stack.pop();
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        seen++;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++; } catch { /* unreadable */ } }
      }
    }
    return { bytes, files };
  };

  const walk = (dir, rel) => {
    const here = { rel, bytes: 0, code: 0, files: 0 };
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return here; }
    for (const e of ents) {
      if (++seen > SCAN_LIMIT) break;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && (e.name === '.git' || e.name === '.agentdeck')) continue;
        let kind = DEP_DIRS.has(e.name) ? 'deps' : BUILD_DIRS.has(e.name) ? 'build'
          : CACHE_DIRS.has(e.name) ? 'cache' : OUTPUT_DIRS.has(e.name) ? 'output' : null;
        // A small build/ is usually source material (Electron icons, installer settings), not output.
        const m = kind ? measure(full) : null;
        if (e.name === 'build' && m.bytes < 5 * MB) kind = null;
        if (kind) {
          add(`${e.name}/`, kind, m.bytes, m.files);
          total.bytes += m.bytes;
          total.files += m.files;
          continue;
        }
        const sub = walk(full, r);
        dirs.push(sub);
        here.bytes += sub.bytes;
        here.code += sub.code;
        here.files += sub.files;
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* unreadable */ }
        total.bytes += size;
        total.files++;
        const secret = secretPattern(e.name);
        if (secret) { add(secret, 'secret', size, 1); continue; }
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (ext === 'log') { add('*.log', 'build', size, 1); continue; }
        if (MEDIA_EXT.has(ext) || size >= 25 * MB) media.push({ rel: r, ext, size });
        here.bytes += size;
        here.files++;
        if (CODE_EXT.has(ext)) here.code++;
      }
    }
    return here;
  };
  walk(root, '');

  // Big folders with (almost) no code in them, and big vendor folders. Topmost match wins.
  const chosen = [];
  const under = (rel) => chosen.some((c) => rel === c || rel.startsWith(`${c}/`));
  for (const d of dirs.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)) {
    if (under(d.rel)) continue;
    // A folder with even one code file (web/ with its js/) is kept, and its big code-free
    // subfolders (web/models/) get picked instead.
    const noCode = d.bytes >= 50 * MB && d.code === 0;
    const vendor = VENDOR_DIRS.has(path.basename(d.rel)) && d.bytes >= 10 * MB;
    if (noCode || vendor) {
      chosen.push(d.rel);
      add(`/${d.rel}/`, vendor ? 'vendor' : 'big', d.bytes, d.files);
    }
  }
  // Media types that add up to 10 MB or more, then single huge files that are left over.
  const byExt = new Map();
  for (const m of media) {
    if (under(m.rel) || !MEDIA_EXT.has(m.ext)) continue;
    const x = byExt.get(m.ext) || { bytes: 0, files: 0 };
    x.bytes += m.size;
    x.files++;
    byExt.set(m.ext, x);
  }
  for (const [ext, x] of byExt) if (x.bytes >= 10 * MB) add(`*.${ext}`, 'media', x.bytes, x.files);
  for (const m of media) {
    if (m.size >= 25 * MB && !under(m.rel) && !skips.has(`*.${m.ext}`)) add(`/${m.rel}`, 'bigfile', m.size, 1);
  }

  const gitignore = path.join(root, '.gitignore');
  return {
    total, partial: seen >= SCAN_LIMIT,
    hasGitignore: fs.existsSync(gitignore),
    skips: [...skips.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

function writeGitignore(root, patterns) {
  const file = path.join(root, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const lines = patterns.map((p) => String(p).trim()).filter((p) => p && !p.includes('\n') && !have.has(p));
  if (lines.includes('.env.*')) lines.push('!.env.example', '!.env.sample', '!.env.template');
  if (!lines.length) return;
  const block = [
    `# Added by AgentDeck on ${new Date().toISOString().slice(0, 10)}: things git should not track.`,
    "# Big folders listed here are still shared into each agent's copy with hard links (no extra disk space).",
    ...lines, '',
  ].join('\n');
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}`);
}

async function setupGit(project, patterns) {
  const info = await gitInfo(project.path);
  if (info.hasCommits) return trackedSummary(project.path);
  if (Array.isArray(patterns)) writeGitignore(project.path, patterns);
  if (!info.isGit) await git(project.path, ['init', '-b', 'main']);
  await git(project.path, ['add', '-A']);
  await git(project.path, ['-c', 'user.name=AgentDeck', '-c', 'user.email=agentdeck@localhost',
    'commit', '--allow-empty', '-m', 'Initial commit (set up by AgentDeck)']);
  return trackedSummary(project.path);
}

async function trackedSummary(repo) {
  const files = (await git(repo, ['ls-files', '-z'])).split('\0').filter(Boolean);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(repo, f)).size; } catch { /* deleted since */ } }
  return { files: files.length, bytes };
}

// ------------------------------------------------------------------ sharing ignored folders into a copy

// Ignored folders (node_modules, models, caches…) are not part of a worktree, so an agent's copy couldn't
// run the app. Hard-link their files in: no extra disk space, and deleting the copy (rm -rf, git clean,
// git worktree remove) only removes the copy's links, never the originals. Folder links (junctions) are
// NOT used on purpose: `git worktree remove` follows them and deletes the real files.
const NO_SHARE = new Set([...BUILD_DIRS, '.agentdeck']);
const SHARE_LIMIT = 300_000;

async function shareIgnoredFolders(project, agent) {
  let out;
  try {
    out = await git(project.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  } catch {
    return [];
  }
  const entries = out.split('\0').filter(Boolean)
    .filter((p) => !p.replace(/\/$/, '').split('/').some((seg) => NO_SHARE.has(seg)));
  const shared = [];
  const loose = { path: 'other skipped files', files: 0, bytes: 0, ok: true };
  let budget = SHARE_LIMIT;
  for (const entry of entries) {
    if (budget <= 0) break;
    if (entry.endsWith('/')) {
      const rel = entry.slice(0, -1);
      const r = await hardlinkTree(path.join(project.path, rel), path.join(agent.cwd, rel), budget);
      budget -= r.files;
      shared.push({ path: rel, ...r });
      continue;
    }
    // A single skipped file (a model, a video…). Secrets and logs stay out of the copy.
    const name = path.basename(entry);
    if (secretPattern(name) || /\.log$/i.test(name)) continue;
    const dst = path.join(agent.cwd, entry);
    try {
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      await fs.promises.link(path.join(project.path, entry), dst);
      loose.files++;
      loose.bytes += (await fs.promises.stat(dst)).size;
      budget--;
    } catch { /* already there, or not linkable */ }
  }
  if (loose.files) shared.push(loose);
  return shared;
}

async function hardlinkTree(src, dst, budget) {
  const result = { files: 0, bytes: 0, ok: true };
  const queue = [[src, dst]];
  while (queue.length && result.ok) {
    const [from, to] = queue.shift();
    let ents;
    try {
      await fs.promises.mkdir(to, { recursive: true });
      ents = await fs.promises.readdir(from, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const e of ents) {
      if (e.isDirectory()) queue.push([path.join(from, e.name), path.join(to, e.name)]);
      else if (e.isFile() && !secretPattern(e.name)) files.push(e.name);
    }
    for (let i = 0; i < files.length && result.ok; i += 32) {
      await Promise.all(files.slice(i, i + 32).map(async (name) => {
        try {
          await fs.promises.link(path.join(from, name), path.join(to, name));
          result.files++;
          result.bytes += (await fs.promises.stat(path.join(to, name))).size;
        } catch (e) {
          if (e.code !== 'EEXIST') result.ok = false; // different drive or not allowed: stop sharing this folder
        }
      }));
      if (result.files >= budget) result.ok = false;
    }
  }
  return result;
}

async function createAgent(project, body) {
  if (project.agents.length >= MAX_AGENTS) throw new Error(`AgentDeck runs up to ${MAX_AGENTS} agents per project.`);
  const kind = body.kind === 'shell' ? 'shell' : 'claude';
  const name = String(body.name || '').trim().slice(0, 40) || `${kind === 'shell' ? 'Terminal' : 'Agent'} ${project.agents.length + 1}`;
  const model = MODELS.has(body.model) ? body.model : '';
  const mode = kind === 'claude' && body.mode === 'worktree' ? 'worktree' : 'main';
  const lead = kind === 'claude' && !!body.lead;
  if (lead && leadOf(project)) throw new Error(`${leadOf(project).name} is already this project's Lead. A project has one Lead.`);
  const used = new Set(project.agents.map((a) => a.color));
  const agent = {
    lead,
    id: rid(), name, kind, mode, model,
    role: String(body.role || '').trim().slice(0, 600),
    color: COLORS.find((c) => !used.has(c)) || COLORS[project.agents.length % COLORS.length],
    cwd: project.path, branch: '', createdAt: new Date().toISOString(), sessionTracked: true,
  };

  const info = await gitInfo(project.path);
  agent.branch = info.branch;
  if (mode === 'worktree') {
    if (!info.hasCommits) throw new Error('This project needs git before agents can get their own copy. Click "Set up git" first.');
    const taken = new Set(project.agents.map((a) => a.slug));
    let slug = slugify(name);
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(name)}-${n}`;
    const dir = path.join(project.path, '.agentdeck', 'worktrees', slug);
    const branch = `agent/${slug}`;
    await excludeAgentDeckDir(project.path);
    if (!fs.existsSync(dir)) {
      const branchExists = (await git(project.path, ['branch', '--list', branch])) !== '';
      await git(project.path, branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, 'HEAD']);
    }
    Object.assign(agent, { slug, cwd: dir, branch, base: info.branch });
    agent.shared = (await shareIgnoredFolders(project, agent)).map(({ path: p, files, bytes, ok }) => ({ path: p, files, bytes, ok }));
  }
  project.agents.push(agent);
  saveState();
  startSession(project, agent);
  return agent;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeWorktreeFolder(project, agent) {
  for (let attempt = 0; ; attempt++) {
    try {
      await git(project.path, ['worktree', 'remove', agent.cwd]);
      return;
    } catch (e) {
      if (/modified or untracked files/i.test(e.message)) {
        throw new Error(`Kept ${agent.name}: its copy has changes that aren't committed, so it was not deleted. Commit or discard them first.`);
      }
      if (/is not a working tree/i.test(e.message)) {
        // An earlier attempt got halfway (Windows still had the folder open). Git has already let go of it,
        // so clear what's left. fs.rm never follows links, so shared (hard-linked) originals are safe.
        await git(project.path, ['worktree', 'prune']).catch(() => {});
        await fs.promises.rm(agent.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        return;
      }
      if (attempt >= 1) throw new Error(`Couldn't delete ${agent.name}'s copy: ${e.message}`);
      await sleep(1200); // usually a file still held open by the process that just stopped
    }
  }
}

async function removeAgent(project, agent, removeWorktree) {
  await stopSession(agent.id); // Windows won't delete a folder that a running process is still using
  const notes = [];
  if (removeWorktree && agent.mode === 'worktree' && fs.existsSync(agent.cwd)) {
    await removeWorktreeFolder(project, agent);
    try {
      await git(project.path, ['branch', '-d', agent.branch]);
    } catch {
      notes.push(`Branch ${agent.branch} was kept because it has work that isn't merged yet.`);
    }
  }
  project.agents = project.agents.filter((a) => a.id !== agent.id);
  for (const c of project.cards || []) if (c.agentId === agent.id) c.agentId = null;
  saveState();
  return notes;
}

// ------------------------------------------------------------------ board (Kanban cards)

const COLUMNS = ['backlog', 'progress', 'review', 'done'];

function findCard(id) {
  for (const project of state.projects) {
    const card = (project.cards || []).find((c) => c.id === id);
    if (card) return { project, card };
  }
  return {};
}

// Put a card into a column, before another card or at the end, and renumber that column.
function placeCard(project, card, column, beforeId) {
  card.column = COLUMNS.includes(column) ? column : card.column;
  const list = project.cards.filter((c) => c.column === card.column && c !== card).sort((a, b) => a.order - b.order);
  const at = beforeId ? list.findIndex((c) => c.id === beforeId) : -1;
  list.splice(at < 0 ? list.length : at, 0, card);
  list.forEach((c, i) => { c.order = i; });
  card.updatedAt = new Date().toISOString();
}

function createCard(project, body) {
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) throw new Error('A card needs a title.');
  project.cards = project.cards || [];
  const card = {
    id: rid(), title, details: String(body.details || '').trim().slice(0, 8000),
    agentId: null, column: 'backlog', order: 0, createdAt: new Date().toISOString(),
  };
  project.cards.push(card);
  placeCard(project, card, COLUMNS.includes(body.column) ? body.column : 'backlog');
  saveState();
  return card;
}

function updateCard(project, card, body) {
  if (body.title !== undefined) card.title = String(body.title).trim().slice(0, 200) || card.title;
  if (body.details !== undefined) card.details = String(body.details).trim().slice(0, 8000);
  if (body.agentId !== undefined) card.agentId = project.agents.some((a) => a.id === body.agentId) ? body.agentId : null;
  if (body.column !== undefined || body.before !== undefined) placeCard(project, card, body.column || card.column, body.before);
  else card.updatedAt = new Date().toISOString();
  saveState();
  return card;
}

function taskPrompt(card) {
  return [
    `New task from the AgentDeck board: ${card.title}`,
    card.details ? `\n${card.details}` : '',
    '\nWhen it is finished, commit your work and reply with a short summary of what you did.',
  ].join('\n').trim();
}

// The running Claude session of an agent, ready to receive a message, or an error saying why not.
function readySession(agent) {
  if (agent.kind !== 'claude') throw new Error(`${agent.name} is a plain terminal, not a Claude agent.`);
  const s = sessions.get(agent.id);
  if (!s || s.status !== 'running') throw new Error(`${agent.name} isn't running. Press ↻ on its pane first.`);
  // Claude's startup "trust this folder?" question would swallow the message (and Enter could pick "No, exit").
  if (trustQuestionShowing(s)) {
    throw new Error(`${agent.name} is still asking whether you trust the folder. Answer that in its pane first (↓ then Enter).`);
  }
  return s;
}

// Type a message into a Claude session and send it. Bracketed paste keeps a multi-line message together.
function typeInto(s, text) {
  s.pty.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => { if (s.status === 'running') s.pty.write('\r'); }, 250);
  s.typed = true;
}

// Hand a card to a Claude agent: type the task into its terminal and move the card to "In progress".
function sendCard(project, card, agent) {
  typeInto(readySession(agent), taskPrompt(card));
  card.agentId = agent.id;
  placeCard(project, card, 'progress');
  saveState();
  return card;
}

// ------------------------------------------------------------------ the Lead and shared notes

const leadOf = (project) => project.agents.find((a) => a.lead && a.kind === 'claude');
const busy = (agent) => ['working', 'needs'].includes(sessionInfo(agent.id, agent.kind).display);

// Updates for the Lead wait in its inbox until it's free (never typed into a permission question).
function tellLead(project, from, text) {
  const lead = leadOf(project);
  if (!lead || lead.id === from.id) return;
  const s = sessions.get(lead.id);
  if (!s || s.status !== 'running') return;
  (s.inbox = s.inbox || []).push(text);
  flushLead(lead);
}

function flushLead(lead) {
  const s = sessions.get(lead.id);
  if (!s || s.status !== 'running' || !s.inbox?.length || !['ready', 'done'].includes(s.phase)) return;
  const text = s.inbox.splice(0).join('\n\n');
  typeInto(s, `[AgentDeck update]\n${text}\n\nDecide the next step: assign the next card, ask a reviewer or tester, send a fix request, or tell the user the goal is done.`);
  setPhase(s, 'working');
}
setInterval(() => { for (const p of state.projects) { const l = leadOf(p); if (l) flushLead(l); } }, 3000).unref();

function addNote(project, text, author) {
  const note = String(text || '').trim().slice(0, 600);
  if (!note) throw new Error('A note needs some text.');
  project.notes = project.notes || [];
  const n = { id: rid(), text: note, author, at: new Date().toISOString() };
  project.notes.push(n);
  if (project.notes.length > 200) project.notes.shift();
  saveState();
  return n;
}

function findNamedAgent(project, name) {
  const want = String(name || '').trim().toLowerCase();
  const a = project.agents.find((x) => x.name.toLowerCase() === want)
    || project.agents.find((x) => x.name.toLowerCase().startsWith(want) && want);
  if (!a) throw new Error(`No agent called "${name}". Agents: ${project.agents.map((x) => x.name).join(', ') || 'none'}.`);
  return a;
}

function findNamedCard(project, ref) {
  const want = String(ref || '').trim().toLowerCase();
  const cards = project.cards || [];
  const c = cards.find((x) => x.id === ref) || cards.find((x) => x.title.toLowerCase() === want);
  if (c) return c;
  const near = cards.filter((x) => x.title.toLowerCase().includes(want) && want);
  if (near.length === 1) return near[0];
  throw new Error(near.length ? `Several cards match "${ref}"; use the card id.` : `No card "${ref}". Use the board tool to see card ids.`);
}

const COLUMN_NAMES = { backlog: 'Backlog', progress: 'In progress', review: 'Review', done: 'Done' };

// The AgentDeck tools agents call through mcp.js. Returns text for the agent; throws for tool errors.
function mcpTool(project, me, tool, args) {
  const needLead = () => { if (!me.lead) throw new Error('Only the Lead can do that. Save a note or tell the user instead.'); };
  const canTake = (agent) => {
    if (agent.id === me.id) throw new Error("You can't assign work to yourself.");
    readySession(agent);
    if (busy(agent)) throw new Error(`${agent.name} is busy right now. You'll get an AgentDeck update when it finishes; assign it then, or pick a free agent.`);
  };
  const who = (id) => project.agents.find((a) => a.id === id)?.name || 'nobody';
  switch (tool) {
    case 'agents':
      return project.agents.map((a) => {
        const st = sessionInfo(a.id, a.kind);
        const doing = (project.cards || []).find((c) => c.agentId === a.id && c.column === 'progress');
        return `- ${a.name}${a.id === me.id ? ' (you)' : ''}${a.lead ? ' [Lead]' : ''}: ${a.kind === 'shell' ? 'plain terminal' : `${a.role ? a.role.split(/[.:]/)[0] : 'agent'}, ${a.model || 'default model'}`}`
          + ` | ${STATUS_WORDS[st.display]}${st.note ? ` (${st.note})` : ''} | ${a.mode === 'worktree' ? `own copy on ${a.branch}` : 'main folder'}`
          + `${doing ? ` | working on "${doing.title}"` : ''}`;
      }).join('\n') || 'No agents yet.';
    case 'board': {
      const cards = project.cards || [];
      if (!cards.length) return 'The board is empty.';
      return Object.keys(COLUMN_NAMES).map((col) => {
        const list = cards.filter((c) => c.column === col).sort((a, b) => a.order - b.order);
        return `${COLUMN_NAMES[col]}:\n${list.map((c) => `- [${c.id}] ${c.title} | ${c.agentId ? who(c.agentId) : 'unassigned'}`
          + `${c.details ? `\n  details: ${c.details.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
          + `${c.summary ? `\n  finished with: ${c.summary.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`).join('\n') || '- (none)'}`;
      }).join('\n\n');
    }
    case 'notes': {
      const q = String(args.search || '').toLowerCase();
      const list = (project.notes || []).filter((n) => !q || n.text.toLowerCase().includes(q));
      return list.map((n) => `- ${n.text} (${n.author})`).join('\n') || (q ? `No notes about "${args.search}".` : 'No shared notes yet.');
    }
    case 'remember':
      addNote(project, args.note, me.name);
      return 'Saved as a shared note.';
    case 'create_card': {
      if (args.assign_to) needLead();
      const target = args.assign_to ? findNamedAgent(project, args.assign_to) : null;
      if (target) canTake(target);
      const c = createCard(project, { title: args.title, details: args.details });
      c.by = me.name;
      if (target) {
        sendCard(project, c, target);
        return `Created card [${c.id}] "${c.title}" and gave it to ${target.name}. You'll get an AgentDeck update when it finishes.`;
      }
      saveState();
      return `Created card [${c.id}] "${c.title}" in Backlog.`;
    }
    case 'assign_card': {
      needLead();
      const c = findNamedCard(project, args.card);
      const target = findNamedAgent(project, args.agent);
      canTake(target);
      sendCard(project, c, target);
      return `Gave "${c.title}" to ${target.name}. You'll get an AgentDeck update when it finishes.`;
    }
    case 'move_card': {
      const c = findNamedCard(project, args.card);
      if (!me.lead && c.agentId !== me.id) throw new Error('You can only move your own cards.');
      if (!COLUMN_NAMES[args.column]) throw new Error('Column must be backlog, progress, review or done.');
      placeCard(project, c, args.column);
      saveState();
      return `Moved "${c.title}" to ${COLUMN_NAMES[args.column]}.`;
    }
    case 'message_agent': {
      needLead();
      const target = findNamedAgent(project, args.agent);
      canTake(target);
      const text = String(args.message || '').trim();
      if (!text) throw new Error('The message is empty.');
      const s = sessions.get(target.id);
      typeInto(s, `Message from ${me.name} (the Lead): ${text}`);
      s.replyToLead = true;
      return `Sent to ${target.name}. You'll get its reply as an AgentDeck update.`;
    }
    default:
      throw new Error(`Unknown AgentDeck tool "${tool}".`);
  }
}
const STATUS_WORDS = { working: 'working', needs: 'waiting for the user', done: 'finished, free', ready: 'free', stopped: 'stopped' };

// ------------------------------------------------------------------ status from Claude Code hooks

// Each Claude agent starts with `--settings <file>` holding hooks that report its lifecycle back here,
// so nothing is added to your global Claude settings or to the project. curl ships with Windows.
const HOOK_DIR = path.join(DATA_DIR, 'hooks');
const hookLog = []; // last events, for troubleshooting at /api/hook-log

function hookSettingsFile(agent) {
  fs.mkdirSync(HOOK_DIR, { recursive: true });
  // `|| exit 0`: if AgentDeck is closed, the hook quietly does nothing instead of bothering Claude.
  const cmd = (event) => `curl -s -m 3 -X POST -H "Content-Type: application/json" -H "X-AgentDeck: 1" `
    + `--data-binary @- http://127.0.0.1:${PORT}/api/hook/${agent.id}/${event} || exit 0`;
  const on = (event, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(event), timeout: 5 }] });
  const file = path.join(HOOK_DIR, `${agent.id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ['mcp__agentdeck'] }, // its own AgentDeck tools never need a permission click
    hooks: {
      SessionStart: [on('SessionStart')],
      UserPromptSubmit: [on('UserPromptSubmit')],
      Notification: [on('Notification')],
      Stop: [on('Stop')],
      PreToolUse: [on('Ask', 'AskUserQuestion|ExitPlanMode')],
    },
  }, null, 2));
  return file;
}

// The AgentDeck tools (mcp.js) for one agent, passed with --mcp-config. Added to the user's own MCP servers.
function mcpConfigFile(agent) {
  const dir = path.join(DATA_DIR, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agent.id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      agentdeck: {
        type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'mcp.js')],
        env: { AGENTDECK_AGENT_ID: agent.id, AGENTDECK_PORT: String(PORT) },
      },
    },
  }, null, 2));
  return file;
}

function setPhase(s, phase, note = '') {
  s.phase = phase;
  s.note = note;
  s.phaseAt = Date.now();
}

function onHook(project, agent, event, payload) {
  hookLog.push({ at: new Date().toISOString(), agent: agent.name, event,
    type: payload.notification_type, message: payload.message, tool: payload.tool_name });
  if (hookLog.length > 60) hookLog.shift();
  const s = sessions.get(agent.id);
  if (!s || s.status !== 'running') return;
  if (event === 'SessionStart') {
    setPhase(s, 'ready');
    if (agent.lead) setTimeout(() => flushLead(agent), 500);
    // Remember which conversation this agent is in (it changes after /clear), to resume it after a restart.
    if (payload.session_id && payload.session_id !== agent.sessionId) {
      agent.sessionId = String(payload.session_id);
      agent.transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
      agent.sessionTracked = true;
      saveState();
    }
  }
  else if (event === 'UserPromptSubmit') setPhase(s, 'working');
  else if (event === 'Ask') setPhase(s, 'needs', payload.tool_name === 'ExitPlanMode' ? 'Wants you to approve its plan' : 'Asked you a question');
  else if (event === 'Notification') {
    const msg = String(payload.message || '');
    // Permission requests always need you. "Waiting for your input" only matters mid-task, not after it finished.
    if (/permission/i.test(`${payload.notification_type || ''} ${msg}`)) setPhase(s, 'needs', msg || 'Needs your permission');
    else if (s.phase === 'working') setPhase(s, 'needs', msg || 'Waiting for you');
  } else if (event === 'Stop') {
    setPhase(s, 'done');
    const finished = finishCards(project, agent, payload);
    // Keep the Lead in the loop: finished cards and replies to its messages become an update for it.
    const said = (finished[0]?.summary || cleanSummary(payload.last_assistant_message)).slice(0, 700);
    if (finished.length) {
      tellLead(project, agent, finished.map((c) => `${agent.name} finished card [${c.id}] "${c.title}" (now in Review).`).join('\n')
        + (said ? `\nIts final message: ${said}` : ''));
    } else if (s.replyToLead) {
      tellLead(project, agent, `${agent.name} replied to your message: ${said || '(no text)'}`);
    }
    s.replyToLead = false;
    if (agent.lead) flushLead(agent);
  }
}

function cleanSummary(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}

// When an agent finishes its turn, its "In progress" cards move to Review with what it said.
function finishCards(project, agent, payload) {
  const cards = (project.cards || []).filter((c) => c.agentId === agent.id && c.column === 'progress');
  if (!cards.length) return [];
  // Claude sends its final message with the Stop event; the transcript is only a fallback (it can lag behind).
  const summary = cleanSummary(payload.last_assistant_message) || lastAssistantText(payload.transcript_path);
  for (const c of cards) {
    if (summary) c.summary = summary;
    c.finishedAt = new Date().toISOString();
    placeCard(project, c, 'review');
  }
  saveState();
  return cards;
}

// The agent's final message, read from its Claude transcript (only files under ~/.claude are read).
function lastAssistantText(file) {
  const home = path.join(os.homedir(), '.claude');
  if (typeof file !== 'string' || !path.resolve(file).toLowerCase().startsWith(home.toLowerCase())) return '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const content = o.type === 'assistant' && o.message?.content;
      const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() : '';
      if (text) return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
    }
  } catch { /* transcript not readable */ }
  return '';
}

// ------------------------------------------------------------------ terminal sessions

const sessions = new Map(); // agent id -> session

function agentEnv(project, agent) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!(BLOCK_API_KEYS && BLOCKED_ENV.has(k.toUpperCase())) && !SESSION_ENV.test(k)) env[k] = v;
  }
  return Object.assign(env, {
    TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1',
    AGENTDECK: '1', AGENTDECK_AGENT: agent.name, AGENTDECK_PROJECT: project.name,
  });
}

const LEAD_PROMPT = ' You are the Lead of this AgentDeck team and you do not write or edit code yourself.'
  + ' When the user gives you a goal: look at the agents tool and the notes tool, break the goal into small cards (one feature or fix each,'
  + ' ideally touching different files so agents do not collide) and create them with create_card.'
  + ' Give each free Builder one card at a time (create_card with assign_to, or assign_card) and keep the rest in Backlog.'
  + ' Each agent works in its own copy on its own branch. When an [AgentDeck update] says an agent finished, read its final message,'
  + ' then assign its next card, ask a Reviewer or Tester to check that branch (message_agent or a card), or send a fix request.'
  + ' Save key decisions with remember. Keep the user posted in short messages, and tell them when everything is in Review and ready'
  + ' to merge. Never merge branches yourself, and never assign work to an agent that is busy or waiting for the user.';

function rolePrompt(project, agent) {
  const where = agent.mode === 'worktree'
    ? `You work in your own git worktree on branch ${agent.branch}; other agents work on their own branches. Commit your work on your branch with a clear message whenever a piece is finished.`
    : 'You work directly in the main project folder, and other agents may be editing files there too, so keep changes focused.';
  const role = agent.role ? ` Your role: ${agent.role}` : '';
  const tools = agent.lead ? LEAD_PROMPT
    : ' The AgentDeck tools (agents, board, notes, remember, move_card) show you the team, the task board and the shared notes.'
      + ' Read the notes tool before you start a task, and use remember to save facts or decisions the other agents must know.';
  return `You are "${agent.name}", one of several AI agents working in parallel on the project "${project.name}" in AgentDeck. ${where}${role}${tools}`
    .replace(/[\r\n"]+/g, ' ');
}

// Claude Code keeps a folder's conversations in ~/.claude/projects/<folder, non-alphanumerics as "-">.
function newestConversation(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.slice(0, -6), at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return files[0]?.id || null;
  } catch {
    return null;
  }
}

function startSession(project, agent, { fresh = false } = {}) {
  stopSession(agent.id);
  let file = 'powershell.exe';
  let args = ['-NoLogo'];
  if (agent.kind === 'claude') {
    file = CLAUDE;
    args = [];
    if (agent.model) args.push('--model', agent.model);
    args.push('--append-system-prompt', rolePrompt(project, agent));
    args.push('--settings', hookSettingsFile(agent));
    args.push('--mcp-config', mcpConfigFile(agent));
    // Reopen exactly this agent's own conversation (its id comes from the SessionStart hook). Never
    // "the folder's latest": a new agent reusing a deleted agent's name/folder must start fresh.
    if (fresh) {
      agent.sessionId = null;
      agent.transcript = null;
    } else if (agent.sessionId && agent.transcript && fs.existsSync(agent.transcript)) {
      args.push('--resume', agent.sessionId);
    } else if (!agent.sessionTracked && agent.mode === 'worktree') {
      // Agents made before AgentDeck tracked conversation ids: their own copy's latest conversation is theirs.
      const latest = newestConversation(agent.cwd);
      if (latest) args.push('--resume', latest);
    }
  }
  const prev = sessions.get(agent.id);
  const s = {
    clients: prev ? prev.clients : new Set(), chunks: [], size: 0,
    status: 'running', exitCode: null, startedAt: Date.now(), lastOutput: 0, cols: 120, rows: 32,
    phase: 'starting', note: '', phaseAt: Date.now(),
  };
  try {
    s.pty = pty.spawn(file, args, { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: agent.cwd, env: agentEnv(project, agent) });
  } catch (e) {
    s.status = 'exited';
    emit(s, `\r\n\x1b[31m[AgentDeck] Could not start: ${e.message}\x1b[0m\r\n`);
    sessions.set(agent.id, s);
    return s;
  }
  s.pty.onData((d) => {
    s.lastOutput = Date.now();
    emit(s, d);
  });
  s.exited = new Promise((resolve) => { s.onExited = resolve; });
  s.pty.onExit(({ exitCode }) => {
    s.onExited();
    if (sessions.get(agent.id) !== s) return;
    s.status = 'exited';
    s.exitCode = exitCode;
    emit(s, `\r\n\x1b[90m[AgentDeck] ${agent.kind === 'claude' ? 'Claude' : 'Terminal'} exited (code ${exitCode}). Press Restart to start it again.\x1b[0m\r\n`);
  });
  sessions.set(agent.id, s);
  for (const ws of s.clients) ws.send(JSON.stringify({ t: 'reset' }));
  return s;
}

function emit(s, data) {
  s.chunks.push(data);
  s.size += data.length;
  while (s.size > BUFFER_LIMIT && s.chunks.length > 1) s.size -= s.chunks.shift().length;
  const msg = JSON.stringify({ t: 'out', d: data });
  for (const ws of s.clients) if (ws.readyState === 1) ws.send(msg);
}

// Resolves once the process has really exited (or after 4 s), so callers can then touch its folder.
function stopSession(id) {
  const s = sessions.get(id);
  if (!s || !s.pty) return Promise.resolve();
  if (s.status === 'running') {
    s.status = 'exited';
    try { s.pty.kill(); } catch { /* already gone */ }
  }
  return Promise.race([s.exited || Promise.resolve(), sleep(4000)]).then(() => sleep(300));
}

// What the UI shows: stopped, needs (you), working, done (finished its turn) or ready.
function sessionInfo(id, kind) {
  const s = sessions.get(id);
  if (!s) return { status: 'stopped', display: 'stopped' };
  const active = s.status === 'running' && Date.now() - s.lastOutput < ACTIVE_MS;
  // Claude's spinner redraws constantly while it works; 20 s of silence means it was interrupted (Esc).
  if (s.phase === 'working' && Date.now() - s.lastOutput > 20_000 && Date.now() - s.phaseAt > 20_000) setPhase(s, 'ready');
  let display;
  let note = s.note;
  if (s.status !== 'running') display = 'stopped';
  else if (kind === 'claude' && s.phase === 'starting' && trustQuestionShowing(s)) {
    // Claude's startup question runs before any hook, so spot it on screen: it's a question for you.
    display = 'needs';
    note = 'Asks whether you trust this folder: press ↓ then Enter in its pane for "Yes"';
  } else if (kind === 'shell' || s.phase === 'starting') display = active ? 'working' : 'ready';
  else display = s.phase;
  return { status: s.status, display, note, since: s.phaseAt, exitCode: s.exitCode };
}

function trustQuestionShowing(s) {
  if (s.typed) return false;
  // Claude draws that screen with cursor moves between words, so turn escape codes into spaces first.
  const recent = s.chunks.slice(-40).join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ');
  return /trust\s*this\s*folder/i.test(recent);
}

// ------------------------------------------------------------------ review and merge

const DIFF_LIMIT = 400_000; // characters of diff sent to the page

// Commits AgentDeck makes use your git name if git knows it, otherwise "AgentDeck".
async function identity(repo) {
  const name = await git(repo, ['config', 'user.name']).catch(() => '');
  const email = await git(repo, ['config', 'user.email']).catch(() => '');
  return name && email ? [] : ['-c', `user.name=${name || 'AgentDeck'}`, '-c', `user.email=${email || 'agentdeck@localhost'}`];
}

const porcelain = async (dir) => (await git(dir, ['status', '--porcelain'], { raw: true })).split('\n').filter(Boolean).map((l) => l.slice(3));

function needCopy(agent) {
  if (agent.mode !== 'worktree') throw new Error(`${agent.name} works in the main folder, so its changes are already there: nothing to merge.`);
}

// What an agent's branch adds on top of main: commits, files, the diff, and unsaved work in its copy.
async function agentChanges(project, agent) {
  needCopy(agent);
  const base = agent.base || (await gitInfo(project.path)).branch;
  const range = `${base}...${agent.branch}`;
  const [log, numstat, names, diff, behind, uncommitted] = await Promise.all([
    git(project.path, ['log', '--format=%h%x09%s', `${base}..${agent.branch}`]),
    git(project.path, ['diff', '--numstat', range]),
    git(project.path, ['diff', '--name-status', range]),
    git(project.path, ['diff', '--no-color', range], { raw: true }),
    git(project.path, ['rev-list', '--count', `${agent.branch}..${base}`]),
    fs.existsSync(agent.cwd) ? porcelain(agent.cwd) : Promise.resolve([]),
  ]);
  const kinds = new Map(names.split('\n').filter(Boolean).map((l) => { const p = l.split('\t'); return [p[p.length - 1], p[0][0]]; }));
  return {
    base, branch: agent.branch, behind: Number(behind) || 0, uncommitted,
    commits: log.split('\n').filter(Boolean).map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; }),
    files: numstat.split('\n').filter(Boolean).map((l) => {
      const [add, del, ...p] = l.split('\t');
      const file = p.join('\t');
      return { path: file, add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del), kind: kinds.get(file) || 'M' };
    }),
    diff: diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n… (the rest of the changes is cut off here)` : diff,
  };
}

// Bring an agent's copy up to date with main, so its next task builds on everyone's merged work.
// Only when it's idle and has no unsaved changes; a conflict is undone straight away.
async function updateCopy(project, agent, base) {
  if (agent.mode !== 'worktree' || !fs.existsSync(agent.cwd)) return null;
  const behind = Number(await git(project.path, ['rev-list', '--count', `${agent.branch}..${base}`]).catch(() => 0));
  if (!behind) return { name: agent.name, ok: true, note: 'already up to date' };
  if (busy(agent)) return { name: agent.name, ok: false, note: 'busy, update later' };
  if ((await porcelain(agent.cwd)).length) return { name: agent.name, ok: false, note: 'has unsaved changes' };
  try {
    await git(agent.cwd, [...await identity(agent.cwd), 'merge', '--no-edit', base]);
    return { name: agent.name, ok: true, note: 'updated' };
  } catch {
    await git(agent.cwd, ['merge', '--abort']).catch(() => {});
    return { name: agent.name, ok: false, note: 'would conflict, left as it was' };
  }
}

async function mergeAgent(project, agent, { saveMainFirst = false } = {}) {
  needCopy(agent);
  const info = await gitInfo(project.path);
  const base = agent.base || info.branch;
  if (info.branch !== base) throw new Error(`Your main folder is on branch "${info.branch}", not "${base}". Switch it back to ${base} first.`);
  if (busy(agent)) throw new Error(`${agent.name} is still working (or waiting for you). Merge when it has finished.`);
  const ahead = Number(await git(project.path, ['rev-list', '--count', `${base}..${agent.branch}`]));
  if (!ahead) {
    const unsaved = fs.existsSync(agent.cwd) ? await porcelain(agent.cwd) : [];
    throw new Error(unsaved.length ? `${agent.name} changed files but didn't commit them yet. Ask it to commit, then merge.`
      : `${agent.name} has nothing new to merge.`);
  }
  const id = await identity(project.path);
  const dirty = await porcelain(project.path);
  if (dirty.length) {
    // Never mix a merge with uncommitted edits in your main folder: ask first, then save them as their own commit.
    if (!saveMainFirst) return { mainDirty: dirty };
    await git(project.path, ['add', '-A']);
    await git(project.path, [...id, 'commit', '-m', 'Work in progress (saved by AgentDeck before a merge)']);
  }
  const titles = (project.cards || []).filter((c) => c.agentId === agent.id && c.column === 'review').map((c) => c.title);
  const message = `Merge ${agent.name} (${agent.branch})${titles.length ? `: ${titles.join('; ')}` : ''}`.slice(0, 300);
  try {
    await git(project.path, [...id, 'merge', '--no-ff', '--no-edit', '-m', message, agent.branch]);
  } catch (e) {
    const conflicts = (await git(project.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    await git(project.path, ['merge', '--abort']).catch(() => {});
    if (conflicts.length) return { conflict: true, files: conflicts };
    throw new Error(`The merge didn't go through, and nothing was changed: ${e.message}`);
  }
  for (const c of project.cards || []) if (c.agentId === agent.id && c.column === 'review') placeCard(project, c, 'done');
  saveState();
  const updated = [];
  for (const a of project.agents) {
    const r = await updateCopy(project, a, base);
    if (r && r.note !== 'already up to date') updated.push(r);
  }
  aheadCache.clear();
  tellLead(project, agent, `The user merged ${agent.name}'s work (${agent.branch}) into ${base}.`
    + `${titles.length ? ` These cards are now Done: ${titles.join('; ')}.` : ''}`);
  return { merged: true, commits: ahead, base, updated };
}

// Send work back to an agent (review feedback or a merge conflict to fix); its Review cards go back to In progress.
function sendBack(project, agent, text) {
  const s = readySession(agent);
  if (busy(agent)) throw new Error(`${agent.name} is busy right now. Try again when it has finished.`);
  const msg = String(text || '').trim();
  if (!msg) throw new Error('Write what should change.');
  typeInto(s, msg);
  for (const c of project.cards || []) if (c.agentId === agent.id && c.column === 'review') placeCard(project, c, 'progress');
  saveState();
}

const conflictRequest = (agent, files) => `Your branch ${agent.branch} conflicts with ${agent.base || 'main'} in: ${files.join(', ')}.`
  + ` Please run "git merge ${agent.base || 'main'}" in your copy, resolve the conflicts so both sides' changes keep working,`
  + ' commit the merge, and reply with a short summary of how you resolved them.';

// How many commits each agent copy has that main doesn't (for the "N to merge" badges). Cached briefly.
const aheadCache = new Map();
async function aheadOf(project, agent) {
  if (agent.mode !== 'worktree' || !agent.branch) return 0;
  const hit = aheadCache.get(agent.id);
  if (hit && Date.now() - hit.at < 4000) return hit.n;
  const n = Number(await git(project.path, ['rev-list', '--count', `${agent.base || 'HEAD'}..${agent.branch}`]).catch(() => 0)) || 0;
  aheadCache.set(agent.id, { at: Date.now(), n });
  return n;
}

// ------------------------------------------------------------------ helpers for the UI

function listFolders() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(APPS_DIR, { withFileTypes: true }); } catch { /* folder missing */ }
  for (const e of entries) {
    if (!e.isDirectory() || /^[._]/.test(e.name)) continue;
    const full = path.join(APPS_DIR, e.name);
    out.push({ name: e.name, path: full, git: fs.existsSync(path.join(full, '.git')) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let picking = null; // the folder picker that is open right now, if any

function pickFolder() {
  if (picking) return Promise.resolve({ busy: true });
  // No windowsHide here: a hidden start would make the picker window invisible too.
  picking = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'pick-folder.ps1'), APPS_DIR],
      (err, stdout, stderr) => {
        picking = null;
        if (err) console.error('[AgentDeck] folder picker failed:', (stderr || err.message).trim());
        resolve({ path: err ? '' : stdout.trim(), error: err ? 'The folder picker could not open. Paste the folder path instead.' : undefined });
      });
  });
  return picking;
}

async function publicState() {
  const projects = await Promise.all(state.projects.map(async (p) => {
    const info = await gitInfo(p.path);
    const ahead = await Promise.all(p.agents.map((a) => (info.hasCommits ? aheadOf(p, a) : 0)));
    return {
      ...p, exists: fs.existsSync(p.path), git: info, cards: p.cards || [], notes: p.notes || [],
      agents: p.agents.map((a, i) => ({ ...a, ahead: ahead[i], session: sessionInfo(a.id, a.kind) })),
    };
  }));
  return {
    projects, activeProject: state.activeProject, columns: state.columns || 'auto',
    boardOpen: state.boardOpen !== false, appsDir: APPS_DIR, bootId: BOOT_ID, previewPort: previewUp ? PREVIEW_PORT : null,
  };
}

// ------------------------------------------------------------------ http

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/icon.png': ['public/icon.png', 'image/png'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) { req.destroy(); reject(new Error('Request too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  // Changes need our custom header: browsers won't let another website send it to localhost.
  if (method !== 'GET' && req.headers['x-agentdeck'] !== '1') return send(res, 403, { error: 'forbidden' });
  const body = method === 'GET' ? {} : await readBody(req);

  if (method === 'POST' && parts[1] === 'hook') {
    const { project, agent } = findAgent(parts[2]);
    if (agent) onHook(project, agent, String(parts[3] || ''), body && typeof body === 'object' ? body : {});
    return send(res, 200, {});
  }
  if (method === 'GET' && parts[1] === 'hook-log') return send(res, 200, hookLog);
  if (method === 'POST' && parts[1] === 'mcp') {
    const { project, agent } = findAgent(parts[2]);
    if (!agent) return send(res, 404, { error: 'This agent is no longer in AgentDeck.' });
    try {
      return send(res, 200, { text: mcpTool(project, agent, String(parts[3] || ''), body || {}) });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (parts[1] === 'notes' && method === 'DELETE') {
    for (const p of state.projects) p.notes = (p.notes || []).filter((n) => n.id !== parts[2]);
    saveState();
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && parts[1] === 'state') return send(res, 200, await publicState());
  if (method === 'GET' && parts[1] === 'folders') return send(res, 200, listFolders());
  if (method === 'POST' && parts[1] === 'pick-folder') return send(res, 200, await pickFolder());
  if (method === 'PUT' && parts[1] === 'ui') {
    if (body.activeProject !== undefined && findProject(body.activeProject)) state.activeProject = body.activeProject;
    if (['auto', '1', '2', '3', '4'].includes(String(body.columns))) state.columns = String(body.columns);
    if (typeof body.boardOpen === 'boolean') state.boardOpen = body.boardOpen;
    saveState();
    return send(res, 200, { ok: true });
  }

  if (parts[1] === 'projects') {
    if (method === 'POST' && parts.length === 2) return send(res, 200, await addProject(body.path));
    const project = findProject(parts[2]);
    if (!project) return send(res, 404, { error: 'Project not found' });
    if (method === 'GET' && parts[3] === 'git-plan') return send(res, 200, scanForGit(project.path));
    if (method === 'POST' && parts[3] === 'git-init') return send(res, 200, await setupGit(project, body.patterns));
    if (method === 'POST' && parts[3] === 'agents') return send(res, 200, await createAgent(project, body));
    if (method === 'POST' && parts[3] === 'cards') return send(res, 200, createCard(project, body));
    if (method === 'POST' && parts[3] === 'notes') return send(res, 200, addNote(project, body.text, 'You'));
    if (method === 'DELETE' && parts.length === 3) {
      project.agents.forEach((a) => stopSession(a.id));
      state.projects = state.projects.filter((p) => p !== project);
      if (state.activeProject === project.id) state.activeProject = state.projects[0]?.id || null;
      saveState();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'agents') {
    const { project, agent } = findAgent(parts[2]);
    if (!agent) return send(res, 404, { error: 'Agent not found' });
    if (method === 'POST' && parts[3] === 'restart') { startSession(project, agent, { fresh: !!body.fresh }); return send(res, 200, { ok: true }); }
    if (method === 'POST' && parts[3] === 'stop') { stopSession(agent.id); return send(res, 200, { ok: true }); }
    if (method === 'DELETE' && parts.length === 3) return send(res, 200, { notes: await removeAgent(project, agent, !!body.removeWorktree) });
    if (method === 'GET' && parts[3] === 'changes') return send(res, 200, await agentChanges(project, agent));
    if (method === 'POST' && parts[3] === 'merge') return send(res, 200, await mergeAgent(project, agent, { saveMainFirst: !!body.saveMainFirst }));
    if (method === 'POST' && parts[3] === 'update') {
      needCopy(agent);
      const r = await updateCopy(project, agent, agent.base || (await gitInfo(project.path)).branch);
      aheadCache.delete(agent.id);
      return send(res, 200, r || {});
    }
    if (method === 'POST' && parts[3] === 'send-back') {
      sendBack(project, agent, body.conflicts ? conflictRequest(agent, body.conflicts) : body.text);
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'cards') {
    const { project, card } = findCard(parts[2]);
    if (!card) return send(res, 404, { error: 'Card not found' });
    if (method === 'PUT' && parts.length === 3) return send(res, 200, updateCard(project, card, body));
    if (method === 'POST' && parts[3] === 'send') {
      const agent = project.agents.find((a) => a.id === body.agentId);
      if (!agent) return send(res, 404, { error: 'Agent not found' });
      return send(res, 200, sendCard(project, card, agent));
    }
    if (method === 'DELETE' && parts.length === 3) {
      project.cards = project.cards.filter((c) => c !== card);
      saveState();
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = STATIC[url.pathname];
    const content = file && await fs.promises.readFile(path.join(ROOT, file[0])).catch(() => null);
    if (!content) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': `${file[1]}${file[1].startsWith('text') ? '; charset=utf-8' : ''}`, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// ------------------------------------------------------------------ websockets (one per terminal pane)

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only the AgentDeck page itself may attach to a terminal.
  if (!ALLOWED_HOSTS.has(req.headers.host) || !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, '')) || url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, url.searchParams.get('agent')));
});

function attach(ws, agentId) {
  const { project, agent } = findAgent(agentId);
  if (!agent) return ws.close();
  let s = sessions.get(agent.id);
  if (!s) s = startSession(project, agent);
  s.clients.add(ws);
  ws.send(JSON.stringify({ t: 'out', d: s.chunks.join('') }));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const cur = sessions.get(agent.id);
    if (!cur || !cur.pty || cur.status !== 'running') return;
    if (m.t === 'in' && typeof m.d === 'string') {
      cur.pty.write(m.d);
      cur.typed = true;
      if (cur.phase === 'needs') setPhase(cur, 'working'); // you answered it
    }
    if (m.t === 'resize' && m.cols > 10 && m.rows > 3 && (m.cols !== cur.cols || m.rows !== cur.rows)) {
      cur.cols = Math.min(m.cols, 500);
      cur.rows = Math.min(m.rows, 200);
      try { cur.pty.resize(cur.cols, cur.rows); } catch { /* exited */ }
    }
  });
  ws.on('close', () => sessions.get(agent.id)?.clients.delete(ws));
}

// ------------------------------------------------------------------ live preview (separate port)

// Serves a project's main folder or an agent's copy as a website for the Preview panel. It runs on its own
// port, so a page an agent builds is a different origin and can never call AgentDeck's API.
// Read-only (GET), local only, and never serves dot-files or dot-folders (.env, .git, .agentdeck).
const PREVIEW_PORT = PORT + 1;
const PREVIEW_HOSTS = new Set([`localhost:${PREVIEW_PORT}`, `127.0.0.1:${PREVIEW_PORT}`]);
const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  wasm: 'application/wasm', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', pdf: 'application/pdf', xml: 'application/xml',
};
let previewUp = false;

const previewServer = http.createServer(async (req, res) => {
  const deny = (code, msg = '') => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
  if (!PREVIEW_HOSTS.has(req.headers.host) || !['GET', 'HEAD'].includes(req.method)) return deny(403);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, projectId, target, ...rest] = url.pathname.split('/');
  const project = findProject(projectId);
  const root = project && (target === 'main' ? project.path : project.agents.find((a) => a.id === target)?.cwd);
  if (!root || !fs.existsSync(root)) return deny(404, 'Nothing to preview here.');
  let rel;
  try { rel = decodeURIComponent(rest.join('/')); } catch { return deny(400); }
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return deny(404, 'Not found');
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (file !== base && !file.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return deny(403);
  let st;
  try { st = await fs.promises.stat(file); } catch { return deny(404, 'Not found'); }
  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(302, { Location: `${url.pathname}/` }); return res.end(); }
    const index = path.join(file, 'index.html');
    if (fs.existsSync(index)) return sendFile(res, index, req.method);
    const ents = (await fs.promises.readdir(file, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>${esc(rel || 'Files')}</title>
      <style>body{font:14px/1.6 system-ui,sans-serif;margin:24px;background:#fff;color:#222}a{color:#4b3cc9;text-decoration:none}a:hover{text-decoration:underline}p{color:#777}</style>
      <p>No index.html here. Pick a file:</p><ul>${rel ? '<li><a href="../">../</a></li>' : ''}${ents.map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('')}</ul>`);
  }
  return sendFile(res, file, req.method);
});

function sendFile(res, file, method) {
  const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type.startsWith('text') || type.endsWith('json') ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-store' });
  if (method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.end()).pipe(res);
}

previewServer.on('error', (e) => console.error(`[AgentDeck] live preview unavailable (port ${PREVIEW_PORT}): ${e.message}`));

// ------------------------------------------------------------------ start

function openWindow() {
  if (!CHROME || process.argv.includes('--no-open')) return;
  spawn(CHROME, [`--app=http://localhost:${PORT}`, '--window-size=1600,960'], { detached: true, stdio: 'ignore' }).unref();
}

function shutdown() {
  for (const id of sessions.keys()) stopSession(id);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
// A crash here would kill every agent's terminal, so log unexpected errors and keep serving.
process.on('uncaughtException', (e) => console.error('[AgentDeck] unexpected error:', e));
process.on('unhandledRejection', (e) => console.error('[AgentDeck] unexpected error:', e));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('AgentDeck is already running, opening its window.');
    openWindow();
    setTimeout(() => process.exit(0), 500);
  } else {
    throw e;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  previewServer.listen(PREVIEW_PORT, '127.0.0.1', () => { previewUp = true; });
  process.title = 'AgentDeck';
  console.log(`AgentDeck running at http://localhost:${PORT}`);
  console.log('Agents keep running while this window is open. Close it to stop every agent.\n');
  openWindow();
});
