import express from "express";
import { pathToFileURL } from "node:url";

export const app = express();
const PORT = process.env.PORT || 4004;

app.use(express.json({ limit: "32kb" }));

// The gateway can use this to check whether the service is running.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ai-agent-service"
  });
});

// Match the gateway's current local development key.
const SERVICE_API_KEY =
  process.env.SERVICE_API_KEY || "tcss460-secret";

app.post("/insights", async (req, res) => {
  if (req.get("x-api-key") !== SERVICE_API_KEY) {
    return res.status(401).json({
      error: "Missing or invalid API key."
    });
  }

  const stats = req.body?.stats;
  const fields = [
    "totalSessions",
    "totalPlaytimeMinutes",
    "blocksPlaced",
    "blocksBroken"
  ];

  if (
    !stats ||
    !fields.every(
      field => Number.isSafeInteger(stats[field]) && stats[field] >= 0
    )
  ) {
    return res.status(400).json({
      error: "stats must contain nonnegative integers for totalSessions, totalPlaytimeMinutes, blocksPlaced, and blocksBroken."
    });
  }

  const mode = process.env.AI_MODE || "mock";

  if (mode !== "mock" && mode !== "groq") {
    return res.status(500).json({
      error: "AI_MODE must be mock or groq."
    });
  }

  if (mode === "groq") {
    if (!process.env.GROQ_API_KEY?.trim()) {
      return res.status(503).json({
        error: "AI service is not configured."
      });
    }

    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
            messages: [
              {
                role: "system",
                content:
                  "Summarize the supplied gameplay statistics in two " +
                  "short sentences. Do not invent facts."
              },
              {
                role: "user",
                content: JSON.stringify(
                  Object.fromEntries(
                    fields.map(field => [field, stats[field]])
                  )
                )
              }
            ],
            max_completion_tokens: 1024
          }),
          signal: AbortSignal.timeout(30000)
        }
      );

      if (!response.ok) {
        console.error("Groq HTTP status:", response.status);
        return res.status(502).json({
          error: "AI provider could not complete the request."
        });
      }

      const data = await response.json();
      const summary = data.choices?.[0]?.message?.content;

      if (typeof summary !== "string" || !summary.trim()) {
        return res.status(502).json({
          error: "AI provider returned an empty summary."
        });
      }

      return res.json({
        mode: "groq",
        summary: summary.trim()
      });
    } catch (error) {
      console.error("Groq request failed:", error.name);
      return res.status(502).json({
        error: "AI provider is temporarily unavailable."
      });
    }
  }

  return res.json({
    mode: "mock",
    summary:
      `You completed ${stats.totalSessions} sessions with ` +
      `${stats.totalPlaytimeMinutes} minutes of total playtime. ` +
      `You placed ${stats.blocksPlaced} blocks and broke ` +
      `${stats.blocksBroken} blocks.`
  });
});

// POST { prompt: "Generate a castle" }
// Return Groq's text unchanged; the frontend parses and uses the coordinates.
app.post("/aipromptblocksgenerator", async (req, res) => {
  const prompt = req.body?.prompt;

  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 5000) {
    return res.status(400).json({ error: "prompt must be a nonempty string of at most 5000 characters." });
  }
  if (!process.env.GROQ_API_KEY?.trim()) {
    return res.status(503).json({ error: "AI service is not configured." });
  }

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
          messages: [
            {
              role: "system",
              content: `You design voxel structures for BlockTogether.
Return only raw text containing one block per line in the format x,y,z,id.
List every block individually using integer coordinates and IDs. Do not include
a header, markdown, explanations, JSON, code, ranges, ellipses, or placeholders.
Allowed block IDs: 0 air block, 4 Red, 5 Orange, 6 Yellow, 7 Lime, 8 Green, 9 Cyan,
10 Sky Blue, 11 Blue, 12 Purple, 13 Pink, 14 White, 15 Light Gray,
16 Gray, 17 Black, 18 Brown, 19 Tan, 20 Navy, 21 Teal, 22 Magenta, 23 Glass.
Use only these IDs and list each coordinate once. Leave empty spaces by omitting
blocks. Unless requested otherwise, center the structure near x=0,z=0 with its
base at y=1 (ground level is y=0). Make a recognizable, detailed structure matching
the user's request, using hundreds of blocks when appropriate. Keep the design
small enough to list every block completely within your response budget.`
            },
            {
              role: "user",
              content: prompt.trim()
            }
          ],
          max_completion_tokens: 8192
        }),
        signal: AbortSignal.timeout(60000)
      }
    );

    if (!response.ok) {
      console.error("Groq HTTP status:", response.status);
      return res.status(502).json({
        error: "AI provider could not complete the request."
      });
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;

    if (choice?.finish_reason !== "stop" || typeof content !== "string" || !content.trim()) {
      return res.status(502).json({
        error: "AI provider returned empty or incomplete block data. Please try again."
      });
    }

    return res.type("text/plain").send(content);
  } catch (error) {
    console.error("Groq request failed:", error.name);
    return res.status(502).json({
      error: "AI provider is temporarily unavailable."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "Request body is not valid JSON."
    });
  }

  console.error(err.message);
  res.status(500).json({ error: "Unexpected server error." });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    console.log(`AI Agent Service running at http://localhost:${PORT}`);
  });
}
