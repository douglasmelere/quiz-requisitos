'use strict';

/**
 * Quiz de Requisitos — servidor em Node puro (zero dependências).
 * Tempo real via SSE (Server-Sent Events).
 *
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { QUESTIONS } = require('./questions');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const QUESTION_MS = Number(process.env.QUESTION_MS || 25000); // tempo por pergunta
const REVEAL_MS = Number(process.env.REVEAL_MS || 9000);      // tempo mostrando a resposta
const DEFAULT_ROUND = Number(process.env.ROUND_SIZE || 12);   // perguntas por partida
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;                       // sala morre após 6h ociosa

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- utilidades

const uid = () => crypto.randomBytes(9).toString('base64url');
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const now = () => Date.now();

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I/O/0/1
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sanitizeName(s, max = 22) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const TEAM_PALETTE = [
  { color: '#22d3ee', emoji: '🚀' }, { color: '#a78bfa', emoji: '🔥' },
  { color: '#fbbf24', emoji: '⚡' }, { color: '#34d399', emoji: '🧠' },
  { color: '#f472b6', emoji: '💎' }, { color: '#60a5fa', emoji: '🐺' },
  { color: '#fb7185', emoji: '🦊' }, { color: '#4ade80', emoji: '🐉' },
];

// ------------------------------------------------------------------- estado

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom(roundSize) {
  let code;
  do { code = roomCode(); } while (rooms.has(code));

  const size = clamp(Number(roundSize) || DEFAULT_ROUND, 5, QUESTIONS.length);

  const room = {
    code,
    hostToken: uid(),
    phase: 'lobby',          // lobby | question | reveal | ended
    qIndex: -1,
    questions: shuffle(QUESTIONS).slice(0, size),
    players: new Map(),      // pid -> player
    teams: new Map(),        // tid -> team
    clients: new Set(),      // conexões SSE
    phaseEndsAt: 0,
    timer: null,
    touchedAt: now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (room) room.touchedAt = now();
  return room;
}

function currentQuestion(room) {
  return room.questions[room.qIndex] || null;
}

function teamOf(room, player) {
  return player && player.teamId ? room.teams.get(player.teamId) : null;
}

function teamStandings(room) {
  const rows = [];
  for (const team of room.teams.values()) {
    const members = [...room.players.values()].filter((p) => p.teamId === team.id);
    const total = members.reduce((s, p) => s + p.score, 0);
    rows.push({
      id: team.id,
      name: team.name,
      emoji: team.emoji,
      color: team.color,
      size: members.length,
      total,
      // média evita que só o time maior vença
      score: members.length ? Math.round(total / members.length) : 0,
      members: members
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ id: p.id, name: p.name, score: p.score })),
    });
  }
  return rows.sort((a, b) => b.score - a.score || b.total - a.total);
}

function playerStandings(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p) => {
      const t = teamOf(room, p);
      return {
        id: p.id, name: p.name, score: p.score, streak: p.streak,
        team: t ? { name: t.name, emoji: t.emoji, color: t.color } : null,
      };
    });
}

/** Snapshot enviado a todos; `pid` personaliza a parte "you". */
function snapshot(room, pid) {
  const q = currentQuestion(room);
  const player = pid ? room.players.get(pid) : null;

  const base = {
    code: room.code,
    phase: room.phase,
    qIndex: room.qIndex,
    total: room.questions.length,
    playerCount: room.players.size,
    teamCount: room.teams.size,
    answeredCount: room.phase === 'question'
      ? [...room.players.values()].filter((p) => p.answer !== null).length
      : 0,
    endsAt: room.phaseEndsAt || 0,
    serverTime: now(),
    teams: teamStandings(room),
    lobby: room.phase === 'lobby'
      ? [...room.players.values()].map((p) => ({ id: p.id, name: p.name, teamId: p.teamId }))
      : [],
    question: null,
    reveal: null,
    podium: null,
    you: null,
  };

  if (q && (room.phase === 'question' || room.phase === 'reveal')) {
    base.question = { type: q.type, q: q.q, opts: q.opts };
  }

  if (room.phase === 'reveal' && q) {
    const dist = q.opts.map(() => 0);
    for (const p of room.players.values()) {
      if (p.answer !== null && dist[p.answer] !== undefined) dist[p.answer]++;
    }
    base.reveal = { ans: q.ans, exp: q.exp, dist };
  }

  if (room.phase === 'ended') {
    base.podium = { players: playerStandings(room), teams: teamStandings(room) };
  }

  if (player) {
    const t = teamOf(room, player);
    base.you = {
      id: player.id,
      name: player.name,
      score: player.score,
      streak: player.streak,
      gained: player.lastGain,
      correct: player.lastCorrect,
      answer: player.answer,
      team: t ? { id: t.id, name: t.name, emoji: t.emoji, color: t.color } : null,
      rank: playerStandings(room).findIndex((p) => p.id === player.id) + 1,
      history: player.history,
    };
  }

  return base;
}

// ------------------------------------------------------------------- SSE

function push(room) {
  const payloadCache = new Map();
  for (const client of room.clients) {
    const key = client.pid || '_';
    if (!payloadCache.has(key)) payloadCache.set(key, JSON.stringify(snapshot(room, client.pid)));
    try {
      client.res.write(`data: ${payloadCache.get(key)}\n\n`);
    } catch {
      room.clients.delete(client);
    }
  }
}

// -------------------------------------------------------- máquina de estados

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function startQuestion(room) {
  clearTimer(room);
  room.qIndex++;

  if (room.qIndex >= room.questions.length) return endGame(room);

  room.phase = 'question';
  room.phaseEndsAt = now() + QUESTION_MS;
  for (const p of room.players.values()) {
    p.answer = null;
    p.answeredAt = 0;
    p.lastGain = 0;
    p.lastCorrect = null;
  }
  push(room);
  room.timer = setTimeout(() => revealAnswer(room), QUESTION_MS + 250);
}

function revealAnswer(room) {
  clearTimer(room);
  if (room.phase !== 'question') return;

  const q = currentQuestion(room);
  room.phase = 'reveal';
  room.phaseEndsAt = now() + REVEAL_MS;

  for (const p of room.players.values()) {
    const correct = p.answer !== null && p.answer === q.ans;
    let gain = 0;
    if (correct) {
      const elapsed = clamp(p.answeredAt - (room.phaseEndsAt - REVEAL_MS - QUESTION_MS), 0, QUESTION_MS);
      const speed = 1 - elapsed / QUESTION_MS;                 // 1 = instantâneo
      p.streak++;
      const streakBonus = Math.min(300, Math.max(0, p.streak - 1) * 100);
      gain = Math.round(500 + 500 * speed + streakBonus);
    } else {
      p.streak = 0;
    }
    p.score += gain;
    p.lastGain = gain;
    p.lastCorrect = p.answer === null ? null : correct;
    p.history.push({ i: room.qIndex, answer: p.answer, ans: q.ans, correct, gain });
  }

  push(room);
  room.timer = setTimeout(() => startQuestion(room), REVEAL_MS);
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'ended';
  room.phaseEndsAt = 0;
  push(room);
}

function restartGame(room) {
  clearTimer(room);
  room.phase = 'lobby';
  room.qIndex = -1;
  room.phaseEndsAt = 0;
  room.questions = shuffle(QUESTIONS).slice(0, room.questions.length);
  for (const p of room.players.values()) {
    p.score = 0; p.streak = 0; p.answer = null; p.answeredAt = 0;
    p.lastGain = 0; p.lastCorrect = null; p.history = [];
  }
  push(room);
}

// ------------------------------------------------------------------- HTTP

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) { reject(new Error('payload')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ------------------------------------------------------------------- rotas

const api = {
  // ---- host cria a sala (telão)
  async 'POST /api/room/create'(req, res, body) {
    const room = createRoom(body.roundSize);
    json(res, 200, { code: room.code, hostToken: room.hostToken, total: room.questions.length });
  },

  // ---- jogador entra na sala
  async 'POST /api/join'(req, res, body) {
    const room = getRoom(body.code);
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });

    const name = sanitizeName(body.name);
    if (name.length < 2) return json(res, 400, { error: 'Digite um nome com pelo menos 2 letras.' });

    // reconexão: mesmo pid volta para o mesmo jogador
    const existing = body.pid && room.players.get(body.pid);
    if (existing) {
      existing.name = name;
      push(room);
      return json(res, 200, { pid: existing.id, code: room.code });
    }

    if (room.players.size >= 200) return json(res, 400, { error: 'Sala lotada.' });

    const player = {
      id: uid(), name, teamId: null, score: 0, streak: 0,
      answer: null, answeredAt: 0, lastGain: 0, lastCorrect: null, history: [],
    };
    room.players.set(player.id, player);
    push(room);
    json(res, 200, { pid: player.id, code: room.code });
  },

  // ---- criar equipe
  async 'POST /api/team/create'(req, res, body) {
    const room = getRoom(body.code);
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });
    const player = room.players.get(body.pid);
    if (!player) return json(res, 403, { error: 'Entre na sala primeiro.' });

    const name = sanitizeName(body.name, 18);
    if (name.length < 2) return json(res, 400, { error: 'Nome da equipe muito curto.' });
    if ([...room.teams.values()].some((t) => t.name.toLowerCase() === name.toLowerCase()))
      return json(res, 400, { error: 'Já existe uma equipe com esse nome.' });
    if (room.teams.size >= 12) return json(res, 400, { error: 'Limite de 12 equipes atingido.' });

    const skin = TEAM_PALETTE[room.teams.size % TEAM_PALETTE.length];
    const team = {
      id: uid(),
      name,
      emoji: sanitizeName(body.emoji, 4) || skin.emoji,
      color: skin.color,
    };
    room.teams.set(team.id, team);
    player.teamId = team.id;
    push(room);
    json(res, 200, { teamId: team.id });
  },

  // ---- entrar em equipe existente
  async 'POST /api/team/join'(req, res, body) {
    const room = getRoom(body.code);
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });
    const player = room.players.get(body.pid);
    if (!player) return json(res, 403, { error: 'Entre na sala primeiro.' });
    if (!room.teams.has(body.teamId)) return json(res, 404, { error: 'Equipe não encontrada.' });

    player.teamId = body.teamId;
    push(room);
    json(res, 200, { ok: true });
  },

  // ---- sair da equipe
  async 'POST /api/team/leave'(req, res, body) {
    const room = getRoom(body.code);
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });
    const player = room.players.get(body.pid);
    if (player) {
      const oldId = player.teamId;
      player.teamId = null;
      // remove equipes que ficaram vazias
      if (oldId && ![...room.players.values()].some((p) => p.teamId === oldId)) room.teams.delete(oldId);
      push(room);
    }
    json(res, 200, { ok: true });
  },

  // ---- responder
  async 'POST /api/answer'(req, res, body) {
    const room = getRoom(body.code);
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });
    const player = room.players.get(body.pid);
    if (!player) return json(res, 403, { error: 'Jogador desconhecido.' });
    if (room.phase !== 'question') return json(res, 409, { error: 'Fora do tempo.' });
    if (player.answer !== null) return json(res, 409, { error: 'Você já respondeu.' });

    const q = currentQuestion(room);
    const choice = Number(body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.opts.length)
      return json(res, 400, { error: 'Alternativa inválida.' });

    player.answer = choice;
    player.answeredAt = now();
    push(room);

    // todo mundo respondeu -> revela sem esperar o cronômetro
    if ([...room.players.values()].every((p) => p.answer !== null)) {
      clearTimer(room);
      room.timer = setTimeout(() => revealAnswer(room), 800);
    }
    json(res, 200, { ok: true });
  },

  // ---- controles do host
  async 'POST /api/host/start'(req, res, body) {
    const room = getRoom(body.code);
    if (!room || room.hostToken !== body.hostToken) return json(res, 403, { error: 'Sem permissão.' });
    if (room.players.size === 0) return json(res, 400, { error: 'Ninguém entrou na sala ainda.' });
    if (room.phase !== 'lobby') return json(res, 409, { error: 'A partida já começou.' });
    startQuestion(room);
    json(res, 200, { ok: true });
  },

  async 'POST /api/host/skip'(req, res, body) {
    const room = getRoom(body.code);
    if (!room || room.hostToken !== body.hostToken) return json(res, 403, { error: 'Sem permissão.' });
    if (room.phase === 'question') revealAnswer(room);
    else if (room.phase === 'reveal') startQuestion(room);
    json(res, 200, { ok: true });
  },

  async 'POST /api/host/restart'(req, res, body) {
    const room = getRoom(body.code);
    if (!room || room.hostToken !== body.hostToken) return json(res, 403, { error: 'Sem permissão.' });
    restartGame(room);
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  // -------- SSE
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const room = getRoom(url.searchParams.get('code'));
    if (!room) return json(res, 404, { error: 'Sala não encontrada.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // evita buffering em proxy (nginx/traefik)
    });
    res.write(': ok\n\n');

    const client = { res, pid: url.searchParams.get('pid') || null };
    room.clients.add(client);
    res.write(`data: ${JSON.stringify(snapshot(room, client.pid))}\n\n`);

    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(beat); room.clients.delete(client); });
    return;
  }

  // -------- API
  if (url.pathname.startsWith('/api/')) {
    const handler = api[route];
    if (!handler) return json(res, 404, { error: 'Rota não encontrada.' });
    try {
      const body = await readBody(req);
      await handler(req, res, body);
    } catch (err) {
      json(res, 500, { error: 'Erro interno.' });
    }
    return;
  }

  // -------- estático
  if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname === '/' || url.pathname === '/play') return serveStatic(res, 'index.html');
  if (url.pathname === '/host' || url.pathname === '/telao') return serveStatic(res, 'host.html');
  return serveStatic(res, url.pathname.replace(/^\/+/, '') || 'index.html');
});

// limpeza de salas ociosas
setInterval(() => {
  for (const [code, room] of rooms) {
    if (now() - room.touchedAt > ROOM_TTL_MS && room.clients.size === 0) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60000).unref();

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  Quiz de Requisitos — no ar                  │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`   Telão (host):  http://localhost:${PORT}/host`);
  console.log(`   Jogadores:     http://localhost:${PORT}/`);
  if (lan) console.log(`   Na rede local: http://${lan.address}:${PORT}/`);
  console.log('');
});
