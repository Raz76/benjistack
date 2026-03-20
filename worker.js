// UrbanVoice.AI — Cloudflare Worker (DiscoverTool)
const ANTHROPIC_API_KEY = 'My Api key'; // ← paste your Anthropic key here
const SERPER_API_KEY    = 'My Api key'; // ← paste your Serper key here
const UV_SECRET         = 'My Secret key'; // ← shared secret (must match api.js)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, X-Owner-Token',
};

// ── Rate limiting helpers ─────────────────────────────────────────
const rateToday = () => new Date().toISOString().slice(0, 10);

async function getRateRecord(kv, ip) {
  try {
    const raw = await kv.get(`ip:${ip}`);
    if (!raw) return { count: 0, date: rateToday(), confirmed: false };
    const rec = JSON.parse(raw);
    if (rec.date !== rateToday()) return { count: 0, date: rateToday(), confirmed: rec.confirmed || false };
    return rec;
  } catch { return { count: 0, date: rateToday(), confirmed: false }; }
}

async function setRateRecord(kv, ip, rec) {
  await kv.put(`ip:${ip}`, JSON.stringify(rec), { expirationTtl: 172800 }); // 2-day TTL
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
// ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const clientIp = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const ownerToken = env.OWNER_TOKEN || '';
    const isOwner  = ownerToken && request.headers.get('X-Owner-Token') === ownerToken;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Auth check helper (used by existing routes) ───────────────
    const clientKey = request.headers.get('x-api-key');
    const authorized = clientKey === UV_SECRET;

    // ── GET /rate-check ───────────────────────────────────────────
    if (url.pathname === '/rate-check' && request.method === 'GET') {
      if (!authorized) return json({ error: 'Unauthorized' }, 401);
      if (isOwner) return json({ count: 0, confirmed: true, limit: 999 });
      const rec   = await getRateRecord(env.UV_RATE, clientIp);
      const limit = rec.confirmed ? 3 : 1;
      return json({ count: rec.count, confirmed: rec.confirmed, limit });
    }

    // ── POST /journey-start ───────────────────────────────────────
    if (url.pathname === '/journey-start' && request.method === 'POST') {
      if (!authorized) return json({ error: 'Unauthorized' }, 401);
      if (isOwner) return json({ ok: true });
      const rec   = await getRateRecord(env.UV_RATE, clientIp);
      const limit = rec.confirmed ? 3 : 1;
      if (rec.count >= limit) {
        return json(
          { error: 'Rate limited', reason: rec.confirmed ? 'daily_limit' : 'unconfirmed' },
          429
        );
      }
      rec.count++;
      await setRateRecord(env.UV_RATE, clientIp, rec);
      return json({ ok: true, remaining: limit - rec.count });
    }

    // ── POST /confirm ─────────────────────────────────────────────
    if (url.pathname === '/confirm' && request.method === 'POST') {
      if (!authorized) return json({ error: 'Unauthorized' }, 401);
      const rec = await getRateRecord(env.UV_RATE, clientIp);
      rec.confirmed = true;
      await setRateRecord(env.UV_RATE, clientIp, rec);
      return json({ ok: true });
    }

    // ── GET /test ─────────────────────────────────────────────────
    if (url.pathname === '/test') {
      const query = url.searchParams.get('q') || 'dog anxiety';
      const data  = await searchSerper(query);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── GET /search ───────────────────────────────────────────────
    if (url.pathname === '/search' && request.method === 'GET') {
      if (!authorized) return json({ error: 'Unauthorized' }, 401);
      const query = url.searchParams.get('q') || '';
      if (!query) return json({ error: 'No query provided' }, 400);
      const data = await searchSerper(query);
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── POST / — Claude proxy ─────────────────────────────────────
    if (request.method === 'POST') {
      if (!authorized) return json({ error: 'Unauthorized' }, 401);
      try {
        const body     = await request.json();
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return new Response('UrbanVoice DiscoverTool Proxy — OK', {
      headers: { ...CORS, 'Content-Type': 'text/plain' },
    });
  },
};

async function searchSerper(query) {
  try {
    const [redditRes, quoraRes, generalRes] = await Promise.all([
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `site:reddit.com ${query} problem OR complaint OR frustrated OR "anyone else" OR help`,
          num: 10,
        }),
      }),
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `site:quora.com ${query} problem OR issue OR struggle`,
          num: 5,
        }),
      }),
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: `${query} complaints OR problems OR frustrating OR "wish there was" OR "nobody helps"`,
          num: 5,
        }),
      }),
    ]);

    const [redditData, quoraData, generalData] = await Promise.all([
      redditRes.json(),
      quoraRes.json(),
      generalRes.json(),
    ]);

    const reddit = (redditData.organic || []).map(r => ({
      source: 'Reddit', title: r.title, snippet: r.snippet, url: r.link,
    }));

    const quora = (quoraData.organic || []).map(r => ({
      source: 'Quora', title: r.title, snippet: r.snippet, url: r.link,
    }));

    const general = (generalData.organic || []).map(r => ({
      source: r.link?.includes('amazon')     ? 'Amazon Reviews'
            : r.link?.includes('trustpilot') ? 'Trustpilot'
            : r.link?.includes('g2.com')     ? 'G2'
            : r.link?.includes('youtube')    ? 'YouTube'
            : 'Forum',
      title: r.title, snippet: r.snippet, url: r.link,
    }));

    return {
      success: true,
      query,
      discussionCounts: {
        reddit:  parseInt((redditData.searchInformation?.totalResults  || '0').replace(/,/g, '')),
        quora:   parseInt((quoraData.searchInformation?.totalResults   || '0').replace(/,/g, '')),
        general: parseInt((generalData.searchInformation?.totalResults || '0').replace(/,/g, '')),
      },
      counts: {
        reddit: reddit.length, quora: quora.length, general: general.length,
        total: reddit.length + quora.length + general.length,
      },
      results: { reddit, quora, general },
    };

  } catch (err) {
    return { success: false, error: err.message, results: {} };
  }
}
