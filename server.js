const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

/* ================== DATABASE INITIALIZATION ================== */
const db = new sqlite3.Database('./teenpatti.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    coins INTEGER DEFAULT 10000,
    referral_code TEXT UNIQUE
  )`);
});

/* ================== TEEN PATTI ENGINE ================== */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function generateDeck() {
  const deck = [];
  for (let s of SUITS) {
    for (let r = 0; r < RANKS.length; r++) {
      deck.push({ suit: s, rank: RANKS[r], val: r + 2 });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function evaluateHand(cards) {
  if (!cards || cards.length < 3) return { score: 0, desc: 'Invalid' };
  const v = cards.map(c => c.val).sort((a, b) => b - a);
  const isFlush = cards[0].suit === cards[1].suit && cards[1].suit === cards[2].suit;
  const isSeq = (v[0] - v[1] === 1 && v[1] - v[2] === 1) || (v[0] === 14 && v[1] === 3 && v[2] === 2);
  const isTrail = v[0] === v[1] && v[1] === v[2];
  const isPair = v[0] === v[1] || v[1] === v[2] || v[0] === v[2];

  if (isTrail) return { score: 6000000 + v[0], desc: 'Trail (Trio)' };
  if (isFlush && isSeq) return { score: 5000000 + v[0], desc: 'Pure Sequence' };
  if (isSeq) return { score: 4000000 + v[0], desc: 'Sequence' };
  if (isFlush) return { score: 3000000 + v[0] * 10000 + v[1] * 100 + v[2], desc: 'Color (Flush)' };
  if (isPair) {
    const pairVal = (v[0] === v[1] || v[0] === v[2]) ? v[0] : v[1];
    return { score: 2000000 + pairVal * 100, desc: 'Pair' };
  }
  return { score: 1000000 + v[0] * 10000 + v[1] * 100 + v[2], desc: `High Card ${cards.find(c => c.val === v[0]).rank}` };
}

/* ================== TABLE MANAGER ================== */
const tables = new Map();

class GameTable {
  constructor(roomId, boot = 100) {
    this.roomId = roomId;
    this.boot = boot;
    this.currentStake = boot;
    this.pot = 0;
    this.players = [];
    this.status = 'WAITING';
    this.currentTurnIdx = 0;
  }

  addPlayer(user, socketId) {
    if (this.players.length >= 6) return false;
    let seat = 0;
    const takenSeats = this.players.map(p => p.seat);
    while (takenSeats.includes(seat)) seat++;

    const player = {
      id: user.id,
      name: user.name,
      socketId: socketId,
      seat: seat,
      coins: user.coins || 10000,
      cards: [],
      isSeen: false,
      folded: false
    };
    this.players.push(player);
    return player;
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx !== -1) {
      this.players.splice(idx, 1);
      if (this.players.length < 2 && this.status === 'IN_PROGRESS') {
        this.status = 'WAITING';
      }
    }
  }

  startNewHand() {
    if (this.players.length < 2) return;
    this.status = 'IN_PROGRESS';
    this.pot = 0;
    this.currentStake = this.boot;
    const deck = generateDeck();

    this.players.forEach(p => {
      p.coins -= this.boot;
      this.pot += this.boot;
      p.folded = false;
      p.isSeen = false;
      p.cards = [deck.pop(), deck.pop(), deck.pop()];
    });

    this.currentTurnIdx = 0;
    this.broadcastState('New hand started! Cards dealt.');
    this.sendCardsPrivately();
  }

  broadcastState(message) {
    const sanitized = this.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      coins: p.coins,
      isSeen: p.isSeen,
      folded: p.folded
    }));

    io.to(this.roomId).emit('tableUpdate', {
      roomId: this.roomId,
      pot: this.pot,
      currentStake: this.currentStake,
      status: this.status,
      message: message,
      players: sanitized,
      currentTurnIdx: this.currentTurnIdx
    });
  }

  sendCardsPrivately() {
    this.players.forEach(p => {
      io.to(p.socketId).emit('privateCards', { cards: p.cards });
    });
  }
}

/* ================== SOCKET ROUTING ================== */
io.on('connection', (socket) => {
  let curUser = null;
  let curTable = null;

  socket.on('joinTable', (userData) => {
    curUser = userData;
    let table = null;
    for (let [id, t] of tables) {
      if (t.players.length < 6) { table = t; break; }
    }
    if (!table) {
      const roomKey = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
      table = new GameTable(roomKey, 100);
      tables.set(roomKey, table);
    }

    curTable = table;
    socket.join(table.roomId);
    table.addPlayer(curUser, socket.id);
    table.broadcastState(`${curUser.name} joined table.`);

    if (table.players.length >= 2 && table.status === 'WAITING') {
      setTimeout(() => table.startNewHand(), 1500);
    }
  });

  socket.on('disconnect', () => {
    if (curTable) {
      curTable.removePlayer(socket.id);
      if (curTable.players.length === 0) tables.delete(curTable.roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// Live Multiplayer Room Logic
io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const room = data.room || 'table-1';
        socket.join(room);
        const count = io.sockets.adapter.rooms.get(room)?.size || 1;
        io.to(room).emit('gameState', { activePlayers: count });
    });
});
