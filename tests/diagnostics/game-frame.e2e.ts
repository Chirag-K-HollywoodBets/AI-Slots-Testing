// Read-only: loads Games in Olympus and records the game's own network traffic
// while it starts up, to learn its protocol and bet levels. No clicks, no spins.
// Long values (tokens, ids) are redacted; only names and short values are printed.
 
import { test } from '@e2e-dev/web';
 
const GAME_URL = 'https://www.hollywoodbets.net/lobby/top-games/#/g/games-in-olympus';
// Everything except the site itself and known ad/analytics hosts.
const NOT_SITE = /^https?:\/\/(?!([a-z0-9-]+\.)*(hollywoodbets\.net|adsrvr\.org|innovid\.com|google|gstatic|doubleclick|facebook|kubico\.com|hotjar|clarity\.ms)\b)/i;
 
const redact = (v: string) => (v.length > 24 ? `<${v.length} chars>` : v);
 
function summariseBody(text: string) {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const top = Array.isArray(j) ? j[0] ?? {} : j;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(top ?? {}).slice(0, 40)) {
      out[k] = typeof v === 'object' ? (Array.isArray(v) ? `array(${v.length})` : 'object') : redact(String(v));
    }
    return { format: 'json', fields: out };
  } catch { /* not JSON */ }
  if (/^[\w.-]+=[^&]*(&[\w.-]+=[^&]*)+$/.test(t.slice(0, 2000))) {
    const p = new URLSearchParams(t);
    const out: Record<string, string> = {};
    [...p.keys()].slice(0, 60).forEach((k) => { out[k] = redact(p.get(k) ?? ''); });
    return { format: 'querystring', fields: out };
  }
  return { format: 'other', start: redact(t.slice(0, 60)), length: t.length };
}
 
test('record the game startup traffic', { session: 'hb-test', timeout: 180_000 }, async ({ app, browser }) => {
  const requests: { method: string; host: string; path: string; bodyKeys: string[] | null }[] = [];
 
  await browser.route(NOT_SITE, async (route) => {
    const u = new URL(route.request.url);
    const body = route.request.postData ?? '';
    requests.push({
      method: route.request.method,
      host: u.host,
      path: u.pathname.slice(0, 100),
      bodyKeys: body.includes('=') ? [...new URLSearchParams(body).keys()].slice(0, 30)
        : body.startsWith('{') ? (() => { try { return Object.keys(JSON.parse(body)).slice(0, 30); } catch { return null; } })()
        : null,
    });
    await route.continue();
  });
 
  await app.open('/');
  await new Promise((r) => setTimeout(r, 3000));
 
  const responses: unknown[] = [];
  let collecting = true;
  const collector = (async () => {
    while (collecting) {
      try {
        const res = await browser.waitForResponse(NOT_SITE, { timeout: 3000 });
        const type = res.headers['content-type'] ?? '';
        if (/json|text|x-www-form|javascript/.test(type) && !/javascript/.test(type)) {
          const u = new URL(res.url);
          responses.push({ status: res.status, host: u.host, path: u.pathname.slice(0, 100), type, body: summariseBody(await res.text()) });
        }
      } catch { /* no response in this window */ }
    }
  })();
 
  await browser.goto(GAME_URL);
  await new Promise((r) => setTimeout(r, 40000)); // let the game finish loading
  collecting = false;
  await collector;
 
  // Requests: unique method+host+path only.
  const seen = new Set<string>();
  const uniqueRequests = requests.filter((r) => {
    const k = `${r.method} ${r.host}${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
 
  console.log('GAME TRAFFIC DIAGNOSTIC:', JSON.stringify({ requests: uniqueRequests.slice(0, 60), responses: responses.slice(0, 30) }, null, 2));
});