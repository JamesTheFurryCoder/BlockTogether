# AI block generator

Set `GROQ_API_KEY` in this service's `.env`, then run `npm start` from this directory.
`GROQ_MODEL` optionally overrides the default `openai/gpt-oss-20b` model.
This endpoint always uses Groq, independently of the `/insights` endpoint's
`AI_MODE` setting.

POST `http://localhost:4004/aipromptblocksgenerator` with `Content-Type: application/json`:

```json
{ "prompt": "Generate a gray castle with four towers and blue roofs" }
```

A successful response has `Content-Type: text/plain; charset=utf-8`. Its body is
the raw text from Groq's message content, unchanged. The system prompt asks for
one block per line as `x,y,z,id`, without a header or explanations, for example:

```text
0,1,0,16
1,1,0,16
0,2,0,23
```

The backend does not parse, validate, expand, deduplicate, or reformat block data.
There is no JSON wrapper, block count, format option, or download attachment.
Frontend developers should read successful responses with `await response.text()`
and implement their own parsing, validation, downloads, and block placement.
The requested text format and palette IDs (4 through 23) are instructions to the
model, not guarantees enforced by the backend.

Ground level is y=0; the requested default structure base is y=1. Prompts may
contain up to 5,000 characters. Output size is limited by the model's response
budget of 8,192 tokens; there is no server-side expansion into larger designs.
Invalid requests return 400, a missing API key returns 503, and provider failures,
empty responses, or truncated output return 502. Errors have JSON bodies with an
`error` field. Provider requests time out after 60 seconds.

The player home sends requests to the main backend on port 3001, which forwards
`POST /aipromptblocksgenerator` to this service. Run both backends. The main
backend's optional `AI_AGENT_URL` overrides `http://localhost:4004`. Restart the
main backend after updating its routes. To configure this service in PowerShell:

```powershell
cd backend/ai-agent-service
Copy-Item .env.example .env
# Edit .env to set your GROQ_API_KEY, then:
npm.cmd start
```

Placing or saving the returned blocks is separate integration work; the current
player home logs the response in the browser console. For the existing world
save API, map parsed IDs to `blockId`
and send batches of at most 1,000 blocks.

Tests use a mocked provider: `node --test tests/aiBlockGenerator.test.cjs` from the
repository root. No API calls or credits are needed.
