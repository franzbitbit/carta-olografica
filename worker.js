// Holo deck — stylisation service (Cloudflare Worker in front of the Gemini API).
// Keeps the Gemini API key off the public page. Deploy, then set the secret:
//   npx wrangler secret put GEMINI_API_KEY
// and put the Worker URL in the page (localStorage 'holo.ai' or AI_ENDPOINT).

const MODEL = 'gemini-3.1-flash-image';
const ALLOWED_ORIGINS = ['https://franzbitbit.github.io'];
const KEEP = ' Keep the same person, face, expression, pose, framing and composition exactly; do not add text, borders or logos. Portrait orientation.';
const STYLES = {
  painted: 'Repaint this photo as a rich digital oil painting for a premium collectible trading card: visible brush strokes, dramatic rim light, vivid colour.' + KEEP,
  anime: 'Redraw this photo as a high-quality anime illustration: clean line art, cel shading, luminous eyes, soft gradient sky.' + KEEP,
  comic: 'Redraw this photo as a bold comic-book illustration: inked outlines, halftone shading, punchy flat colours.' + KEEP,
  neon: 'Restyle this photo as a futuristic neon illustration: glowing magenta and cyan rim lights, dark background, cinematic.' + KEEP,
  clay: 'Turn this photo into a cute 3D clay figurine render with soft studio lighting and a simple pastel background.' + KEEP
};
const MAX_B64 = 8 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, 'Content-Type': 'application/json'}});
    if (req.method === 'OPTIONS') return new Response(null, {headers: cors});
    if (req.method !== 'POST') return json({error: 'Not found'}, 404);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({error: 'Origin not allowed'}, 403);

    let body;
    try { body = await req.json(); } catch { return json({error: 'Bad JSON'}, 400); }
    const {style, mime, data} = body || {};
    const prompt = STYLES[style];
    if (!prompt || typeof data !== 'string' || data.length > MAX_B64 || !/^image\/(jpeg|png|webp)$/.test(mime || '')) return json({error: 'Bad request'}, 400);

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY},
      body: JSON.stringify({
        contents: [{parts: [{text: prompt}, {inlineData: {mimeType: mime, data}}]}],
        generationConfig: {responseModalities: ['TEXT', 'IMAGE']}
      })
    });
    const j = await r.json().catch(() => ({}));
    const part = j?.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
    const img = part && (part.inlineData || part.inline_data);
    if (!r.ok || !img) return json({error: j?.error?.message || 'No image returned'}, 502);
    return json({mime: img.mimeType || img.mime_type || 'image/png', data: img.data});
  }
};
