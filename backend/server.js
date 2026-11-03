// BlockTogether backend (Express). Demo data is stored in data/db.json.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const MAX_BLOCKS_PER_REQUEST = 1000;
const EVENT_TYPES = ['position', 'block_placed', 'block_broken', 'entity_kill'];
const BREAK_AFTER_MINUTES = 60; // suggest a break after this much playtime today

app.use(cors());
app.use(express.json());

const readDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDb = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const isInt = (n) => Number.isInteger(n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- World blocks ---
app.get('/api/worlds/me/blocks', (req, res) => {
  const { blocks } = readDb();
  res.json({ count: blocks.length, blocks });
});

app.post('/api/worlds/me/blocks', (req, res) => {
  const { blocks } = req.body;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: 'blocks must be a non-empty array' });
  }
  if (blocks.length > MAX_BLOCKS_PER_REQUEST) {
    return res.status(400).json({ error: `max ${MAX_BLOCKS_PER_REQUEST} blocks per request` });
  }
  for (const b of blocks) {
    if (!b || !isInt(b.x) || !isInt(b.y) || !isInt(b.z) || !isInt(b.blockId) || b.blockId < 0) {
      return res.status(400).json({ error: 'each block needs integer x, y, z and blockId >= 0 (0 removes a block)' });
    }
  }
  const db = readDb();
  for (const b of blocks) {
    db.blocks = db.blocks.filter((o) => !(o.x === b.x && o.y === b.y && o.z === b.z));
    if (b.blockId !== 0) db.blocks.push({ x: b.x, y: b.y, z: b.z, blockId: b.blockId });
  }
  writeDb(db);
  res.status(201).json({ saved: blocks.length, totalBlocks: db.blocks.length });
});

// --- Sessions ---
app.post('/api/sessions', (req, res) => {
  const db = readDb();
  const session = {
    sessionId: db.sessions.length ? Math.max(...db.sessions.map((s) => s.sessionId)) + 1 : 1,
    userId: db.user.userId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMinutes: null
  };
  db.sessions.push(session);
  writeDb(db);
  res.status(201).json(session);
});

app.patch('/api/sessions/:id', (req, res) => {
  const db = readDb();
  const session = db.sessions.find((s) => s.sessionId === Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.endedAt) return res.status(409).json({ error: 'session already ended' });
  const ended = new Date(req.body.endedAt || Date.now());
  if (isNaN(ended.getTime()) || ended < new Date(session.startedAt)) {
    return res.status(400).json({ error: 'endedAt must be a valid time after startedAt' });
  }
  session.endedAt = ended.toISOString();
  session.durationMinutes = Math.round((ended - new Date(session.startedAt)) / 60000);
  writeDb(db);
  res.json(session);
});

// --- Gameplay events ---
app.post('/api/events', (req, res) => {
  const { sessionId, events } = req.body;
  const db = readDb();
  if (!db.sessions.some((s) => s.sessionId === sessionId)) {
    return res.status(404).json({ error: 'session not found' });
  }
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events must be a non-empty array' });
  }
  for (const e of events) {
    if (!e || !EVENT_TYPES.includes(e.type) || !isNum(e.x) || !isNum(e.y) || !isNum(e.z)) {
      return res.status(400).json({ error: `each event needs type (${EVENT_TYPES.join(', ')}) and numeric x, y, z` });
    }
  }
  let nextId = db.events.length ? Math.max(...db.events.map((e) => e.eventId)) + 1 : 1;
  for (const e of events) {
    db.events.push({ eventId: nextId++, sessionId, type: e.type, x: e.x, y: e.y, z: e.z, timestamp: e.timestamp || new Date().toISOString() });
  }
  writeDb(db);
  res.status(201).json({ saved: events.length });
});

// --- Stats (plain statistics) ---
app.get('/api/users/me/stats', (req, res) => {
  const db = readDb();
  const done = db.sessions.filter((s) => s.durationMinutes !== null);
  const totalMinutes = done.reduce((sum, s) => sum + s.durationMinutes, 0);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const minutesLast24h = done.filter((s) => new Date(s.startedAt).getTime() >= since)
    .reduce((sum, s) => sum + s.durationMinutes, 0);
  const count = (type) => db.events.filter((e) => e.type === type).length;
  res.json({
    totalSessions: done.length,
    totalPlaytimeMinutes: totalMinutes,
    averageSessionMinutes: done.length ? Math.round(totalMinutes / done.length) : 0,
    blocksInWorld: db.blocks.length,
    blocksPlaced: count('block_placed'),
    blocksBroken: count('block_broken'),
    entityKills: count('entity_kill'),
    breakReminder: minutesLast24h >= BREAK_AFTER_MINUTES,
    breakReminderMessage: minutesLast24h >= BREAK_AFTER_MINUTES
      ? `You have played ${minutesLast24h} minutes in the last 24 hours. Consider taking a break!`
      : null
  });
});

// Unknown routes and unexpected errors return JSON
app.use((req, res) => res.status(404).json({ error: 'route not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => console.log(`BlockTogether backend running on http://localhost:${PORT}`));
