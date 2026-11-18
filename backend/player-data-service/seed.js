// Creates the tables and loads realistic demo data: npm run seed
import { resetSchema, createUser, createSession, endSession, addEvents, EVENT_TYPES } from "./db.js";

resetSchema();

let seedValue = 42; // tiny deterministic random generator so every run is the same
const rand = () => (seedValue = (seedValue * 1664525 + 1013904223) % 4294967296) / 4294967296;
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[between(0, arr.length - 1)];

const usernames = ["demo_player", "James", "Abdullah", "Cristian", "builder_bob", "maze_runner"];
const users = usernames.map((u) => createUser(u));
const games = ["home-world", "home-world", "home-world", "maze", "arena-shooter"];
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
let sessionCount = 0, eventCount = 0;

function addSession(user, startMs, minutes, game) {
  const s = createSession(user.id, game, new Date(startMs).toISOString());
  const n = between(3, 6);
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      type: pick(EVENT_TYPES), x: between(-20, 20), y: between(1, 8), z: between(-20, 20),
      timestamp: new Date(startMs + Math.floor((minutes * MIN * (i + 1)) / (n + 1))).toISOString()
    });
  }
  eventCount += addEvents(s.id, events);
  endSession(s.id, new Date(startMs + minutes * MIN).toISOString());
  sessionCount++;
}

// Older history: 4 sessions per user, spread over the last two weeks
for (const user of users) {
  for (let i = 0; i < 4; i++) {
    addSession(user, Date.now() - between(2, 14) * DAY - between(0, 600) * MIN, between(8, 55), pick(games));
  }
}
// demo_player played 75 minutes in the last day, so the break reminder is visible in the demo
addSession(users[0], Date.now() - 5 * 60 * MIN, 45, "home-world");
addSession(users[0], Date.now() - 2 * 60 * MIN, 30, "home-world");

console.log(`Seeded ${users.length} users, ${sessionCount} sessions and ${eventCount} events.`);
