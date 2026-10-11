// صُرة — خادم الذكاء الاصطناعي (بدون أي مكتبات خارجية) — يحتاج Node.js 18 أو أحدث
// يشغّل التطبيق ويوصل فلوسي AI وقراءة الفواتير بـ Claude API، ومفتاحك يبقى في الخادم فقط.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// تحميل ملف .env
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* لا يوجد .env، نعتمد على متغيرات البيئة */ }

const KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-5';
const FAST_MODEL = process.env.FAST_MODEL || 'claude-haiku-4-5-20251001';
const TOKEN = process.env.APP_TOKEN || '';
const ORIGIN = process.env.ALLOWED_ORIGIN || '';
const RATE = Number(process.env.RATE_PER_MIN) || 30;
const API = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
const INDEX = path.join(__dirname, 'index.html');

if (!KEY) {
  console.error('✗ ضع ANTHROPIC_API_KEY في ملف .env (انسخ .env.example إلى .env)');
  process.exit(1);
}

const hits = new Map();
function limited(ip) {
  const t = Date.now();
  const a = (hits.get(ip) || []).filter(x => t - x < 60000);
  a.push(t);
  hits.set(ip, a);
  return a.length > RATE;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some(x => t - x < 60000)) hits.delete(k); }, 60000).unref();

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function fail(code, msg) { return Object.assign(new Error(msg), { status: code }); }
function readBody(req, max) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > max) { bad(fail(413, 'حجم الطلب كبير')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { bad(fail(400, 'صيغة الطلب غير صحيحة')); } });
    req.on('error', bad);
  });
}
function cleanMessages(m) {
  if (!Array.isArray(m) || !m.length) throw fail(400, 'messages مطلوبة');
  const out = m.slice(-12).map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, 60000) }));
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') throw fail(400, 'آخر رسالة لازم تكون من المستخدم');
  return out;
}
const SYSTEM = 'أنت «فلوسي AI» داخل تطبيق «صُرة» لإدارة الأموال الشخصية. التزم بالتعليمات الموجودة في أول رسالة من المستخدم.';
function anthropic(payload) {
  return fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  });
}
async function providerError(r) {
  let detail = '';
  try { detail = (await r.json()).error?.message || ''; } catch (_) {}
  console.error('Claude API error', r.status, detail);
  return fail(502, 'خطأ من مزوّد الذكاء الاصطناعي (' + r.status + ')');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-app-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }

    if (url.pathname.startsWith('/api/')) {
      if (TOKEN && req.headers['x-app-token'] !== TOKEN) return sendJSON(res, 401, { error: 'رمز الوصول غير صحيح' });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      if (limited(ip)) return sendJSON(res, 429, { error: 'طلبات كثيرة، انتظر دقيقة' });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, vision: true, model: MODEL });

    // محادثة فلوسي AI (نص متدفق)
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req, 400 * 1024);
      const r = await anthropic({ model: body.tier === 'quick' ? FAST_MODEL : MODEL, max_tokens: 2000, system: SYSTEM, messages: cleanMessages(body.messages), stream: true });
      if (!r.ok) throw await providerError(r);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(ev.delta.text);
            else if (ev.type === 'error') res.write('\u0000ERR:' + ((ev.error && ev.error.message) || 'error'));
          } catch (_) {}
        }
      }
      return res.end();
    }

    // بيانات منظّمة (فهم الجمل، قراءة الفواتير بالصور)
    if (req.method === 'POST' && url.pathname === '/api/json') {
      const body = await readBody(req, 12 * 1024 * 1024);
      const content = [];
      if (body.image && body.image.data) {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(body.image.media_type || '')) return sendJSON(res, 400, { error: 'نوع الصورة غير مدعوم' });
        content.push({ type: 'image', source: { type: 'base64', media_type: body.image.media_type, data: body.image.data } });
      }
      content.push({ type: 'text', text: String(body.prompt || '').slice(0, 60000) + '\n\nأعد JSON صالحًا فقط، بدون أي نص آخر وبدون علامات ```.' });
      const r = await anthropic({ model: body.tier === 'quick' && !body.image ? FAST_MODEL : MODEL, max_tokens: 1500, messages: [{ role: 'user', content }] });
      if (!r.ok) throw await providerError(r);
      const j = await r.json();
      const text = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('').replace(/```json|```/g, '').trim();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { const m = text.match(/[\[{][\s\S]*[\]}]/); try { data = m ? JSON.parse(m[0]) : null; } catch (_) {} }
      if (data == null) return sendJSON(res, 502, { error: 'تعذر فهم رد الذكاء الاصطناعي' });
      return sendJSON(res, 200, { data });
    }

    sendJSON(res, 404, { error: 'غير موجود' });
  } catch (e) {
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: e.status ? e.message : 'خطأ في الخادم' });
    else res.end('\u0000ERR:' + (e.message || 'error'));
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, () => console.log(`✓ صُرة تعمل على http://localhost:${PORT}  (النموذج: ${MODEL})`));
