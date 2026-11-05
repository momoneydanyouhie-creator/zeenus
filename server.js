const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const W = 1600, H = 1000;
const STATIONS = [
  { x: 220, y: 220 }, { x: 1380, y: 220 }, { x: 220, y: 780 },
  { x: 1380, y: 780 }, { x: 800, y: 140 }, { x: 800, y: 860 },
];
const BELL = { x: 800, y: 500 };
const TASKS_PER_GUEST = 3, MAX = 10, MIN = 3;
const KILL_CD = 20000, KILL_RANGE = 120, MEETING_MS = 45000;
const rooms = {};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c; do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms[c]);
  return c;
}
const alivePlayers = r => Object.values(r.players).filter(p => p.alive);

function publicState(r) {
  return {
    phase: r.phase, host: r.host, code: r.code,
    progress: { done: r.done.size, total: r.total },
    bodies: r.bodies,
    voted: Object.keys(r.votes),
    meetingEnds: r.meetingEnds,
    players: Object.values(r.players).map(p => ({
      id: p.id, name: p.name, color: p.color, hat: p.hat, alive: p.alive, x: p.x, y: p.y,
    })),
  };
}
function sendYou(r, p) {
  io.to(p.id).emit('you', {
    role: p.role,
    tasks: p.tasks.map(i => ({ i, ...STATIONS[i], done: r.done.has(p.id + ':' + i) })),
    mates: p.role === 'gremlin' ? Object.values(r.players).filter(q => q.role === 'gremlin').map(q => q.id) : [],
    killReady: p.killReady || 0,
    bells: p.bells,
  });
}

function startGame(r) {
  const ids = shuffle(Object.keys(r.players));
  const gCount = ids.length >= 7 ? 2 : 1;
  r.phase = 'play'; r.bodies = []; r.done = new Set(); r.votes = {};
  ids.forEach((id, n) => {
    const p = r.players[id];
    p.alive = true; p.role = n < gCount ? 'gremlin' : 'guest';
    p.x = BELL.x + Math.cos(n) * 90; p.y = BELL.y + Math.sin(n) * 90;
    p.tasks = p.role === 'guest' ? shuffle([0, 1, 2, 3, 4, 5]).slice(0, TASKS_PER_GUEST) : [];
    p.killReady = Date.now() + 10000; p.bells = 1; p.taskCount = 0;
  });
  r.total = ids.filter(id => r.players[id].role === 'guest').length * TASKS_PER_GUEST;
  Object.values(r.players).forEach(p => sendYou(r, p));
}

function checkWin(r) {
  if (r.phase !== 'play' && r.phase !== 'meeting') return false;
  const al = alivePlayers(r);
  const g = al.filter(p => p.role === 'gremlin').length;
  const guests = al.length - g;
  let winner = null;
  if (g === 0) winner = 'guests';
  else if (g >= guests) winner = 'gremlins';
  else if (r.total > 0 && r.done.size >= r.total) winner = 'guests';
  if (!winner) return false;
  endGame(r, winner);
  return true;
}
function endGame(r, winner) {
  clearTimeout(r.timer);
  r.phase = 'over';
  const roles = {}, tasks = {};
  Object.values(r.players).forEach(p => { roles[p.id] = p.role; tasks[p.id] = p.taskCount; });
  io.to(r.code).emit('over', { winner, roles, tasks });
  r.timer = setTimeout(() => {
    r.phase = 'lobby'; r.bodies = [];
    Object.values(r.players).forEach(p => { p.alive = true; p.role = null; });
    io.to(r.code).emit('lobby');
  }, 10000);
}

function startMeeting(r, callerId) {
  r.phase = 'meeting'; r.bodies = []; r.votes = {};
  r.meetingEnds = Date.now() + MEETING_MS;
  const al = alivePlayers(r);
  al.forEach((p, n) => { p.x = BELL.x + Math.cos(n * 1.2) * 160; p.y = BELL.y + Math.sin(n * 1.2) * 160; });
  io.to(r.code).emit('meeting', { caller: callerId });
  r.timer = setTimeout(() => tally(r), MEETING_MS);
}
function tally(r) {
  if (r.phase !== 'meeting') return;
  clearTimeout(r.timer);
  const counts = {};
  Object.values(r.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  let top = null, topN = 0, tie = false;
  for (const [k, n] of Object.entries(counts)) {
    if (n > topN) { top = k; topN = n; tie = false; } else if (n === topN) tie = true;
  }
  let ejected = null;
  if (top && top !== 'skip' && !tie) ejected = r.players[top];
  if (ejected) ejected.alive = false;
  io.to(r.code).emit('result', {
    ejected: ejected ? { id: ejected.id, name: ejected.name, role: ejected.role } : null,
    tie: tie && !!top,
  });
  r.phase = 'result';
  r.timer = setTimeout(() => {
    if (!r.players) return;
    r.phase = 'play';
    Object.values(r.players).forEach(p => { p.killReady = Date.now() + 10000; sendYou(r, p); });
    checkWin(r);
  }, 6000);
  checkWin(r);
}

io.on('connection', socket => {
  let r = null;
  const me = () => r && r.players[socket.id];

  function join(code, info) {
    r = rooms[code];
    const p = {
      id: socket.id, name: String(info.name || 'Guest').slice(0, 12),
      color: info.color || '#e07a5f', hat: info.hat || '', alive: true,
      x: BELL.x, y: BELL.y, role: null, tasks: [], bells: 1, taskCount: 0, killReady: 0,
    };
    const existing = Object.keys(r.players);
    r.players[socket.id] = p;
    if (!r.host) r.host = socket.id;
    socket.join(code);
    socket.emit('joined', { code, id: socket.id, peers: existing });
    if (r.phase !== 'lobby') p.alive = false; // late joiners spectate
  }

  socket.on('create', info => { const code = makeCode(); rooms[code] = { code, players: {}, phase: 'lobby', bodies: [], done: new Set(), votes: {}, total: 0 }; join(code, info); });
  socket.on('join', ({ code, info }) => {
    code = String(code || '').toUpperCase();
    const rm = rooms[code];
    if (!rm) return socket.emit('err', 'No room with that code.');
    if (Object.keys(rm.players).length >= MAX) return socket.emit('err', 'Room is full.');
    join(code, info);
  });
  socket.on('appearance', info => { const p = me(); if (p) { p.color = info.color; p.hat = info.hat; } });
  socket.on('signal', ({ to, data }) => io.to(to).emit('signal', { from: socket.id, data }));

  socket.on('start', () => {
    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;
    if (Object.keys(r.players).length < MIN) return socket.emit('err', `Need at least ${MIN} players.`);
    startGame(r);
  });
  socket.on('move', ({ x, y }) => {
    const p = me(); if (!p || r.phase === 'meeting' || r.phase === 'result') return;
    p.x = Math.max(20, Math.min(W - 20, +x || 0)); p.y = Math.max(20, Math.min(H - 20, +y || 0));
  });
  socket.on('task', i => {
    const p = me(); if (!p || r.phase !== 'play' || !p.alive || !p.tasks.includes(i)) return;
    const key = p.id + ':' + i;
    if (r.done.has(key) || dist(p, STATIONS[i]) > 130) return;
    r.done.add(key); p.taskCount++; sendYou(r, p); checkWin(r);
  });
  socket.on('kill', target => {
    const p = me(), t = r && r.players[target];
    if (!p || !t || r.phase !== 'play' || p.role !== 'gremlin' || !p.alive || !t.alive || t.role === 'gremlin') return;
    if (Date.now() < p.killReady || dist(p, t) > KILL_RANGE) return;
    t.alive = false; p.killReady = Date.now() + KILL_CD;
    r.bodies.push({ id: t.id, x: t.x, y: t.y, color: t.color });
    sendYou(r, p); checkWin(r);
  });
  socket.on('call', () => {
    const p = me(); if (!p || r.phase !== 'play' || !p.alive) return;
    const nearBody = r.bodies.some(b => dist(p, b) < 140);
    const nearBell = dist(p, BELL) < 120 && p.bells > 0;
    if (!nearBody && !nearBell) return;
    if (!nearBody) p.bells--;
    startMeeting(r, p.id);
  });
  socket.on('vote', target => {
    const p = me(); if (!p || r.phase !== 'meeting' || !p.alive || r.votes[p.id]) return;
    if (target !== 'skip' && !(r.players[target] && r.players[target].alive)) return;
    r.votes[p.id] = target;
    if (Object.keys(r.votes).length >= alivePlayers(r).length) tally(r);
  });

  socket.on('disconnect', () => {
    if (!r) return;
    delete r.players[socket.id];
    io.to(r.code).emit('left', socket.id);
    const ids = Object.keys(r.players);
    if (!ids.length) { clearTimeout(r.timer); delete rooms[r.code]; return; }
    if (r.host === socket.id) r.host = ids[0];
    if (r.phase === 'meeting' && Object.keys(r.votes).length >= alivePlayers(r).length) tally(r);
    else checkWin(r);
  });
});

setInterval(() => {
  for (const r of Object.values(rooms)) io.to(r.code).emit('state', publicState(r));
}, 66);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Lantern Inn on :' + PORT));
