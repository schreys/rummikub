const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Game } = require('./game');
const { chooseBotMove } = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 4;
const TIMER_OPTIONS = [0, 30, 60, 90, 120];
const DISCONNECT_GRACE_MS = 20000;
const LOBBY_REMOVE_MS = 30000;
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const BOT_NAMES = ['Anna', 'Bram', 'Charlotte', 'Daan', 'Emma', 'Finn'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

const rooms = new Map();

// ---------- helpers ----------

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{5}$/i.test(code.trim()) ? code.trim().toUpperCase() : null;
}

function tilesText(n) {
  return n === 1 ? '1 steen' : `${n} stenen`;
}

function playerById(room, id) {
  return room.players.find((p) => p.id === id);
}

function gameRunning(room) {
  return !!room.game && !room.game.finished;
}

function connectedHumans(room) {
  return room.players.filter((p) => !p.isBot && p.connected);
}

function pushChat(room, msg) {
  msg.time = Date.now();
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}

function sysMsg(room, text) {
  pushChat(room, { type: 'system', text });
}

function roomStateFor(room, player) {
  let game = null;
  if (room.game) {
    game = room.game.stateFor(player.id);
    game.turnRemainingMs = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
  }
  return {
    code: room.code,
    hostId: room.hostId,
    you: player.id,
    round: room.round,
    settings: room.settings,
    maxPlayers: MAX_PLAYERS,
    timerOptions: TIMER_OPTIONS,
    players: room.players.map(({ id, name, isBot, connected, score }) => ({ id, name, isBot, connected, score })),
    game,
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (!p.isBot && p.connected && p.socketId) io.to(p.socketId).emit('room', roomStateFor(room, p));
  }
}

function ensureHost(room) {
  const host = playerById(room, room.hostId);
  if (host && !host.isBot && host.connected) return;
  const next = connectedHumans(room)[0];
  if (next) {
    room.hostId = next.id;
    sysMsg(room, `${next.name} is nu de host.`);
  }
}

function checkEmpty(room) {
  if (connectedHumans(room).length) return;
  clearTurnTimers(room);
  room.paused = gameRunning(room);
  clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    if (!connectedHumans(room).length) {
      clearTurnTimers(room);
      rooms.delete(room.code);
    }
  }, EMPTY_ROOM_MS);
}

function removePlayer(room, p) {
  clearTimeout(p.removeTimer);
  room.players = room.players.filter((x) => x.id !== p.id);
}

// ---------- turn flow ----------

function clearTurnTimers(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.botTimer);
  clearTimeout(room.graceTimer);
  room.turnTimer = room.botTimer = room.graceTimer = null;
  room.turnDeadline = null;
}

function startGrace(room) {
  clearTimeout(room.graceTimer);
  room.graceTimer = setTimeout(() => onTimeout(room, true), DISCONNECT_GRACE_MS);
}

function startTurn(room) {
  clearTurnTimers(room);
  room.preview = null;
  if (!gameRunning(room)) return;
  const p = playerById(room, room.game.currentPlayer.id);
  if (p.isBot) {
    room.botTimer = setTimeout(() => runBot(room), 1200 + crypto.randomInt(1500));
    return;
  }
  const secs = room.settings.turnSeconds;
  if (secs) {
    room.turnDeadline = Date.now() + secs * 1000;
    room.turnTimer = setTimeout(() => onTimeout(room, false), secs * 1000);
  }
  if (!p.connected) startGrace(room);
}

function afterTurn(room) {
  const g = room.game;
  if (g.finished) {
    clearTurnTimers(room);
    for (const r of g.result.players) {
      const p = playerById(room, r.id);
      if (p) p.score += r.roundScore;
    }
    const winner = playerById(room, g.result.winnerId);
    sysMsg(room, `${winner ? winner.name : 'Iemand'} wint ronde ${room.round}!`);
  } else {
    startTurn(room);
  }
  broadcast(room);
}

function drawFor(room, p, prefix = '') {
  const res = room.game.draw(p.id);
  sysMsg(room, `${prefix}${p.name} ${res.passed ? 'past (de pot is leeg)' : 'pakt een steen'}.`);
  afterTurn(room);
}

function onTimeout(room, disconnected) {
  if (!gameRunning(room)) return;
  const p = playerById(room, room.game.currentPlayer.id);
  if (!disconnected && room.preview) {
    const res = room.game.play(p.id, room.preview);
    if (res.ok) {
      sysMsg(room, `Tijd om! De zet van ${p.name} was geldig: ${tilesText(res.played.length)} gelegd.`);
      return afterTurn(room);
    }
  }
  drawFor(room, p, disconnected ? 'Niet verbonden: ' : 'Tijd om! ');
}

function runBot(room) {
  if (!gameRunning(room)) return;
  const p = playerById(room, room.game.currentPlayer.id);
  try {
    const move = chooseBotMove(room.game);
    if (move.type === 'play') {
      const res = room.game.play(p.id, move.board);
      if (res.ok) {
        sysMsg(room, `${p.name} legt ${tilesText(res.played.length)}.`);
        return afterTurn(room);
      }
    }
  } catch (err) {
    console.error('Bot error', err);
  }
  drawFor(room, p);
}

function startRound(room) {
  room.round++;
  room.game = new Game(room.players.map((p) => p.id));
  sysMsg(room, `Ronde ${room.round} begint. ${playerById(room, room.game.currentPlayer.id).name} mag beginnen.`);
  startTurn(room);
  broadcast(room);
}

// ---------- sockets ----------

function attach(socket, room, player) {
  if (socket.data.code === room.code && socket.data.playerId === player.id) return;
  detach(socket, true);
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

function detach(socket, explicit) {
  const room = rooms.get(socket.data.code);
  const pid = socket.data.playerId;
  if (socket.data.code) socket.leave(socket.data.code);
  socket.data.code = socket.data.playerId = null;
  if (!room) return;
  const p = playerById(room, pid);
  if (!p || p.socketId !== socket.id) return;
  p.socketId = null;

  if (explicit) {
    if (gameRunning(room)) {
      p.isBot = true;
      p.token = null;
      sysMsg(room, `${p.name} heeft het spel verlaten; een bot neemt het over.`);
      if (room.game.currentPlayer.id === p.id) startTurn(room);
    } else {
      removePlayer(room, p);
      sysMsg(room, `${p.name} heeft het spel verlaten.`);
    }
  } else {
    p.connected = false;
    sysMsg(room, `${p.name} heeft de verbinding verloren.`);
    if (gameRunning(room)) {
      if (room.game.currentPlayer.id === p.id) startGrace(room);
    } else {
      p.removeTimer = setTimeout(() => {
        if (p.connected || gameRunning(room) || !rooms.has(room.code)) return;
        removePlayer(room, p);
        sysMsg(room, `${p.name} is uit de wachtkamer verwijderd.`);
        broadcast(room);
      }, LOBBY_REMOVE_MS);
    }
  }
  ensureHost(room);
  checkEmpty(room);
  broadcast(room);
}

io.on('connection', (socket) => {
  const reply = (cb, data) => typeof cb === 'function' && cb(data);
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const player = room && playerById(room, socket.data.playerId);
    return room && player ? { room, player } : null;
  };
  const hostCtx = () => {
    const c = ctx();
    return c && c.room.hostId === c.player.id ? c : null;
  };

  socket.on('createRoom', (data, cb) => {
    const name = cleanText(data?.name, 20);
    if (!name) return reply(cb, { ok: false, error: 'Vul een naam in.' });
    const room = {
      code: newCode(),
      hostId: null,
      players: [],
      game: null,
      round: 0,
      settings: { turnSeconds: 120 },
      chat: [],
      preview: null,
    };
    rooms.set(room.code, room);
    const p = { id: crypto.randomUUID(), token: crypto.randomUUID(), name, isBot: false, socketId: socket.id, connected: true, score: 0 };
    room.players.push(p);
    room.hostId = p.id;
    attach(socket, room, p);
    reply(cb, { ok: true, code: room.code, token: p.token });
    socket.emit('chatHistory', room.chat);
    sysMsg(room, `${name} heeft het spel aangemaakt.`);
    broadcast(room);
  });

  socket.on('joinRoom', (data, cb) => {
    const code = cleanCode(data?.code);
    const room = code && rooms.get(code);
    if (!room) return reply(cb, { ok: false, error: 'Spel niet gevonden.' });

    let p = typeof data.token === 'string' && room.players.find((x) => !x.isBot && x.token === data.token);
    let message;
    if (p) {
      if (p.socketId && p.socketId !== socket.id) {
        const old = io.sockets.sockets.get(p.socketId);
        if (old) {
          old.leave(room.code);
          old.data.code = old.data.playerId = null;
          old.emit('kicked', { reason: 'Je bent in een ander venster verbonden.' });
        }
      }
      if (!p.connected) message = `${p.name} is weer verbonden.`;
      p.connected = true;
      clearTimeout(p.removeTimer);
      if (gameRunning(room) && room.game.currentPlayer.id === p.id) clearTimeout(room.graceTimer);
    } else {
      const name = cleanText(data?.name, 20);
      if (!name) return reply(cb, { ok: false, error: 'Vul een naam in.' });
      if (gameRunning(room)) return reply(cb, { ok: false, error: 'Dit spel is al bezig.' });
      if (room.players.length >= MAX_PLAYERS) return reply(cb, { ok: false, error: 'Dit spel is vol.' });
      p = { id: crypto.randomUUID(), token: crypto.randomUUID(), name, isBot: false, connected: true, score: 0 };
      room.players.push(p);
      message = `${name} doet mee.`;
    }
    attach(socket, room, p);
    p.socketId = socket.id;
    clearTimeout(room.emptyTimer);
    if (room.paused) {
      room.paused = false;
      startTurn(room);
    }
    ensureHost(room);
    reply(cb, { ok: true, code: room.code, token: p.token });
    socket.emit('chatHistory', room.chat);
    if (message) sysMsg(room, message);
    broadcast(room);
  });

  socket.on('leaveRoom', () => detach(socket, true));
  socket.on('disconnect', () => detach(socket, false));

  socket.on('addBot', (_data, cb) => {
    const c = hostCtx();
    if (!c) return reply(cb, { ok: false, error: 'Alleen de host kan dit.' });
    const { room } = c;
    if (gameRunning(room)) return reply(cb, { ok: false, error: 'Het spel is al bezig.' });
    if (room.players.length >= MAX_PLAYERS) return reply(cb, { ok: false, error: 'Het spel is vol.' });
    const used = new Set(room.players.map((p) => p.name));
    const name = `Bot ${BOT_NAMES.find((n) => !used.has(`Bot ${n}`)) || room.players.length + 1}`;
    room.players.push({ id: crypto.randomUUID(), token: null, name, isBot: true, socketId: null, connected: true, score: 0 });
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on('removePlayer', (data, cb) => {
    const c = hostCtx();
    if (!c) return reply(cb, { ok: false, error: 'Alleen de host kan dit.' });
    const { room, player } = c;
    const target = playerById(room, data?.playerId);
    if (!target || target.id === player.id) return reply(cb, { ok: false, error: 'Ongeldige speler.' });
    if (gameRunning(room)) return reply(cb, { ok: false, error: 'Het spel is al bezig.' });
    const s = target.socketId && io.sockets.sockets.get(target.socketId);
    if (s) {
      s.leave(room.code);
      s.data.code = s.data.playerId = null;
      s.emit('kicked', { reason: 'De host heeft je uit het spel verwijderd.' });
    }
    removePlayer(room, target);
    if (!target.isBot) sysMsg(room, `${target.name} is verwijderd door de host.`);
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on('setTimer', (data) => {
    const c = hostCtx();
    if (!c || gameRunning(c.room) || !TIMER_OPTIONS.includes(data?.seconds)) return;
    c.room.settings.turnSeconds = data.seconds;
    broadcast(c.room);
  });

  socket.on('startGame', (_data, cb) => {
    const c = hostCtx();
    if (!c) return reply(cb, { ok: false, error: 'Alleen de host kan het spel starten.' });
    if (gameRunning(c.room)) return reply(cb, { ok: false, error: 'Het spel is al bezig.' });
    if (c.room.players.length < 2) return reply(cb, { ok: false, error: 'Je hebt minstens 2 spelers nodig (voeg eventueel een bot toe).' });
    startRound(c.room);
    reply(cb, { ok: true });
  });

  socket.on('draw', (_data, cb) => {
    const c = ctx();
    if (!c || !gameRunning(c.room) || !c.room.game.isTurnOf(c.player.id)) {
      return reply(cb, { ok: false, error: 'Je bent niet aan de beurt.' });
    }
    drawFor(c.room, c.player);
    reply(cb, { ok: true });
  });

  socket.on('play', (data, cb) => {
    const c = ctx();
    if (!c || !gameRunning(c.room)) return reply(cb, { ok: false, error: 'Er is geen spel bezig.' });
    const res = c.room.game.play(c.player.id, data?.board);
    if (!res.ok) return reply(cb, res);
    sysMsg(c.room, `${c.player.name} legt ${tilesText(res.played.length)}.`);
    afterTurn(c.room);
    reply(cb, { ok: true });
  });

  // Live view of the current player's work-in-progress for the other players.
  socket.on('preview', (data) => {
    const c = ctx();
    if (!c || !gameRunning(c.room) || !c.room.game.isTurnOf(c.player.id)) return;
    const g = c.room.game;
    const board = data?.board;
    if (!Array.isArray(board) || board.length > 80) return;
    const allowed = new Set([...g.board.flat(), ...g.currentPlayer.rack]);
    const seen = new Set();
    for (const set of board) {
      if (!Array.isArray(set) || set.length > 13) return;
      for (const id of set) {
        if (!allowed.has(id) || seen.has(id)) return;
        seen.add(id);
      }
    }
    c.room.preview = board;
    socket.to(c.room.code).emit('preview', {
      turnNumber: g.turnNumber,
      board: board.map((set) => set.map((id) => g.tiles[id])),
    });
  });

  socket.on('chat', (data) => {
    const c = ctx();
    if (!c) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < 400) return;
    const text = cleanText(data?.text, 300);
    if (!text) return;
    socket.data.lastChat = now;
    pushChat(c.room, { type: 'chat', playerId: c.player.id, name: c.player.name, text });
  });

  socket.on('newRound', (_data, cb) => {
    const c = hostCtx();
    if (!c) return reply(cb, { ok: false, error: 'Alleen de host kan een nieuwe ronde starten.' });
    if (!c.room.game || !c.room.game.finished) return reply(cb, { ok: false, error: 'De ronde is nog bezig.' });
    if (c.room.players.length < 2) return reply(cb, { ok: false, error: 'Je hebt minstens 2 spelers nodig.' });
    startRound(c.room);
    reply(cb, { ok: true });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Rummikub draait op http://localhost:${PORT}`));
}

module.exports = { server };
