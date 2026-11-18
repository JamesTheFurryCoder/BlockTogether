// Gameplay is stored in SQLite; authentication remains in logindata.json.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabase } = require('./SqlDatabase/createDB');

const app = express();
const PORT = process.env.PORT || 3001;
const sqlite = new Database(createDatabase());
// Preserve the existing single-user /me behavior until authenticated sessions exist.
const currentUser = sqlite.prepare('SELECT username FROM user_statistics ORDER BY userId, username LIMIT 1').get();
if (!currentUser) throw new Error('SQLite database has no gameplay user');
const DBLOGIN_FILE = path.join(__dirname, 'data', 'logindata.json');
const MAX_BLOCKS_PER_REQUEST = 1000;
const EVENT_TYPES = ['position', 'block_placed', 'block_broken', 'entity_kill'];
const BREAK_AFTER_MINUTES = 60; // suggest a break after this much playtime today

app.use(cors());
app.use(express.json());

const selectUser = sqlite.prepare('SELECT * FROM user_statistics WHERE username = ?');
const insertUser = sqlite.prepare(`
  INSERT INTO user_statistics (username, userId, blocks, sessions, events)
  VALUES (?, (SELECT COALESCE(MAX(userId), 0) + 1 FROM user_statistics), '[]', '[]', '[]')
`);
const readLoginDb = () => JSON.parse(fs.readFileSync(DBLOGIN_FILE, 'utf8'));
const writeLoginDb = (db) => fs.writeFileSync(DBLOGIN_FILE, JSON.stringify(db, null, 2));
const isInt = (n) => Number.isInteger(n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

app.post('/api/login', (req, res) => {
  const { username: inputUsername, password } = req.body ?? {};
  const username = typeof inputUsername === 'string' ? inputUsername.trim() : inputUsername;

  if (typeof username !== 'string' || !username.trim() ||
      typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const loginDb = readLoginDb();
  const retrievedUser = Object.hasOwn(loginDb, username)
    ? loginDb[username]
    : null;

  if (!retrievedUser || retrievedUser.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password. Usernames and passwords are case-sensitive.' });
  }

  return res.status(200).json({
    message: 'Login successful',
    user: { username }
  });
});

app.post('/api/register', (req, res) => {
  const { username: inputUsername, password } = req.body ?? {};
  const username = typeof inputUsername === 'string' ? inputUsername.trim() : inputUsername;

  if (typeof username !== 'string' || !username.trim() ||
      typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const loginDb = readLoginDb();

  if (Object.hasOwn(loginDb, username) || selectUser.get(username)) {
    return res.status(409).json({ error: 'User already exists' });
  }

  Object.defineProperty(loginDb, username, {
    value: { password },
    enumerable: true,
    writable: true,
    configurable: true
  });
  // Statistics default to zero in the schema. Roll back the SQLite insert if
  // saving the JSON credentials fails, so the user can retry registration.
  sqlite.transaction(() => {
    insertUser.run(username);
    writeLoginDb(loginDb);
  }).immediate();

  return res.status(201).json({ message: 'User registered successfully' });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Gameplay requests must name a user; never silently write to the demo row.
function readGameplayDb(req, res) {
  let username;
  if (req.method === 'GET') {
    username = req.query.username;
  } else {
    username = req.body?.username;
  }
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'username must be a non-empty string in the query for GET requests or JSON body for writes' });
    return null;
  }
  const user = selectUser.get(username.trim());
  if (!user) {
    res.status(404).json({ error: 'user not found' });
    return null;
  }
  return user;
}

// --- World blocks ---
// Keep blockId 0 as an air override so broken generated terrain stays broken.
app.get('/api/worlds/me/blocks', (req, res) => {
  const db = readGameplayDb(req, res);
  if (!db) return;
  const blocks = sqlite.prepare(`
    SELECT json_extract(block.value, '$.x') AS x,
           json_extract(block.value, '$.y') AS y,
           json_extract(block.value, '$.z') AS z,
           json_extract(block.value, '$.blockId') AS blockId
    FROM user_statistics AS users, json_each(users.blocks) AS block
    WHERE users.username = ?
  `).all(db.username);
  res.json({ count: blocks.length, blocks });
});

app.post('/api/worlds/me/blocks', (req, res) => {
  const { blocks } = req.body ?? {};
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
  const db = readGameplayDb(req, res);
  if (!db) return;
  sqlite.transaction(() => {
    const upsertBlock = sqlite.prepare(`
      UPDATE user_statistics
      SET blocks = json_insert(
        (SELECT json_group_array(json(value)) FROM json_each(blocks)
         WHERE NOT (json_extract(value, '$.x') = @x
                AND json_extract(value, '$.y') = @y
                AND json_extract(value, '$.z') = @z)),
        '$[#]', json_object('x', @x, 'y', @y, 'z', @z, 'blockId', @blockId))
      WHERE username = @username
    `);
    for (const block of blocks) upsertBlock.run({ ...block, username: db.username });
    sqlite.prepare(`
      UPDATE user_statistics
      SET blocksInWorld = (SELECT COUNT(*) FROM json_each(blocks)
                           WHERE json_extract(value, '$.blockId') != 0)
      WHERE username = ?
    `).run(db.username);
  }).immediate();
  const totals = sqlite.prepare(`
    SELECT blocksInWorld AS totalBlocks FROM user_statistics WHERE username = ?
  `).get(db.username);
  res.status(201).json({ saved: blocks.length, totalBlocks: totals.totalBlocks });
});

// --- Sessions ---
app.post('/api/sessions', (req, res) => {
  const db = readGameplayDb(req, res);
  if (!db) return;
  const session = sqlite.transaction(() => {
    const { sessionId } = sqlite.prepare(`
      SELECT COALESCE(MAX(json_extract(session.value, '$.sessionId')), 0) + 1 AS sessionId
      FROM user_statistics AS users, json_each(users.sessions) AS session
      WHERE users.username = ?
    `).get(db.username);
    const startedAt = new Date().toISOString();
    sqlite.prepare(`
      UPDATE user_statistics
      SET sessions = json_insert(sessions, '$[#]', json_object(
        'sessionId', ?, 'userId', userId, 'startedAt', ?,
        'endedAt', NULL, 'durationMinutes', NULL))
      WHERE username = ?
    `).run(sessionId, startedAt, db.username);
    return { sessionId, userId: db.userId, startedAt, endedAt: null, durationMinutes: null };
  }).immediate();
  res.status(201).json(session);
});

app.patch('/api/sessions/:id', (req, res) => {
  const db = readGameplayDb(req, res);
  if (!db) return;
  const session = sqlite.prepare(`
    SELECT session.key AS arrayIndex,
           json_extract(session.value, '$.sessionId') AS sessionId,
           users.userId, json_extract(session.value, '$.startedAt') AS startedAt,
           json_extract(session.value, '$.endedAt') AS endedAt
    FROM user_statistics AS users, json_each(users.sessions) AS session
    WHERE users.username = ? AND json_extract(session.value, '$.sessionId') = ?
  `).get(db.username, Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.endedAt) return res.status(409).json({ error: 'session already ended' });
  const ended = new Date(req.body?.endedAt || Date.now());
  if (isNaN(ended.getTime()) || ended < new Date(session.startedAt)) {
    return res.status(400).json({ error: 'endedAt must be a valid time after startedAt' });
  }
  session.endedAt = ended.toISOString();
  session.durationMinutes = Math.round((ended - new Date(session.startedAt)) / 60000);
  const updated = sqlite.prepare(`
    UPDATE user_statistics
    SET sessions = json_set(sessions, ?, ?, ?, ?),
        totalSessions = totalSessions + 1,
        totalPlaytimeMinutes = totalPlaytimeMinutes + @duration,
        averageSessionMinutes = CAST(ROUND(
          (totalPlaytimeMinutes + @duration) * 1.0 / (totalSessions + 1)) AS INTEGER)
    WHERE username = @username
      AND json_extract(sessions, @endedPath) IS NULL
  `).run({ duration: session.durationMinutes, username: db.username,
    endedPath: `$[${session.arrayIndex}].endedAt` },
    `$[${session.arrayIndex}].endedAt`, session.endedAt,
    `$[${session.arrayIndex}].durationMinutes`, session.durationMinutes);
  if (!updated.changes) return res.status(409).json({ error: 'session already ended' });
  const { arrayIndex, ...result } = session;
  res.json(result);
});

// --- Gameplay events ---
app.post('/api/events', (req, res) => {
  const { sessionId, events } = req.body ?? {};
  const db = readGameplayDb(req, res);
  if (!db) return;
  if (!isInt(sessionId) || !sqlite.prepare(`
    SELECT 1 FROM user_statistics AS users, json_each(users.sessions) AS session
    WHERE users.username = ? AND json_extract(session.value, '$.sessionId') = ?
  `).get(db.username, sessionId)) {
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
  sqlite.transaction(() => {
    const insertEvent = sqlite.prepare(`
      UPDATE user_statistics
      SET events = json_insert(events, '$[#]', json_object(
        'eventId', (SELECT COALESCE(MAX(json_extract(value, '$.eventId')), 0) + 1
                    FROM json_each(events)),
        'sessionId', @sessionId, 'type', @type, 'x', @x, 'y', @y, 'z', @z,
        'timestamp', @timestamp)),
        blocksPlaced = blocksPlaced + CASE WHEN @type = 'block_placed' THEN 1 ELSE 0 END,
        blocksBroken = blocksBroken + CASE WHEN @type = 'block_broken' THEN 1 ELSE 0 END,
        entityKills = entityKills + CASE WHEN @type = 'entity_kill' THEN 1 ELSE 0 END
      WHERE username = @username
    `);
    for (const event of events) {
      insertEvent.run({ username: db.username, sessionId, type: event.type,
        x: event.x, y: event.y, z: event.z,
        timestamp: event.timestamp || new Date().toISOString() });
    }
  }).immediate();
  res.status(201).json({ saved: events.length });
});

// --- Stats (plain statistics) ---
app.get('/api/users/me/stats', (req, res) => {
  // Optional query argument; omitted usernames preserve the demo-user behavior.
  const requestedUsername = req.query.username;
  if (requestedUsername !== undefined &&
      (typeof requestedUsername !== 'string' || !requestedUsername.trim())) {
    return res.status(400).json({ error: 'username must be a non-empty string' });
  }
  const username = requestedUsername === undefined ? currentUser.username : requestedUsername.trim();
  const user = selectUser.get(username);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { minutesLast24h } = sqlite.prepare(`
    SELECT COALESCE(SUM(json_extract(session.value, '$.durationMinutes')), 0) AS minutesLast24h
    FROM user_statistics AS users, json_each(users.sessions) AS session
    WHERE users.username = ? AND json_extract(session.value, '$.startedAt') >= ?
  `).get(username, since);
  res.json({
    totalSessions: user.totalSessions,
    totalPlaytimeMinutes: user.totalPlaytimeMinutes,
    averageSessionMinutes: user.averageSessionMinutes,
    blocksInWorld: user.blocksInWorld,
    blocksPlaced: user.blocksPlaced,
    blocksBroken: user.blocksBroken,
    entityKills: user.entityKills,
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

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`BlockTogether backend running on http://localhost:${PORT}`));
  const shutdown = () => server.close(() => sqlite.close());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { app, sqlite };
