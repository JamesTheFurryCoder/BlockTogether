// All SQL for the Player Data Service lives in this module (parameterized queries only).
// Uses Node's built-in SQLite (node:sqlite), so there is nothing native to install.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(here, "data", "players.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const EVENT_TYPES = ["position", "block_placed", "block_broken", "entity_kill"];

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE CHECK (length(trim(username)) > 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game TEXT NOT NULL DEFAULT 'home-world',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 0)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('position','block_placed','block_broken','entity_kill')),
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  `);
}

export function resetSchema() {
  db.exec("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;");
  initSchema();
}

initSchema();

const toSession = (r) => r && ({
  id: r.id, userId: r.user_id, game: r.game, startedAt: r.started_at,
  endedAt: r.ended_at, durationMinutes: r.duration_minutes
});
const toEvent = (r) => ({ id: r.id, sessionId: r.session_id, type: r.type, x: r.x, y: r.y, z: r.z, createdAt: r.created_at });
const toUser = (r) => r && ({ id: r.id, username: r.username, createdAt: r.created_at });

// ---- users ----
export const listUsers = () => db.prepare("SELECT * FROM users ORDER BY id").all().map(toUser);
export const getUser = (id) => toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
export const getUserByUsername = (name) => toUser(db.prepare("SELECT * FROM users WHERE username = ?").get(name));
export function createUser(username) {
  const info = db.prepare("INSERT INTO users (username, created_at) VALUES (?, ?)").run(username, new Date().toISOString());
  return getUser(Number(info.lastInsertRowid));
}

// ---- sessions (full CRUD) ----
export function createSession(userId, game = "home-world", startedAt = new Date().toISOString()) {
  const info = db.prepare("INSERT INTO sessions (user_id, game, started_at) VALUES (?, ?, ?)").run(userId, game, startedAt);
  return getSession(Number(info.lastInsertRowid));
}
export const getSession = (id) => toSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id));
export function listSessions({ userId, limit = 50, offset = 0 } = {}) {
  const rows = userId
    ? db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?").all(userId, limit, offset)
    : db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  return rows.map(toSession);
}
export function endSession(id, endedAt) {
  const s = getSession(id);
  const minutes = Math.max(0, Math.round((new Date(endedAt) - new Date(s.startedAt)) / 60000));
  db.prepare("UPDATE sessions SET ended_at = ?, duration_minutes = ? WHERE id = ?").run(endedAt, minutes, id);
  return getSession(id);
}
export function deleteSession(id) {
  return db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
}

// ---- events ----
export function addEvents(sessionId, events) {
  const stmt = db.prepare("INSERT INTO events (session_id, type, x, y, z, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const e of events) stmt.run(sessionId, e.type, e.x, e.y, e.z, e.timestamp || new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  return events.length;
}
export const listEvents = (sessionId, limit = 200) =>
  db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id LIMIT ?").all(sessionId, limit).map(toEvent);

// ---- statistics (plain SQL aggregates) ----
export function getUserStats(userId, breakAfterMinutes = 60) {
  const totals = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(duration_minutes), 0) AS minutes FROM sessions WHERE user_id = ? AND ended_at IS NOT NULL"
  ).get(userId);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = db.prepare(
    "SELECT COALESCE(SUM(duration_minutes), 0) AS minutes FROM sessions WHERE user_id = ? AND ended_at IS NOT NULL AND started_at >= ?"
  ).get(userId, since).minutes;
  const byType = db.prepare(
    "SELECT e.type AS type, COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.user_id = ? GROUP BY e.type"
  ).all(userId);
  const count = (t) => Number(byType.find((r) => r.type === t)?.n || 0);
  const breakReminder = recent >= breakAfterMinutes;
  return {
    userId,
    totalSessions: Number(totals.n),
    totalPlaytimeMinutes: Number(totals.minutes),
    averageSessionMinutes: totals.n ? Math.round(Number(totals.minutes) / Number(totals.n)) : 0,
    playtimeLast24hMinutes: Number(recent),
    blocksPlaced: count("block_placed"),
    blocksBroken: count("block_broken"),
    entityKills: count("entity_kill"),
    positionSamples: count("position"),
    breakReminder,
    breakReminderMessage: breakReminder
      ? `You have played ${recent} minutes in the last 24 hours. Consider taking a break!` : null
  };
}
