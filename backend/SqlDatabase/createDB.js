const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const databasePath = path.join(__dirname, 'blockTogether.db');
const sourcePath = path.join(__dirname, '..', 'data', 'db.json');

function createDatabase() {
  // Once migrated, SQLite is the source of truth; db.json is only a seed.
  const existing = new Database(databasePath);
  try {
    const columns = existing.prepare('PRAGMA table_info(user_statistics)').all();
    if (['blocks', 'sessions', 'events'].every((name) => columns.some((column) => column.name === name)) &&
        existing.prepare('SELECT 1 FROM user_statistics WHERE blocks IS NOT NULL AND sessions IS NOT NULL AND events IS NOT NULL LIMIT 1').get()) {
      return databasePath;
    }
  } finally {
    existing.close();
  }
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const { user, blocks, sessions, events } = source;
  if (typeof user?.username !== 'string' || !user.username.trim()) {
    throw new Error('db.json must contain a user with a non-empty username');
  }

  const userSessions = sessions.filter((session) => session.userId === user.userId);
  const sessionIds = new Set(userSessions.map((session) => session.sessionId));
  const userEvents = events.filter((event) => sessionIds.has(event.sessionId));
  const completedSessions = userSessions.filter((session) => session.durationMinutes !== null);
  const totalMinutes = completedSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const countEvents = (type) => userEvents.filter((event) => event.type === type).length;

  const db = new Database(databasePath);
  try {
    db.transaction(() => {
      // One row per username. Counts and playtime mirror the backend stats API.
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_statistics (
          username TEXT NOT NULL PRIMARY KEY CHECK (length(trim(username)) > 0),
          userId INTEGER NOT NULL,
          totalSessions INTEGER NOT NULL DEFAULT 0 CHECK (totalSessions >= 0),
          totalPlaytimeMinutes INTEGER NOT NULL DEFAULT 0 CHECK (totalPlaytimeMinutes >= 0),
          averageSessionMinutes INTEGER NOT NULL DEFAULT 0 CHECK (averageSessionMinutes >= 0),
          blocksInWorld INTEGER NOT NULL DEFAULT 0 CHECK (blocksInWorld >= 0),
          blocksPlaced INTEGER NOT NULL DEFAULT 0 CHECK (blocksPlaced >= 0),
          blocksBroken INTEGER NOT NULL DEFAULT 0 CHECK (blocksBroken >= 0),
          entityKills INTEGER NOT NULL DEFAULT 0 CHECK (entityKills >= 0)
        );
      `);

      // Migrate the original totals-only table without adding more tables.
      const columns = db.prepare('PRAGMA table_info(user_statistics)').all();
      for (const name of ['blocks', 'sessions', 'events']) {
        if (!columns.some((column) => column.name === name)) {
          db.exec(`ALTER TABLE user_statistics ADD COLUMN ${name} TEXT CHECK (${name} IS NULL OR json_valid(${name}))`);
        }
      }

      // Seed only new users so running this script again cannot reset saved stats.
      // Break reminders remain calculated from recent sessions, since they expire.
      db.prepare(`
        INSERT INTO user_statistics (
          username, userId, totalSessions, totalPlaytimeMinutes,
          averageSessionMinutes, blocksInWorld, blocksPlaced, blocksBroken, entityKills
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO NOTHING
      `).run(
        user.username,
        user.userId,
        completedSessions.length,
        totalMinutes,
        completedSessions.length ? Math.round(totalMinutes / completedSessions.length) : 0,
        blocks.length,
        countEvents('block_placed'),
        countEvents('block_broken'),
        countEvents('entity_kill')
      );
      db.prepare(`
        UPDATE user_statistics SET
          blocks = COALESCE(blocks, ?),
          sessions = COALESCE(sessions, ?),
          events = COALESCE(events, ?)
        WHERE username = ?
      `).run(JSON.stringify(blocks), JSON.stringify(userSessions), JSON.stringify(userEvents), user.username);
    })();
  } finally {
    db.close();
  }
  return databasePath;
}

if (require.main === module) {
  try {
    console.log(`User statistics database ready: ${createDatabase()}`);
  } catch (error) {
    console.error(`Failed to create database: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createDatabase, databasePath };
