/**
 * Where batshit-server reaches the Batshit app (BL-562): `BATSHIT_FRONTEND_URL`, the variable every
 * launcher sets (the Mac app's runtime env, the native source launcher, the Pinokio lane, and Compose's
 * `http://app:3000` for this service), without a trailing slash.
 *
 * Unset, it refuses with an error that names the variable. It used to fall back to
 * `http://localhost:5620`, the Mac app, so a lane that did not set it sent its calls, with its own
 * token, to another Batshit.
 */
function resolveBatshitAppUrl(env = process.env) {
  const configured = typeof env.BATSHIT_FRONTEND_URL === 'string' ? env.BATSHIT_FRONTEND_URL.trim() : '';
  if (!configured) {
    throw new Error(
      "BATSHIT_FRONTEND_URL is not set, so batshit-server does not know where this Batshit app is. " +
        "Set it to the app's address (for example http://127.0.0.1:5621) in the environment that starts batshit-server."
    );
  }
  return configured.replace(/\/+$/, '');
}

module.exports = { resolveBatshitAppUrl };
