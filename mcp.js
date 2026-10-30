// AgentDeck's tools for agents: a minimal MCP server (JSON-RPC over stdio, no dependencies).
// Claude Code starts one per agent (via --mcp-config); each call is forwarded to the AgentDeck server,
// which knows the board, the agents and the shared notes. AGENTDECK_AGENT_ID says who is calling.

const AGENT = process.env.AGENTDECK_AGENT_ID;
const PORT = process.env.AGENTDECK_PORT || '4646';

const card = { type: 'string', description: 'Card id (from the board) or its exact title' };
const agentName = { type: 'string', description: "The agent's name, e.g. Builder 1" };
const TOOLS = [
  {
    name: 'agents',
    description: 'List the agents in this AgentDeck project: name, role, model, status (ready, working, needs you, finished, stopped), branch and current card. Marks which one is you and which one is the Lead.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board',
    description: 'Show the task board: every card with its id, column (backlog, progress, review, done), who it is assigned to, and the summary an agent left when it finished.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'notes',
    description: "Read the project's shared notes: facts and decisions every agent should follow (e.g. 'Stripe amounts are in cents'). Read these before starting a task.",
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Optional word to filter notes by' } } },
  },
  {
    name: 'remember',
    description: 'Save a short shared note for all agents and the user: a fact, decision or gotcha others need (one or two sentences). Not for progress reports.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'create_card',
    description: 'Add a task card to the board. One small, clear task per card. Only the Lead may use assign_to, which hands the card straight to that agent (it starts working on it right away).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        details: { type: 'string', description: 'What to do, which files, what "done" means' },
        assign_to: { ...agentName, description: 'Lead only: give it to this agent now' },
      },
      required: ['title'],
    },
  },
  {
    name: 'assign_card',
    description: "Lead only: hand an existing card to an agent. The task is typed into that agent's session and the card moves to In progress. The agent must not be busy.",
    inputSchema: { type: 'object', properties: { card, agent: agentName }, required: ['card', 'agent'] },
  },
  {
    name: 'move_card',
    description: 'Move a card to another column: backlog, progress, review or done. Agents may move their own cards; the Lead may move any card.',
    inputSchema: { type: 'object', properties: { card, column: { type: 'string', enum: ['backlog', 'progress', 'review', 'done'] } }, required: ['card', 'column'] },
  },
  {
    name: 'message_agent',
    description: "Lead only: send a follow-up message to another agent (typed into its session), e.g. a fix request after a review. You get its reply as an AgentDeck update when it finishes. The agent must not be busy.",
    inputSchema: { type: 'object', properties: { agent: agentName, message: { type: 'string' } }, required: ['agent', 'message'] },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function callTool(name, args) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/mcp/${AGENT}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AgentDeck': '1' },
      body: JSON.stringify(args || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { content: [{ type: 'text', text: data.error || `AgentDeck error ${r.status}` }], isError: true };
    return { content: [{ type: 'text', text: data.text || 'Done.' }] };
  } catch {
    return { content: [{ type: 'text', text: 'AgentDeck is not running, so its tools are unavailable right now.' }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentdeck', version: '0.4.0' },
      instructions: 'AgentDeck tools: see the other agents, the task board and the shared notes of this project.',
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') return reply(id, await callTool(params?.name, params?.arguments));
  if (method === 'ping') return reply(id, {});
  if (id !== undefined) fail(id, -32601, `Unknown method ${method}`); // notifications need no answer
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
  }
});
process.stdin.on('end', () => process.exit(0));
