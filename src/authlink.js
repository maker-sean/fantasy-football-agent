/**
 * Building the magic-link request.
 *
 * Pulled out of the two front ends because both got it wrong the same way, and
 * the failure was invisible: nothing errored, the email arrived, and the link
 * simply went somewhere else.
 *
 * The redirect must be a QUERY PARAMETER on /auth/v1/otp. Passing it in the
 * body as options.email_redirect_to is the supabase-js CLIENT shape; the client
 * translates it to ?redirect_to before it ever reaches the network. Send the
 * body form to the REST endpoint directly and it is silently ignored, and
 * Supabase falls back to the project's Site URL, which for us was still
 * http://localhost:3000 from early development.
 *
 * Two settings then have to agree, and neither reports when they do not:
 * the redirect has to be in the project's allowlist, or it is discarded and
 * Site URL is used instead. Same silent substitution either way.
 */

function otpUrl(supabaseUrl, redirectTo) {
  if (!supabaseUrl) throw new Error('supabaseUrl is required');
  const base = String(supabaseUrl).replace(/\/+$/, '') + '/auth/v1/otp';
  if (!redirectTo) return base;
  return `${base}?redirect_to=${encodeURIComponent(redirectTo)}`;
}

/**
 * A message a person can act on.
 *
 * The old handler collapsed every failure into "Could not send the link", which
 * hid a 429 behind what looked like a bug. Rate limiting is a NORMAL condition
 * on the built-in SMTP and the only correct response is to wait, so it has to
 * say so.
 */
function otpError(status, body) {
  let code = '';
  try { code = (typeof body === 'string' ? JSON.parse(body) : body || {}).error_code || ''; }
  catch { /* not json, fall through to status */ }

  if (status === 429 || code === 'over_email_send_rate_limit') {
    return 'Too many sign-in emails from this project. Supabase limits them per hour, so wait and try again.';
  }
  if (status === 400 && /redirect/i.test(String(body))) {
    return 'That redirect URL is not allowed for this project. Add it under Authentication, URL Configuration.';
  }
  if (status === 422) return 'That address was rejected. Check it and try again.';
  if (status >= 500) return 'Supabase is having trouble. Try again shortly.';
  return 'Could not send the link.';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { otpUrl, otpError };
