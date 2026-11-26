// Holo deck API — Cloudflare Worker + D1.
// Decks protected by name + 4-digit PIN; images stored as BLOBs in D1; Gemini re-poses + stylises photos, proxied with a secret key.
//   Bindings: DB (D1 "holo-deck").  Secret: GEMINI_API_KEY (optional; enables Gemini re-pose + styles).

const ORIGINS = ['https://franzbitbit.github.io', 'http://localhost:8765'];
const MODEL = 'gemini-3.1-flash-image';
const KINDS = ['src', 'img', 'bg', 'dm', 'thumb'];
const MAX_BLOB = 1900000;          // D1 row limit is ~2 MB
const MAX_CARDS = 200;
const BASE = 'Recreate this exact person as a medium shot (from the waist up), facing the camera in a natural, relaxed, neutral posture, centred, with a little empty space above the head. Keep their identity, face, hairstyle, the same facial expression, their clothing and any props or accessories they hold or wear. Plain, empty, very dark background with a soft rim light separating the subject. Portrait orientation. No text, logos, emblems, borders or frames. Style: ';
const PROMPTS = {
  realistic: BASE + 'photorealistic and polished, like a high-end editorial portrait: natural skin texture, professional studio lighting, crisp detail, subtle colour grading.',
  ghibli: BASE + 'hand-painted 2D animated-film look in the tradition of classic Japanese animation studios: soft painterly shading, gentle warm light, clean expressive line work, watercolour textures.',
  wizard: BASE + 'enchanted fantasy portrait with a magical wizarding-school mood: warm candlelit glow, floating golden sparks, subtle magical atmosphere, rich painterly detail.',
  tech: BASE + 'cool digital-tech look: sleek cyber aesthetic, cyan and violet rim lighting, subtle holographic interface glints and fine circuit-like light lines around the edges, crisp high-contrast finish.'
};

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256'}, key, 256));
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function gemini(env, prompt, mime, data) {
  const call = cfg => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY},
    body: JSON.stringify({contents: [{parts: [{text: prompt}, {inlineData: {mimeType: mime, data}}]}], generationConfig: cfg})
  });
  let r = await call({responseModalities: ['TEXT', 'IMAGE'], imageConfig: {aspectRatio: '3:4'}});
  if (r.status === 400) r = await call({responseModalities: ['TEXT', 'IMAGE']});
  const j = await r.json().catch(() => ({}));
  const part = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
  const img = part && (part.inlineData || part.inline_data);
  if (!r.ok || !img) throw new Error(j?.error?.message || 'No image returned');
  return {mime: img.mimeType || img.mime_type || 'image/png', data: img.data};
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400', 'Vary': 'Origin'
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, 'Content-Type': 'application/json'}});
    if (req.method === 'OPTIONS') return new Response(null, {headers: cors});
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (path === '/api/status') return json({ok: true, ai: !!env.GEMINI_API_KEY});

      if (path === '/api/login' && req.method === 'POST') {
        const {name, pin} = await req.json().catch(() => ({}));
        const display = String(name || '').trim().replace(/\s+/g, ' ');
        if (!display || display.length > 24) return json({error: 'Inserisci un nome (max 24 caratteri).'}, 400);
        if (!/^\d{4}$/.test(String(pin || ''))) return json({error: 'Il PIN deve avere 4 cifre.'}, 400);
        const key = display.toLowerCase(), now = Date.now();
        let u = await env.DB.prepare('SELECT * FROM users WHERE name_key = ?').bind(key).first();
        let created = false;
        if (!u) {
          const salt = rand(16);
          await env.DB.prepare('INSERT INTO users (name_key, display, pin_hash, salt, created) VALUES (?, ?, ?, ?, ?)').bind(key, display, await hashPin(pin, salt), salt, now).run();
          u = {name_key: key, display}; created = true;
        } else {
          if (u.locked_until > now) return json({error: `Troppi PIN errati. Riprova tra ${Math.ceil((u.locked_until - now) / 60000)} min.`}, 429);
          if (!safeEqual(await hashPin(pin, u.salt), u.pin_hash)) {
            const fails = u.fails + 1, lock = fails >= 5;
            await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE name_key = ?').bind(lock ? 0 : fails, lock ? now + 15 * 60000 : 0, key).run();
            return json({error: lock ? 'Troppi PIN errati. Bloccato per 15 minuti.' : `PIN errato per questo nome (${5 - fails} tentativi rimasti).`}, 401);
          }
          if (u.fails) await env.DB.prepare('UPDATE users SET fails = 0 WHERE name_key = ?').bind(key).run();
        }
        const token = rand(32);
        await env.DB.prepare('INSERT INTO sessions (token, name_key, created) VALUES (?, ?, ?)').bind(token, key, now).run();
        return json({token, name: u.display, created});
      }

      // ---- everything below needs a session ----
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const s = token && await env.DB.prepare('SELECT name_key FROM sessions WHERE token = ?').bind(token).first();
      if (!s) return json({error: 'Accedi di nuovo.'}, 401);
      const me = s.name_key;

      if (path === '/api/logout' && req.method === 'POST') { await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run(); return json({ok: true}); }

      if (path === '/api/cards' && req.method === 'GET') {
        const {results} = await env.DB.prepare('SELECT id, meta, created, updated FROM cards WHERE owner = ? ORDER BY created').bind(me).all();
        return json({cards: results.map(r => ({id: r.id, meta: JSON.parse(r.meta), created: r.created, updated: r.updated}))});
      }

      const m = path.match(/^\/api\/cards\/([\w-]{8,64})(?:\/(\w+))?$/);
      if (m) {
        const [, id, kind] = m;
        const row = await env.DB.prepare('SELECT owner FROM cards WHERE id = ?').bind(id).first();
        if (row && row.owner !== me) return json({error: 'Questa carta non è tua.'}, 403);
        if (kind) {
          if (!KINDS.includes(kind) || req.method !== 'GET') return json({error: 'Not found'}, 404);
          const b = row && await env.DB.prepare('SELECT mime, data FROM blobs WHERE card_id = ? AND kind = ?').bind(id, kind).first();
          if (!b) return json({error: 'Not found'}, 404);
          return new Response(new Uint8Array(b.data), {headers: {...cors, 'Content-Type': b.mime, 'Cache-Control': 'private, max-age=86400'}});
        }
        if (req.method === 'PUT') {
          const form = await req.formData();
          let meta; try { meta = JSON.parse(form.get('meta') || '{}'); } catch { return json({error: 'Bad meta'}, 400); }
          const clean = {
            title: String(meta.title || '').slice(0, 24), desc: String(meta.desc || '').slice(0, 140),
            attacks: (Array.isArray(meta.attacks) ? meta.attacks : []).slice(0, 3).map(a => ({name: String(a.name || '').slice(0, 20), dmg: String(a.dmg || '').slice(0, 5), text: String(a.text || '').slice(0, 90)})),
            color: /^(#[0-9a-f]{6}|[a-z]{3,10})$/i.test(meta.color || '') ? meta.color : 'violet',
            pattern: /^[a-z]{3,10}$/.test(meta.pattern || '') ? meta.pattern : 'stars',
            style: /^[a-z]{3,10}$/.test(meta.style || '') ? meta.style : 'original'
          };
          const now = Date.now(), stmts = [];
          if (!row) {
            const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM cards WHERE owner = ?').bind(me).first();
            if (n.n >= MAX_CARDS) return json({error: 'Il mazzo è pieno.'}, 400);
            stmts.push(env.DB.prepare('INSERT INTO cards (id, owner, meta, created, updated) VALUES (?, ?, ?, ?, ?)').bind(id, me, JSON.stringify(clean), Number(meta.created) || now, now));
          } else stmts.push(env.DB.prepare('UPDATE cards SET meta = ?, updated = ? WHERE id = ?').bind(JSON.stringify(clean), now, id));
          for (const k of KINDS) {
            const f = form.get(k);
            if (!f || typeof f === 'string') continue;
            if (f.size > MAX_BLOB) return json({error: `Immagine "${k}" troppo grande.`}, 413);
            if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return json({error: `Formato immagine "${k}" non supportato.`}, 400);
            stmts.push(env.DB.prepare('INSERT OR REPLACE INTO blobs (card_id, kind, mime, data) VALUES (?, ?, ?, ?)').bind(id, k, f.type, await f.arrayBuffer()));
          }
          await env.DB.batch(stmts);
          return json({ok: true, id, updated: now});
        }
        if (req.method === 'DELETE') {
          if (!row) return json({ok: true});
          await env.DB.batch([env.DB.prepare('DELETE FROM blobs WHERE card_id = ?').bind(id), env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(id)]);
          return json({ok: true});
        }
      }

      if (path === '/api/stylize' && req.method === 'POST') {
        if (!env.GEMINI_API_KEY) return json({error: 'Servizio AI non configurato.'}, 503);
        const {style, mime, data} = await req.json().catch(() => ({}));
        const prompt = Object.hasOwn(PROMPTS, style) ? PROMPTS[style] : null;
        if (!prompt || typeof data !== 'string' || data.length > 8e6 || !/^image\/(jpeg|png|webp)$/.test(mime || '')) return json({error: 'Bad request'}, 400);
        return json(await gemini(env, prompt, mime, data));
      }
      return json({error: 'Not found'}, 404);
    } catch (e) {
      return json({error: e.message || 'Server error'}, 500);
    }
  }
};
