require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');

const app = express();
const httpServer = createServer(app);

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: false,
  maxPayload: 100 * 1024 * 1024,
});

app.disable('x-powered-by');
app.disable('etag');

// ── CORS ────────────────────────────────────────────────────────────────────
const corsOpts = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Upload ──────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── Discord OAuth config ────────────────────────────────────────────────────
const { CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, GUILD_ID, PORT, RENDER_EXTERNAL_URL } = process.env;
const BASE_URL = RENDER_EXTERNAL_URL || `http://localhost:${PORT || 3001}`;
const REDIRECT_URI = `${BASE_URL}/api/auth/discord/callback`;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:5500/based.html';
const ENABLE_REMOTE_TOOLS = process.env.ENABLE_REMOTE_TOOLS === 'true';

// ── Cloud AI fallback (Groq / OpenRouter) ──────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const CLOUD_MODEL = process.env.CLOUD_MODEL || 'llama3-70b-8192';
const cloudAiConfigured = !!(GROQ_API_KEY);

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const getCloudBaseUrl = () => AI_PROVIDER === 'openrouter' ? OPENROUTER_BASE : GROQ_BASE;

// ── Ollama state ────────────────────────────────────────────────────────────
let ollamaHealthy = false;
let ollamaBaseUrl = 'http://localhost:11434';
let lastHealthCheck = 0;
const HEALTH_TTL_MS = 8000;

const checkOllamaHealth = async (base = ollamaBaseUrl) => {
  const now = Date.now();
  if (base === ollamaBaseUrl && (now - lastHealthCheck) < HEALTH_TTL_MS) return ollamaHealthy;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    ollamaHealthy = r.ok;
    lastHealthCheck = Date.now();
    return r.ok;
  } catch {
    ollamaHealthy = false;
    lastHealthCheck = Date.now();
    return false;
  }
};

setInterval(() => checkOllamaHealth(), 10000);
checkOllamaHealth();

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Transfer-Encoding': 'chunked',
};

const DONE_MSG = Buffer.from('data: [DONE]\n\n', 'utf8');
const CPU_COUNT = os.cpus().length;

// ── WebSocket: Terminal & Code Runner ───────────────────────────────────────
wss.on('connection', (ws) => {
  if (!ENABLE_REMOTE_TOOLS) {
    ws.close(1008, 'Remote tools disabled');
    return;
  }
  let proc = null;

  const safeSend = (data) => {
    if (ws.readyState === 1) {
      try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
    }
  };

  ws.on('message', (raw) => {
    try {
      const { type, code, lang, command, cwd } = JSON.parse(raw);

      if (type === 'run_code') {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-'));
        let filename, runCmd;
        if (lang === 'python' || lang === 'py') {
          filename = path.join(tmpDir, 'main.py');
          runCmd = `python "${filename}"`;
        } else if (lang === 'javascript' || lang === 'js') {
          filename = path.join(tmpDir, 'main.js');
          runCmd = `node "${filename}"`;
        } else {
          safeSend({ type: 'stderr', data: 'Unsupported language: ' + lang });
          safeSend({ type: 'exit', code: 1 });
          return;
        }
        fs.writeFileSync(filename, code);
        safeSend({ type: 'start' });
        proc = spawn('cmd', ['/c', runCmd], { cwd: tmpDir });
        proc.stdout.on('data', (d) => safeSend({ type: 'stdout', data: d.toString() }));
        proc.stderr.on('data', (d) => safeSend({ type: 'stderr', data: d.toString() }));
        proc.on('close', (exitCode) => {
          safeSend({ type: 'exit', code: exitCode });
          proc = null;
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        });

      } else if (type === 'kill') {
        if (proc) { proc.kill(); proc = null; }

      } else if (type === 'shell') {
        const workDir = cwd || os.homedir();
        proc = spawn('cmd', ['/c', command], {
          cwd: fs.existsSync(workDir) ? workDir : os.homedir(),
          env: process.env,
        });
        proc.stdout.on('data', (d) => safeSend({ type: 'stdout', data: d.toString() }));
        proc.stderr.on('data', (d) => safeSend({ type: 'stderr', data: d.toString() }));
        proc.on('close', (exitCode) => { safeSend({ type: 'exit', code: exitCode }); proc = null; });
        proc.on('error', (err) => {
          safeSend({ type: 'stderr', data: `Shell error: ${err.message}` });
          proc = null;
        });
      }
    } catch (e) {
      safeSend({ type: 'stderr', data: `Parse error: ${e.message}` });
    }
  });

  ws.on('close', () => { if (proc) { try { proc.kill(); } catch {} proc = null; } });
  ws.on('error', () => { if (proc) { try { proc.kill(); } catch {} proc = null; } });
});

// ── Discord OAuth routes ────────────────────────────────────────────────────
app.get('/api/auth/discord/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN || !GUILD_ID) {
    return res.status(500).send('Server is not properly configured. Check the .env file.');
  }
  const scope = 'identify guilds.join';
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');
  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenResponse.data.access_token;
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const userId = userResponse.data.id;
    try {
      await axios.put(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`,
        { access_token: accessToken },
        { headers: { authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } catch (guildError) {
      console.error('Guild join error:', guildError.response?.data || guildError.message);
    }
    res.redirect(`${FRONTEND_URL}#authorized=true`);
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

// ── Cloud AI chat (Groq / OpenRouter) ───────────────────────────────────────
const streamCloudToOllama = async (req, res, messages, model, temperature) => {
  const baseUrl = getCloudBaseUrl();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GROQ_API_KEY}`,
  };
  if (AI_PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = FRONTEND_URL;
    headers['X-Title'] = 'WormGPT';
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || CLOUD_MODEL,
      messages,
      temperature: temperature ?? 0.7,
      stream: true,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ message: { content: `Cloud AI error: ${resp.status}. Check GROQ_API_KEY.` }, done: true })}\n\n`);
    res.write(DONE_MSG);
    res.end();
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  req.on('close', () => { try { reader.cancel(); } catch {} });

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      res.write(DONE_MSG);
      res.end();
      break;
    }
    const text = decoder.decode(value, { stream: true });
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line === 'data: [DONE]') continue;
      if (!line.startsWith('data: ')) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (!delta) continue;
        const content = delta.content || '';
        const isDone = finishReason === 'stop' || finishReason === 'length';
        const ollamaChunk = {
          model: model || CLOUD_MODEL,
          message: { role: 'assistant', content },
          done: isDone,
        };
        res.write(`data: ${JSON.stringify(ollamaChunk)}\n\n`);
        if (isDone) {
          res.write(DONE_MSG);
          res.end();
          try { reader.cancel(); } catch {}
          return;
        }
      } catch {}
    }
  }
};

const callCloudNonStream = async (messages, model, temperature) => {
  const baseUrl = getCloudBaseUrl();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GROQ_API_KEY}`,
  };
  if (AI_PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = FRONTEND_URL;
    headers['X-Title'] = 'WormGPT';
  }
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || CLOUD_MODEL,
      messages,
      temperature: temperature ?? 0.7,
      stream: false,
      max_tokens: 4096,
    }),
  });
  if (!resp.ok) throw new Error(`Cloud AI ${resp.status}`);
  const json = await resp.json();
  return {
    model: model || CLOUD_MODEL,
    message: {
      role: 'assistant',
      content: json.choices?.[0]?.message?.content || '',
    },
    done: true,
  };
};

// ── WormGPT Chat API (Ollama proxy with cloud fallback) ─────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature, stream, ollamaUrl } = req.body;
  const base = ollamaUrl || ollamaBaseUrl;
  if (ollamaUrl) ollamaBaseUrl = ollamaUrl;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 180_000);

  // Try Ollama first
  const ollamaOk = await checkOllamaHealth(base);

  if (ollamaOk) {
    try {
      const ollamaRes = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'godmoded/llama3-lexi-uncensored',
          messages,
          temperature: temperature ?? 0.7,
          stream: stream !== false,
          options: {
            num_thread: CPU_COUNT,
            num_batch: 512,
            f16_kv: true,
            use_mlock: true,
            use_mmap: true,
            num_ctx: 4096,
          },
        }),
        signal: ctrl.signal,
      });

      clearTimeout(timeout);

      if (!ollamaRes.ok) {
        res.status(ollamaRes.status).json({ error: await ollamaRes.text() });
        return;
      }

      if (stream !== false) {
        res.writeHead(200, SSE_HEADERS);
        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();
        req.on('close', () => { try { reader.cancel(); } catch {} });

        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.write(DONE_MSG); res.end(); break; }
          const text = decoder.decode(value, { stream: true });
          for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            res.write(`data: ${line}\n\n`);
            if (line.includes('"done":true')) {
              try {
                const json = JSON.parse(line);
                if (json.done === true) { res.end(); try { reader.cancel(); } catch {} return; }
              } catch {}
            }
          }
        }
      } else {
        res.json(await ollamaRes.json());
      }
      return;
    } catch (e) {
      clearTimeout(timeout);
      console.error('Ollama request failed, falling back to cloud:', e.message);
    }
  }

  // Ollama unavailable → use cloud fallback if configured
  if (cloudAiConfigured) {
    clearTimeout(timeout);
    try {
      if (stream !== false) {
        await streamCloudToOllama(req, res, messages, model, temperature);
      } else {
        const result = await callCloudNonStream(messages, model, temperature);
        res.json(result);
      }
      return;
    } catch (e) {
      console.error('Cloud AI error:', e.message);
      res.status(500).json({ error: `Cloud AI error: ${e.message}` });
      return;
    }
  }

  // Neither Ollama nor cloud AI available
  clearTimeout(timeout);
  const errorMsg = `I'm WormGPT, your unrestricted AI. The backend isn't connected yet.\n\nTo connect:\n1. Install Ollama from ollama.ai\n2. Pull the model: ollama pull godmoded/llama3-lexi-uncensored\n3. Start: cd server && npm start\n\nOr set GROQ_API_KEY in .env for cloud AI.`;
  res.status(503).json({ error: errorMsg });
});

// ── Ollama Status & Models ───────────────────────────────────────────────────
app.get('/api/ollama/status', async (req, res) => {
  const base = req.query.url || ollamaBaseUrl;
  const ollamaOk = await checkOllamaHealth(base);
  const connected = ollamaOk || cloudAiConfigured;
  res.json({ connected, url: base, cloudFallback: cloudAiConfigured });
});

app.get('/api/ollama/models', async (req, res) => {
  const base = req.query.url || ollamaBaseUrl;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    if (r.ok) {
      res.json(await r.json());
      return;
    }
  } catch {}
  if (cloudAiConfigured) {
    const cloudModelName = AI_PROVIDER === 'openrouter' ? 'openrouter/auto' : CLOUD_MODEL;
    res.json({
      models: [{
        name: cloudModelName,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: 'cloud',
        details: { family: AI_PROVIDER, parameter_size: 'cloud', quantization_level: 'cloud' },
      }],
    });
    return;
  }
  res.status(503).json({ error: `Cannot reach Ollama at ${base}` });
});

app.post('/api/ollama/pull', async (req, res) => {
  const { model, ollamaUrl } = req.body;
  const base = ollamaUrl || ollamaBaseUrl;
  if (!model) { res.status(400).json({ error: 'model required' }); return; }
  const ollamaOk = await checkOllamaHealth(base);
  if (!ollamaOk && cloudAiConfigured) {
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ status: 'success', digest: 'cloud', total: 0, completed: 0 })}\n\n`);
    res.write(DONE_MSG);
    res.end();
    return;
  }
  res.writeHead(200, SSE_HEADERS);
  try {
    const resp = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.write(DONE_MSG); res.end(); break; }
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.trim()) { try { res.write(`data: ${line}\n\n`); } catch {} }
      }
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// ── Project Upload ───────────────────────────────────────────────────────────
const TEXT_EXTS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.html', '.css', '.json',
  '.md', '.txt', '.sh', '.yaml', '.yml', '.toml', '.rs', '.go',
  '.java', '.cpp', '.c', '.h', '.sql', '.env', '.gitignore',
]);

const requireRemoteTools = (req, res, next) => {
  if (ENABLE_REMOTE_TOOLS) return next();
  res.status(403).json({ error: 'Remote tools are disabled on this backend.' });
};

app.post('/api/project/upload', requireRemoteTools, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    let files = [];
    if (req.file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(req.file.buffer);
      for (const e of zip.getEntries()) {
        if (!e.isDirectory) {
          const ext = path.extname(e.entryName).toLowerCase();
          const isText = TEXT_EXTS.has(ext) || !ext;
          files.push({
            name: e.entryName,
            content: isText ? e.getData().toString('utf8') : `[binary: ${ext}]`,
            type: isText ? 'text' : 'binary',
          });
        }
      }
    } else {
      files = [{ name: req.file.originalname, content: req.file.buffer.toString('utf8'), type: 'text' }];
    }
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Save File ────────────────────────────────────────────────────────────────
app.post('/api/save-file', requireRemoteTools, async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    await fsp.writeFile(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Git API ──────────────────────────────────────────────────────────────────
const getGit = (repoPath) => {
  const p = repoPath || process.cwd();
  return simpleGit(fs.existsSync(p) ? p : process.cwd());
};

app.post('/api/git/status', requireRemoteTools, async (req, res) => {
  try { res.json({ status: await getGit(req.body.repoPath).status() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/git/diff', requireRemoteTools, async (req, res) => {
  try {
    const git = getGit(req.body.repoPath);
    res.json({ diff: req.body.file ? await git.diff([req.body.file]) : await git.diff() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/git/commit', requireRemoteTools, async (req, res) => {
  try {
    const git = getGit(req.body.repoPath);
    if (req.body.files?.length) await git.add(req.body.files);
    else await git.add('.');
    res.json({ result: await git.commit(req.body.message || 'WormGPT commit') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/git/branch', requireRemoteTools, async (req, res) => {
  try {
    await getGit(req.body.repoPath).checkoutLocalBranch(req.body.name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Serve WormGPT frontend ───────────────────────────────────────────────────
const wormgptPath = path.join(__dirname, '..', 'wormgpt');
if (fs.existsSync(wormgptPath)) {
  app.use('/wormgpt', express.static(wormgptPath, {
    maxAge: '1d',
    etag: false,
    lastModified: false,
  }));
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
const PORT_NUM = PORT || 3001;

process.on('SIGTERM', () => {
  wss.clients.forEach((ws) => { try { ws.close(); } catch {} });
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  wss.clients.forEach((ws) => { try { ws.close(); } catch {} });
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT_NUM} in use.`); process.exit(1); }
});

httpServer.listen(PORT_NUM, '0.0.0.0', () => {
  console.log(`\n⚡ Server running  →  http://localhost:${PORT_NUM}`);
  console.log(`📡 WebSocket       →  ws://localhost:${PORT_NUM}`);
  console.log(`🤖 WormGPT         →  http://localhost:${PORT_NUM}/wormgpt`);
  console.log(`🔑 Discord OAuth   →  http://localhost:${PORT_NUM}/api/auth/discord/login`);
});
