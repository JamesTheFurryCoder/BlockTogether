// API Gateway: the single public entry point. The browser calls only this server.
// It adds the internal x-api-key header and forwards requests to the services.
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "tcss460-secret";
const SERVICES = {
  player: process.env.PLAYER_URL || "http://localhost:4001",
  external: process.env.EXTERNAL_API_URL || "http://localhost:4003",
  ai: process.env.AI_AGENT_URL || "http://localhost:4004"
};

app.use(cors());
app.use(express.json());

// Interactive API documentation, generated from the hand-written openapi.yaml.
const openApiDocument = YAML.parse(readFileSync(fileURLToPath(new URL("./openapi.yaml", import.meta.url)), "utf8"));
app.get("/openapi.json", (req, res) => res.json(openApiDocument));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

async function forward(res, service, path, options = {}) {
  try {
    const response = await fetch(`${SERVICES[service]}${path}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", "x-api-key": SERVICE_API_KEY },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 10_000)
    });
    if (response.status === 204) return res.status(204).end();
    const text = await response.text();
    // options.text: pass plain-text answers (such as generated block lists) through unchanged.
    if (options.text && response.ok) return res.status(response.status).type("text/plain").send(text);
    let data;
    try { data = JSON.parse(text); } catch { data = { error: "The service returned an invalid response." }; }
    res.status(response.status).json(data);
  } catch {
    res.status(502).json({ error: `The API Gateway could not reach the ${service} service.` });
  }
}
const enc = encodeURIComponent;
const qs = (req) => {
  const i = req.originalUrl.indexOf("?");
  return i === -1 ? "" : req.originalUrl.slice(i);
};

// ---------- health: reports every service, 503 if any is down ----------
app.get("/api/health", async (req, res) => {
  const entries = await Promise.all(Object.entries(SERVICES).map(async ([name, url]) => {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return [name, r.ok ? "up" : "down"];
    } catch { return [name, "down"]; }
  }));
  const services = Object.fromEntries(entries);
  const allUp = entries.every(([, s]) => s === "up");
  res.status(allUp ? 200 : 503).json({ gateway: "up", services });
});

// ---------- external API service ----------
app.get("/api/external/health", (req, res) => forward(res, "external", "/health"));
// GET /api/weather?city=Tacoma&state=Washington&country=US
app.get("/api/weather", (req, res) => {
  if (typeof req.query.city !== "string" || !req.query.city.trim()) {
    return res.status(400).json({ error: "The city query parameter is required." });
  }
  forward(res, "external", `/weather${qs(req)}`);
});

// ---------- AI agent service ----------
// POST /api/ai/insights {stats:{totalSessions,totalPlaytimeMinutes,blocksPlaced,blocksBroken}}
app.post("/api/ai/insights", (req, res) => forward(res, "ai", "/insights", { method: "POST", body: req.body, timeoutMs: 40_000 }));
// POST /api/ai/blocks {prompt} -> plain text, one "x,y,z,id" block per line
app.post("/api/ai/blocks", (req, res) => forward(res, "ai", "/aipromptblocksgenerator", { method: "POST", body: req.body, timeoutMs: 70_000, text: true }));

// ---------- login and register ----------
app.post("/api/register", (req, res) => forward(res, "player", "/auth/register", { method: "POST", body: req.body }));
app.post("/api/login", (req, res) => forward(res, "player", "/auth/login", { method: "POST", body: req.body }));

// ---------- players ----------
app.get("/api/players", (req, res) => forward(res, "player", "/users"));
app.post("/api/players", (req, res) => forward(res, "player", "/users", { method: "POST", body: req.body }));
app.get("/api/players/:id", (req, res) => forward(res, "player", `/users/${enc(req.params.id)}`));
app.get("/api/players/:id/stats", (req, res) => forward(res, "player", `/users/${enc(req.params.id)}/stats`));

// ---------- sessions: full CRUD ----------
app.get("/api/sessions", (req, res) => forward(res, "player", `/sessions${qs(req)}`));
app.post("/api/sessions", (req, res) => forward(res, "player", "/sessions", { method: "POST", body: req.body }));
app.get("/api/sessions/:id", (req, res) => forward(res, "player", `/sessions/${enc(req.params.id)}`));
app.patch("/api/sessions/:id", (req, res) => forward(res, "player", `/sessions/${enc(req.params.id)}`, { method: "PATCH", body: req.body }));
app.delete("/api/sessions/:id", (req, res) => forward(res, "player", `/sessions/${enc(req.params.id)}`, { method: "DELETE" }));

// ---------- gameplay events ----------
app.get("/api/sessions/:id/events", (req, res) => forward(res, "player", `/sessions/${enc(req.params.id)}/events`));
app.post("/api/sessions/:id/events", (req, res) => forward(res, "player", `/sessions/${enc(req.params.id)}/events`, { method: "POST", body: req.body }));

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => console.log(`API Gateway running at http://localhost:${PORT}`));
