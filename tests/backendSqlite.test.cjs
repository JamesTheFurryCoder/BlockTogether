const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('SQLite gameplay persists across restarts while authentication stays in JSON', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blocktogether-sqlite-'));
  const backend = path.resolve(__dirname, '../backend');
  let server;
  let sqlite;
  try {
    fs.mkdirSync(path.join(directory, 'SqlDatabase'));
    fs.mkdirSync(path.join(directory, 'data'));
    for (const file of ['server.js', 'SqlDatabase/createDB.js']) {
      fs.copyFileSync(path.join(backend, file), path.join(directory, file));
    }
    const seed = JSON.stringify({ user: { username: 'demo_player', userId: 1 }, blocks: [], sessions: [], events: [] });
    fs.writeFileSync(path.join(directory, 'data/db.json'), seed);
    fs.writeFileSync(path.join(directory, 'data/logindata.json'), JSON.stringify({ James: { password: '123' } }));
    fs.symlinkSync(path.join(backend, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    const serverPath = path.join(directory, 'server.js');
    const start = async () => {
      const loaded = require(serverPath);
      sqlite = loaded.sqlite;
      server = loaded.app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
    };
    let demoUsername;
    const request = async (route, method = 'GET', body) => {
      if (demoUsername && !route.includes('?') && /^\/api\/(sessions|events|worlds)/.test(route)) {
        route += `?username=${encodeURIComponent(demoUsername)}`;
      }
      if (method !== 'GET' && /^\/api\/(sessions|events|worlds)/.test(route)) {
        const url = new URL(route, 'http://localhost');
        if (url.searchParams.has('username')) body = { ...body, username: url.searchParams.get('username') };
        route = url.pathname;
      }
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    await start();
    assert.equal((await request('/api/login', 'POST', { username: 'James', password: '123' })).status, 200);
    const paddedLogin = await request('/api/login', 'POST', { username: ' James ', password: '123' });
    assert.equal(paddedLogin.status, 200);
    assert.equal(paddedLogin.body.user.username, 'James');
    assert.equal((await request('/api/login', 'POST', { username: 'james', password: '123' })).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'James', password: '123 ' })).status, 401);
    demoUsername = sqlite.prepare('SELECT username FROM user_statistics ORDER BY userId LIMIT 1').get().username;
    const before = (await request('/api/users/me/stats')).body;
    const session = (await request('/api/sessions', 'POST', {})).body;
    assert.equal((await request('/api/events', 'POST', {
      sessionId: session.sessionId, events: [{ type: 'entity_kill', x: 1, y: 2, z: 3 }]
    })).status, 201);
    assert.equal((await request('/api/events', 'POST', {
      sessionId: session.sessionId, events: [{ type: 'invalid', x: 1, y: 2, z: 3 }]
    })).status, 400);
    const endedAt = new Date(Date.parse(session.startedAt) + 65 * 60000).toISOString();
    assert.equal((await request(`/api/sessions/${session.sessionId}`, 'PATCH', { endedAt })).body.durationMinutes, 65);
    assert.equal((await request(`/api/sessions/${session.sessionId}`, 'PATCH', {})).status, 409);
    const block = { x: 9876, y: 4, z: -3, blockId: 2 };
    assert.equal((await request('/api/worlds/me/blocks', 'POST', { blocks: [block] })).status, 201);
    const after = (await request('/api/users/me/stats')).body;
    assert.equal(after.totalSessions, before.totalSessions + 1);
    assert.equal(after.totalPlaytimeMinutes, before.totalPlaytimeMinutes + 65);
    assert.equal(after.entityKills, before.entityKills + 1);
    assert.equal(after.breakReminder, true);
    const row = sqlite.prepare('SELECT * FROM user_statistics').get();
    assert.equal(row.entityKills, after.entityKills);
    assert.equal(row.blocksInWorld, after.blocksInWorld);
    const credentials = { username: 'sqlite_test', password: 'test-password' };
    assert.equal((await request('/api/register', 'POST', { ...credentials, username: ' sqlite_test ' })).status, 201);
    const newUser = sqlite.prepare('SELECT * FROM user_statistics WHERE username = ?').get(credentials.username);
    assert.ok(newUser.userId > row.userId);
    for (const field of ['totalSessions', 'totalPlaytimeMinutes', 'averageSessionMinutes', 'blocksInWorld', 'blocksPlaced', 'blocksBroken', 'entityKills']) {
      assert.equal(newUser[field], 0);
    }
    for (const field of ['blocks', 'sessions', 'events']) assert.deepEqual(JSON.parse(newUser[field]), []);
    const blankStats = await request('/api/users/me/stats?username=sqlite_test');
    assert.equal(blankStats.status, 200);
    for (const field of ['totalSessions', 'totalPlaytimeMinutes', 'averageSessionMinutes', 'blocksInWorld', 'blocksPlaced', 'blocksBroken', 'entityKills']) {
      assert.equal(blankStats.body[field], 0);
    }
    assert.equal(blankStats.body.breakReminder, false);
    assert.deepEqual((await request(`/api/users/me/stats?username=${encodeURIComponent(row.username)}`)).body, after);
    assert.equal((await request('/api/users/me/stats?username=missing_user')).status, 404);
    assert.equal((await request('/api/users/me/stats?username=')).status, 400);
    assert.equal((await request('/api/users/me/stats?username=a&username=b')).status, 400);
    const isolated = '?username=sqlite_test';
    const ownSession = (await request('/api/sessions' + isolated, 'POST', {})).body;
    assert.equal(ownSession.userId, newUser.userId);
    assert.equal((await request('/api/events' + isolated, 'POST', {
      sessionId: ownSession.sessionId + 100, events: [{ type: 'entity_kill', x: 0, y: 0, z: 0 }]
    })).status, 404);
    assert.equal((await request('/api/events' + isolated, 'POST', {
      sessionId: ownSession.sessionId, events: [{ type: 'block_placed', x: 2, y: 2, z: 2 }]
    })).status, 201);
    assert.equal((await request('/api/worlds/me/blocks' + isolated, 'POST', { blocks: [block] })).status, 201);
    assert.equal((await request(`/api/sessions/${ownSession.sessionId}` + isolated, 'PATCH', {
      endedAt: new Date(Date.parse(ownSession.startedAt) + 60000).toISOString()
    })).status, 200);
    const ownStats = (await request('/api/users/me/stats' + isolated)).body;
    assert.equal(ownStats.blocksPlaced, 1);
    assert.equal(ownStats.totalSessions, 1);
    assert.equal(ownStats.totalPlaytimeMinutes, 1);
    assert.equal(ownStats.blocksInWorld, 1);
    assert.deepEqual((await request('/api/users/me/stats')).body, after);
    const savedUser = sqlite.prepare('SELECT * FROM user_statistics WHERE username = ?').get(credentials.username);
    assert.equal((await request('/api/sessions?username=', 'POST', {})).status, 400);
    assert.equal((await request('/api/sessions?other=value', 'POST', {})).status, 400);
    assert.equal((await request('/api/worlds/me/blocks?username=missing')).status, 404);
    assert.equal((await request('/api/register', 'POST', credentials)).status, 409);
    assert.deepEqual(sqlite.prepare('SELECT * FROM user_statistics WHERE username = ?').get(credentials.username), savedUser);
    assert.equal((await request('/api/login', 'POST', credentials)).status, 200);
    assert.equal((await request('/api/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'data/logindata.json'))), {
      James: { password: '123' },
      sqlite_test: { password: 'test-password' }
    });
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 1);
    assert.equal(fs.readFileSync(path.join(directory, 'data/db.json'), 'utf8'), seed);
    await new Promise(resolve => server.close(resolve));
    server = null;
    sqlite.close();
    sqlite = null;
    // A migrated database must work without the original JSON seed.
    fs.unlinkSync(path.join(directory, 'data/db.json'));
    delete require.cache[require.resolve(serverPath)];
    await start();
    assert.deepEqual((await request('/api/users/me/stats')).body, after);
    assert.deepEqual(sqlite.prepare('SELECT * FROM user_statistics WHERE username = ?').get(credentials.username), savedUser);
    assert.ok((await request('/api/worlds/me/blocks')).body.blocks.some(b => b.x === block.x));
    assert.equal((await request('/api/worlds/me/blocks', 'POST', { blocks: [{ ...block, blockId: 0 }] })).status, 201);
    assert.equal((await request('/api/worlds/me/blocks')).body.blocks.find(b => b.x === block.x).blockId, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (sqlite?.open) sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
