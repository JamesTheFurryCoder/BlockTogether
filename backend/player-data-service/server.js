// Player Data Service (internal). Only the API Gateway should call this service.
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath as toPath } from "node:url";
import cors from "cors";
import * as db from "./db.js";
import { hashPassword, verifyPassword } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 4001;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "tcss460-secret";
const BREAK_AFTER_MINUTES = Number(process.env.BREAK_AFTER_MINUTES) || 60;

app.use(cors());
app.use(express.json());

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const parseId = (raw) => (/^\d+$/.test(raw) ? Number(raw) : null);
const bad = (res, message) => res.status(400).json({ error: message });

function requireApiKey(req, res, next) {
  if (req.header("x-api-key") !== SERVICE_API_KEY) {
    return res.status(401).json({ error: "Missing or invalid x-api-key header." });
  }
  next();
}

app.get("/health", (req, res) => res.json({ service: "player-data-service", status: "up" }));
// Swagger UI (open without a key, like /health).
const openApiDocument = YAML.parse(readFileSync(toPath(new URL("./openapi.yaml", import.meta.url)), "utf8"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.use(requireApiKey);

// ---------- authentication ----------
// POST /auth/register {username, password} -> 201, 400, 409
app.post("/auth/register", (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || !username.trim() || username.trim().length > 40) {
    return bad(res, "username is required (1 to 40 characters).");
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 100) {
    return bad(res, "password is required (6 to 100 characters).");
  }
  const name = username.trim();
  if (db.getUserByUsername(name)) return res.status(409).json({ error: `Username '${name}' is already taken.` });
  const user = db.createUser(name, hashPassword(password));
  res.status(201).json({ message: "User registered successfully", user: { id: user.id, username: user.username } });
});

// POST /auth/login {username, password} -> 200, 400, 401
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return bad(res, "username and password are required.");
  }
  const found = db.getCredentials(username.trim());
  if (!found || !verifyPassword(password, found.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  res.json({ message: "Login successful", user: { id: found.id, username: found.username } });
});

// ---------- users ----------
app.get("/users", (req, res) => res.json(db.listUsers()));

app.get("/users/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "User id must be a positive integer.");
  const user = db.getUser(id);
  if (!user) return res.status(404).json({ error: `User '${id}' was not found.` });
  res.json(user);
});

app.post("/users", (req, res) => {
  const username = req.body?.username;
  if (typeof username !== "string" || !username.trim() || username.length > 40) {
    return bad(res, "username is required (1 to 40 characters).");
  }
  if (db.getUserByUsername(username.trim())) {
    return res.status(409).json({ error: `Username '${username.trim()}' is already taken.` });
  }
  res.status(201).json(db.createUser(username.trim()));
});

app.get("/users/:id/stats", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "User id must be a positive integer.");
  if (!db.getUser(id)) return res.status(404).json({ error: `User '${id}' was not found.` });
  res.json(db.getUserStats(id, BREAK_AFTER_MINUTES));
});

// ---------- sessions: full CRUD ----------
app.get("/sessions", (req, res) => {
  const { userId, limit = "50", offset = "0" } = req.query;
  const filter = {};
  if (userId !== undefined) {
    if (!/^\d+$/.test(userId)) return bad(res, "userId must be a positive integer.");
    filter.userId = Number(userId);
  }
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) return bad(res, "limit must be 1 to 200.");
  if (!/^\d+$/.test(offset)) return bad(res, "offset must be 0 or more.");
  res.json(db.listSessions({ ...filter, limit: Number(limit), offset: Number(offset) }));
});

app.get("/sessions/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "Session id must be a positive integer.");
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: `Session '${id}' was not found.` });
  res.json(session);
});

app.post("/sessions", (req, res) => {
  const { userId, game } = req.body || {};
  if (!isPositiveInt(userId)) return bad(res, "userId must be a positive integer.");
  if (game !== undefined && (typeof game !== "string" || !game.trim() || game.length > 40)) {
    return bad(res, "game must be a non-empty string (max 40 characters).");
  }
  if (!db.getUser(userId)) return res.status(404).json({ error: `User '${userId}' was not found.` });
  res.status(201).json(db.createSession(userId, game?.trim() || "home-world"));
});

app.patch("/sessions/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "Session id must be a positive integer.");
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: `Session '${id}' was not found.` });
  if (session.endedAt) return res.status(409).json({ error: `Session '${id}' has already ended.` });
  const ended = new Date(req.body?.endedAt ?? Date.now());
  if (Number.isNaN(ended.getTime()) || ended < new Date(session.startedAt)) {
    return bad(res, "endedAt must be a valid time after the session started.");
  }
  res.json(db.endSession(id, ended.toISOString()));
});

app.delete("/sessions/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "Session id must be a positive integer.");
  if (!db.deleteSession(id)) return res.status(404).json({ error: `Session '${id}' was not found.` });
  res.status(204).end();
});

// ---------- events (belong to a session) ----------
app.get("/sessions/:id/events", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "Session id must be a positive integer.");
  if (!db.getSession(id)) return res.status(404).json({ error: `Session '${id}' was not found.` });
  res.json(db.listEvents(id));
});

app.post("/sessions/:id/events", (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return bad(res, "Session id must be a positive integer.");
  if (!db.getSession(id)) return res.status(404).json({ error: `Session '${id}' was not found.` });
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 500) {
    return bad(res, "events must be an array of 1 to 500 items.");
  }
  for (const e of events) {
    if (!e || !db.EVENT_TYPES.includes(e.type) || !isNum(e.x) || !isNum(e.y) || !isNum(e.z)) {
      return bad(res, `Each event needs type (${db.EVENT_TYPES.join(", ")}) and numeric x, y, z.`);
    }
  }
  res.status(201).json({ saved: db.addEvents(id, events) });
});

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return bad(res, "Request body is not valid JSON.");
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => console.log(`Player Data Service running at http://localhost:${PORT}`));
