#!/usr/bin/env node
/**
 * Magic-link request construction.
 *
 * This exists because both front ends had the same bug and it was invisible:
 * the redirect was passed in the request BODY as options.email_redirect_to,
 * which is the supabase-js client shape. The REST endpoint ignores it, falls
 * back to the project's Site URL, and reports nothing. The email arrives, the
 * link works, and it goes somewhere else.
 *
 * Zero real logins had ever completed as a result, which nobody noticed because
 * DEV_AUTH was creating accounts locally the whole time.
 */
const assert = require('assert');
const { otpUrl, otpError } = require('../src/authlink');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('the redirect goes in the query string');

it('redirect_to is a query parameter, not a body field', () => {
  const u = otpUrl('https://p.supabase.co', 'https://commish-web.onrender.com/admin/');
  assert.ok(u.includes('?redirect_to='), 'redirect_to must be in the query string');
});

it('the redirect is percent encoded so the path survives', () => {
  // Unencoded, the /admin/ path and the scheme's own slashes get read as part
  // of the OTP URL rather than as a value.
  const u = otpUrl('https://p.supabase.co', 'https://commish-web.onrender.com/admin/');
  assert.ok(u.endsWith('https%3A%2F%2Fcommish-web.onrender.com%2Fadmin%2F'));
});

it('a trailing slash on the project URL does not double up', () => {
  assert.ok(otpUrl('https://p.supabase.co/', 'x').startsWith('https://p.supabase.co/auth/v1/otp?'));
});

it('the two front ends ask for different destinations', () => {
  const app = otpUrl('https://p.supabase.co', 'https://h/app/');
  const ops = otpUrl('https://p.supabase.co', 'https://h/admin/');
  assert.notStrictEqual(app, ops, 'both pages must not land in the same place');
});

it('a missing project URL throws rather than building a broken request', () => {
  assert.throws(() => otpUrl('', 'https://h/app/'), /supabaseUrl is required/);
});

it('no redirect at all is still a valid endpoint', () => {
  assert.strictEqual(otpUrl('https://p.supabase.co'), 'https://p.supabase.co/auth/v1/otp');
});

console.log('\nfailures say what to do about them');

it('a rate limit is named as a rate limit, not a generic failure', () => {
  // The old handler collapsed this into "Could not send the link", which reads
  // as a broken app. Rate limiting is normal on the built-in SMTP and the only
  // correct response is to wait.
  const m = otpError(429, '{"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}');
  assert.match(m, /wait/i);
});

it('the rate limit is caught by code even when the status is not 429', () => {
  assert.match(otpError(400, '{"error_code":"over_email_send_rate_limit"}'), /wait/i);
});

it('a rejected redirect points at the setting that fixes it', () => {
  assert.match(otpError(400, 'invalid redirect_to url'), /URL Configuration/);
});

it('a non-json body does not throw the error handler', () => {
  assert.strictEqual(typeof otpError(500, '<html>bad gateway</html>'), 'string');
});

it('an unknown failure still returns something printable', () => {
  assert.strictEqual(otpError(418, null), 'Could not send the link.');
});

console.log(`\n${pass} passing`);
