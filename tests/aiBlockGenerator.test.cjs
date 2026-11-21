const assert = require('node:assert/strict');
const { test } = require('node:test');

test('AI block generator passes raw Groq text to the frontend', async t => {
  const { app } = await import('../backend/ai-agent-service/server.js');
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
    await new Promise(resolve => server.close(resolve));
  });

  const request = body => originalFetch(`http://127.0.0.1:${server.address().port}/aipromptblocksgenerator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const provider = (content, finish_reason = 'stop') => new Response(JSON.stringify({
    choices: [{ finish_reason, message: { content } }]
  }), { headers: { 'Content-Type': 'application/json' } });

  await t.test('returns coordinate text unchanged with no JSON wrapper or attachment', async () => {
    const raw = ' -1,1,0,16\r\n0,1,0,23\r\n0,1,0,14\n';
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /x,y,z,id/);
      assert.equal(body.messages[1].content, 'Build a castle');
      assert.equal(body.response_format, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      return provider(raw);
    };
    const response = await request({ prompt: ' Build a castle ' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal(await response.text(), raw);
  });

  await t.test('leaves output parsing and validation to the frontend', async () => {
    const raw = '```text\n0,1,0,99\nmalformed row\n```';
    global.fetch = async () => provider(raw);
    const response = await request({ prompt: 'Build a castle' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), raw);
  });

  await t.test('invalid requests and missing configuration never call the provider', async () => {
    global.fetch = async () => { throw new Error('Provider must not be called'); };
    for (const body of [{}, { prompt: ' ' }, { prompt: 42 }, { prompt: 'x'.repeat(5001) }]) {
      assert.equal((await request(body)).status, 400);
    }
    delete process.env.GROQ_API_KEY;
    assert.equal((await request({ prompt: 'castle' })).status, 503);
    process.env.GROQ_API_KEY = 'test-key';
  });

  await t.test('reports empty or truncated responses and provider failures', async () => {
    for (const content of ['', '  ', null, 42]) {
      global.fetch = async () => provider(content);
      assert.equal((await request({ prompt: 'castle' })).status, 502);
    }
    global.fetch = async () => provider('0,1,0,16\n1,', 'length');
    assert.equal((await request({ prompt: 'castle' })).status, 502);
    global.fetch = async () => new Response('{}', { status: 429 });
    assert.equal((await request({ prompt: 'castle' })).status, 502);
    global.fetch = async () => { throw new DOMException('Timed out', 'TimeoutError'); };
    assert.equal((await request({ prompt: 'castle' })).status, 502);
  });
});
