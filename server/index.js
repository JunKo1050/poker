// =====================================================================
// Poker game server: Socket.IO rooms + the shared authoritative engine.
//
//   client → server: room:create / room:join / room:start / game:action
//   server → client: room:update / room:started / game:event /
//                    game:action_request
//
// Hole cards are only ever sent to their owner (ev.private is split per
// socket); everyone else sees the public snapshot in ev.pub.
// =====================================================================
const http = require('http');
const { Server } = require('socket.io');
const { createEngine, CPU_CHARS, PERSONALITIES, shuffle } = require('./shared');

const PORT = process.env.PORT || 3001;
const ACTION_TIMEOUT = 45000; // ms until an unresponsive player auto-checks/folds
const MAX_SEATS = 6;
const ALLOWED_ORIGINS = [
  'https://junko1050.github.io',
  'http://localhost:8931', 'http://127.0.0.1:8931',
  'http://localhost:8000', 'http://127.0.0.1:8000',
];

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('poker game server');
});
const io = new Server(httpServer, { cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] } });

const rooms = new Map(); // code -> room

function genCode() {
  for (let t = 0; t < 100; t++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function cleanName(v, fallback) { return String(v || fallback).replace(/[<>&"']/g, '').slice(0, 8) || fallback; }
function cleanImg(v) {
  const base = String(v || '').split('?')[0];
  const known = CPU_CHARS.find(c => c.img.split('?')[0] === base);
  return known ? known.img : CPU_CHARS[0].img;
}

function roomSummary(room) {
  return {
    code: room.code,
    status: room.status,
    members: room.members.map(m => ({
      name: m.name, img: m.img, seat: m.seat,
      connected: m.connected, isHost: m.id === room.hostId,
    })),
  };
}
function broadcastRoom(room) {
  room.members.forEach(m => {
    if (m.connected) io.to(m.id).emit('room:update', { ...roomSummary(room), youAreHost: m.id === room.hostId });
  });
}

function getRoom(socket) { return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null; }

function sanitizeAction(act) {
  if (!act || typeof act !== 'object') return { action: 'fold' };
  const a = String(act.action);
  if (!['fold', 'check', 'call', 'raise'].includes(a)) return { action: 'fold' };
  const amount = Number.isFinite(+act.amount) ? Math.max(0, Math.floor(+act.amount)) : 0;
  return { action: a, amount }; // engine clamps raise sizes & legality
}

// ---------------------------------------------------------------------
function startGame(room) {
  room.status = 'playing';
  room.abandoned = false;

  // seats: humans first (join order), CPUs fill the rest
  room.members.forEach((m, i) => { m.seat = i; });
  const usedImgs = new Set(room.members.map(m => m.img.split('?')[0]));
  const cpuPool = CPU_CHARS.filter(c => !usedImgs.has(c.img.split('?')[0]));
  const pers = shuffle(PERSONALITIES);

  const players = room.members.map(m => ({ name: m.name, img: m.img, isHuman: true, personality: null }));
  for (let i = players.length, k = 0; i < MAX_SEATS; i++, k++) {
    const c = cpuPool[k % cpuPool.length];
    players.push({ name: c.name, img: c.img, isHuman: false, personality: pers[i % pers.length] });
  }

  room.members.forEach(m => {
    if (m.connected) io.to(m.id).emit('room:started', { youSeat: m.seat, players: players.map(p => ({ name: p.name, img: p.img })) });
  });

  const hooks = {
    emit: ev => {
      const { private: priv, ...common } = ev;
      room.members.forEach(m => {
        if (!m.connected) return;
        const out = (priv && priv[m.seat] != null) ? { ...common, private: { [m.seat]: priv[m.seat] } } : common;
        io.to(m.id).emit('game:event', out);
      });
    },
    getAction: (seat, options) => new Promise(resolve => {
      const m = room.members.find(x => x.seat === seat);
      if (!m || !m.connected) { resolve({ action: options.canCheck ? 'check' : 'fold' }); return; }
      const timer = setTimeout(() => finish({ action: options.canCheck ? 'check' : 'fold' }), ACTION_TIMEOUT);
      function finish(act) {
        clearTimeout(timer);
        if (room.pending && room.pending.seat === seat) room.pending = null;
        resolve(act || { action: options.canCheck ? 'check' : 'fold' });
      }
      room.pending = { seat, finish };
      io.to(m.id).emit('game:action_request', { seat, options, timeoutMs: ACTION_TIMEOUT });
    }),
    wait: ms => new Promise((res, rej) =>
      setTimeout(() => room.abandoned ? rej(new Error('room abandoned')) : res(), ms)),
    // no askSpectate online: busted players simply keep watching the events
  };

  room.engine = createEngine({ players, humanSeat: 0 }, hooks);
  room.engine.run()
    .then(() => { room.status = 'ended'; broadcastRoom(room); })
    .catch(() => { /* room abandoned */ });
}

// ---------------------------------------------------------------------
io.on('connection', socket => {
  socket.on('room:create', (data, ack) => {
    const code = genCode();
    if (!code) { ack && ack({ ok: false, error: '部屋を作成できませんでした' }); return; }
    const room = {
      code, hostId: socket.id, status: 'lobby',
      members: [], engine: null, pending: null, abandoned: false, createdAt: Date.now(),
    };
    rooms.set(code, room);
    addMember(room, socket, data);
    ack && ack({ ok: true, ...roomSummary(room), youAreHost: true });
  });

  socket.on('room:join', (data, ack) => {
    const room = rooms.get(String(data && data.code || '').trim());
    if (!room) { ack && ack({ ok: false, error: '部屋が見つかりません' }); return; }
    if (room.status === 'playing') { ack && ack({ ok: false, error: 'この部屋は対戦中です' }); return; }
    if (room.members.length >= MAX_SEATS) { ack && ack({ ok: false, error: '満席です' }); return; }
    addMember(room, socket, data);
    ack && ack({ ok: true, ...roomSummary(room), youAreHost: room.hostId === socket.id });
    broadcastRoom(room);
  });

  socket.on('room:start', () => {
    const room = getRoom(socket);
    if (!room || room.hostId !== socket.id || room.status === 'playing') return;
    startGame(room);
  });

  socket.on('game:action', act => {
    const room = getRoom(socket);
    if (!room || !room.pending) return;
    const m = room.members.find(x => x.id === socket.id);
    if (!m || m.seat !== room.pending.seat) return;
    room.pending.finish(sanitizeAction(act));
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    const m = room.members.find(x => x.id === socket.id);
    if (m) m.connected = false;

    if (room.status === 'lobby') {
      room.members = room.members.filter(x => x.id !== socket.id);
      if (room.members.length === 0) { rooms.delete(room.code); return; }
      if (room.hostId === socket.id) room.hostId = room.members[0].id;
      broadcastRoom(room);
    } else {
      // mid-game: their pending turn auto-folds; future turns auto check/fold
      if (room.pending && m && room.pending.seat === m.seat) room.pending.finish(null);
      broadcastRoom(room);
      if (room.members.every(x => !x.connected)) {
        room.abandoned = true;
        rooms.delete(room.code);
      }
    }
  });
});

function addMember(room, socket, data) {
  const member = {
    id: socket.id,
    name: cleanName(data && data.name, `プレイヤー${room.members.length + 1}`),
    img: cleanImg(data && data.img),
    seat: room.members.length,
    connected: true,
  };
  room.members.push(member);
  socket.data.roomCode = room.code;
}

// safety net: drop rooms with nobody connected (e.g. after crashes)
setInterval(() => {
  for (const [code, room] of rooms) {
    const stale = room.members.every(m => !m.connected);
    const old = Date.now() - room.createdAt > 6 * 60 * 60 * 1000;
    if (stale || old) { room.abandoned = true; rooms.delete(code); }
  }
}, 10 * 60 * 1000);

httpServer.listen(PORT, () => console.log(`poker server listening on :${PORT}`));
