// Documented API tests. They call the running API Gateway (default http://localhost:3000).
// Start everything first:  npm run seed && npm run start:services   then run:  npm run test:api
// Test 5 (502) needs the External API Service stopped; set EXPECT_EXTERNAL_DOWN=1 to run it.
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.GATEWAY_URL || "http://localhost:3000";
const call = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const unique = () => `tester_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

test("1. Success: GET /api/players/1/stats returns stats with a break reminder", async () => {
  const { status, body } = await call("/api/players/1/stats");
  assert.equal(status, 200);
  assert.equal(body.userId, 1);
  assert.equal(typeof body.totalSessions, "number");
  assert.equal(typeof body.breakReminder, "boolean");
});

test("2. Success: POST /api/register then POST /api/login", async () => {
  const username = unique();
  const created = await call("/api/register", { method: "POST", body: { username, password: "secret123" } });
  assert.equal(created.status, 201);
  const login = await call("/api/login", { method: "POST", body: { username, password: "secret123" } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, username);
});

test("3. 400: POST /api/sessions without a userId", async () => {
  const { status, body } = await call("/api/sessions", { method: "POST", body: {} });
  assert.equal(status, 400);
  assert.match(body.error, /userId/);
});

test("4. 401: POST /api/login with a wrong password", async () => {
  const { status, body } = await call("/api/login", { method: "POST", body: { username: "demo_player", password: "wrong-password" } });
  assert.equal(status, 401);
  assert.match(body.error, /Invalid/);
});

test("5. 404: GET /api/players/9999 for a player that does not exist", async () => {
  const { status, body } = await call("/api/players/9999");
  assert.equal(status, 404);
  assert.ok(body.error);
});

test("6. 409: POST /api/register with a username that is taken", async () => {
  const { status } = await call("/api/register", { method: "POST", body: { username: "demo_player", password: "secret123" } });
  assert.equal(status, 409);
});

test("7. Full CRUD: start, end and delete a session", async () => {
  const started = await call("/api/sessions", { method: "POST", body: { userId: 1, game: "maze" } });
  assert.equal(started.status, 201);
  const id = started.body.id;
  const ended = await call(`/api/sessions/${id}`, { method: "PATCH", body: {} });
  assert.equal(ended.status, 200);
  assert.ok(ended.body.endedAt);
  const removed = await call(`/api/sessions/${id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.equal((await call(`/api/sessions/${id}`)).status, 404);
});

test("8. AI mock: POST /api/ai/insights returns a summary (needs AI_MODE=mock)", async () => {
  const stats = { totalSessions: 6, totalPlaytimeMinutes: 157, blocksPlaced: 8, blocksBroken: 6 };
  const { status, body } = await call("/api/ai/insights", { method: "POST", body: { stats } });
  assert.equal(status, 200);
  assert.equal(body.mode, "mock");
  assert.match(body.summary, /6 sessions/);
});

test("9. 400: GET /api/weather without a city", async () => {
  const { status } = await call("/api/weather");
  assert.equal(status, 400);
});

test("10. 502: weather call while the External API Service is stopped", { skip: !process.env.EXPECT_EXTERNAL_DOWN }, async () => {
  const { status, body } = await call("/api/weather?city=Tacoma");
  assert.equal(status, 502);
  assert.ok(body.error);
});
