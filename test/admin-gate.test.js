#!/usr/bin/env node
/**
 * The operator gate, end to end over HTTP.
 *
 * These routes read every league's private group chat across every tenant, so
 * the gate is the most consequential twelve lines in the web app. The failures
 * worth testing are the quiet ones:
 *
 *   - an unset ADMIN_EMAILS treated as "allow everyone", which turns a
 *     forgotten environment variable into an open door
 *   - a signed-in commissioner reaching operator data because the allowlist was
 *     checked in the UI rather than the API
 *   - the gate answering 403, which confirms the route exists and that this
 *     account is merely not on the list. That is a map for anyone probing.
 *
 * DEV_AUTH gives every request an account, which is exactly the condition these
 * cases need: authenticated, and still not an operator.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('operator gate\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}

process.env.DEV_AUTH = 'true';
process.env.DEV_AUTH_EMAIL = 'not-an-operator@example.invalid';
process.env.NODE_ENV = 'test';
// Set BEFORE the server is required: the allowlist is read once at module load,
// which is the point. Operator access should not be re-readable at runtime.
process.env.ADMIN_EMAILS = 'boss@example.invalid, MixedCase@Example.Invalid';

const assert = require('assert');
const { app } = require('../web/server');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const ROUTES = [
  ['GET',  '/api/admin/overview'],
  ['GET',  '/api/admin/leagues'],
  ['GET',  '/api/admin/drafts'],
  ['GET',  '/api/admin/leagues/00000000-0000-0000-0000-000000000000/thread'],
  ['POST', '/api/admin/flags/replies-paused'],
];

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) => fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  console.log('operator gate');

  await it('every operator route is closed to a signed-in non-operator', async () => {
    for (const [method, path] of ROUTES) {
      const r = await call(method, path, method === 'POST' ? { paused: true } : undefined);
      assert.strictEqual(r.status, 404, `${method} ${path} returned ${r.status}`);
    }
  });

  await it('it answers 404, not 403, so the route is not confirmed', async () => {
    // 403 tells a prober "this exists and you are simply not on the list".
    const r = await call('GET', '/api/admin/overview');
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await r.json()).error, 'not_found');
  });

  await it('the refusal happens before any work, so nothing leaks in the body', async () => {
    const body = await (await call('GET', '/api/admin/leagues')).text();
    for (const leak of ['league', 'chat_id', 'phone', 'sleeper']) {
      assert.ok(!body.toLowerCase().includes(leak), `response mentioned ${leak}`);
    }
  });

  await it('the write is refused and the flag is untouched', async () => {
    const flags = require('../src/flags');
    const before = (await flags.all()).find(f => f.key === 'replies_paused');
    const r = await call('POST', '/api/admin/flags/replies-paused', { paused: true });
    assert.strictEqual(r.status, 404);
    const after = (await flags.all()).find(f => f.key === 'replies_paused');
    assert.deepStrictEqual(after.value, before.value, 'a refused request changed the kill switch');
    assert.strictEqual(after.updated_by, before.updated_by);
  });

  await it('the static shell is public, because the data behind it is not', async () => {
    // Deliberate: gating the HTML would imply the HTML is the protection. The
    // check belongs on the API, which is what makes "view source" boring.
    const r = await call('GET', '/admin/');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    // Test for DATA, not for vocabulary. The page has a "Leagues" heading and
    // should: what must never be in it is a value. An earlier version of this
    // assertion matched the word and failed on the heading, which would have
    // pushed someone to rename a heading to satisfy a test.
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(html),
      'the shell contains something UUID shaped');
    assert.ok(!/\+?\d[\d ().-]{8,}\d/.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')),
      'the shell contains something phone shaped');
    assert.ok(!/"(chat_id|sender_phone|sleeper_league_id)"/.test(html),
      'the shell contains embedded record fields');
  });

  await it('commissioner routes still work for the same account', async () => {
    // The gate must narrow operator access without breaking the account's
    // ordinary rights, which is how a too-broad middleware would show up.
    const r = await call('GET', '/api/me');
    assert.strictEqual(r.status, 200);
  });

  console.log(`\n${pass} passing`);
  server.close();
  process.exit(process.exitCode || 0);
});
