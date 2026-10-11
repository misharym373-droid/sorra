// صُرة — Supabase Edge Function: "ai"
// يوصل فلوسي AI وقراءة الفواتير بـ Claude API، ومفتاح Anthropic يبقى سري داخل Supabase.
// يشتغل فقط للمستخدم المسجّل دخول (Supabase يتحقق من JWT تلقائيًا قبل ما يوصل الطلب هنا).
// المسارات: GET /health  ·  POST /api/chat (نص متدفق)  ·  POST /api/json (JSON، يدعم صورة)

const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("MODEL") ?? "claude-sonnet-5";
const FAST_MODEL = Deno.env.get("FAST_MODEL") ?? "claude-haiku-4-5-20251001";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const API = "https://api.anthropic.com/v1/messages";
const SYSTEM = "أنت «فلوسي AI» داخل تطبيق «صُرة» لإدارة الأموال الشخصية. التزم بالتعليمات الموجودة في أول رسالة من المستخدم.";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });

type Msg = { role: string; content: unknown };
function cleanMessages(m: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(m) || !m.length) throw new Error("messages مطلوبة");
  const out = (m as Msg[]).slice(-12).map((x) => ({
    role: x.role === "assistant" ? "assistant" as const : "user" as const,
    content: String(x.content ?? "").slice(0, 60000),
  }));
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") throw new Error("آخر رسالة لازم تكون من المستخدم");
  return out;
}
const anthropic = (payload: unknown) =>
  fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname;
  try {
    if (!KEY) return json(500, { error: "ANTHROPIC_API_KEY غير مضبوط في أسرار Supabase" });

    if (req.method === "GET" && path.endsWith("/health")) return json(200, { ok: true, vision: true, model: MODEL });

    if (req.method === "POST" && path.endsWith("/chat")) {
      const body = await req.json();
      const r = await anthropic({ model: body.tier === "quick" ? FAST_MODEL : MODEL, max_tokens: 2000, system: SYSTEM, messages: cleanMessages(body.messages), stream: true });
      if (!r.ok || !r.body) { console.error("Claude API", r.status); return json(502, { error: "خطأ من مزوّد الذكاء الاصطناعي (" + r.status + ")" }); }
      const reader = r.body.getReader(), dec = new TextDecoder(), enc = new TextEncoder();
      let buf = "";
      const stream = new ReadableStream({
        async pull(ctrl) {
          const { done, value } = await reader.read();
          if (done) { ctrl.close(); return; }
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") ctrl.enqueue(enc.encode(ev.delta.text));
              else if (ev.type === "error") ctrl.enqueue(enc.encode("\u0000ERR:" + (ev.error?.message ?? "error")));
            } catch (_) { /* سطر غير مكتمل */ }
          }
        },
        cancel() { reader.cancel(); },
      });
      return new Response(stream, { headers: { ...cors, "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (req.method === "POST" && path.endsWith("/json")) {
      const body = await req.json();
      const content: unknown[] = [];
      if (body.image?.data) {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(body.image.media_type ?? "")) return json(400, { error: "نوع الصورة غير مدعوم" });
        if (String(body.image.data).length > 10_000_000) return json(413, { error: "الصورة كبيرة" });
        content.push({ type: "image", source: { type: "base64", media_type: body.image.media_type, data: body.image.data } });
      }
      content.push({ type: "text", text: String(body.prompt ?? "").slice(0, 60000) + "\n\nأعد JSON صالحًا فقط، بدون أي نص آخر وبدون علامات ```." });
      const r = await anthropic({ model: body.tier === "quick" && !body.image ? FAST_MODEL : MODEL, max_tokens: 1500, messages: [{ role: "user", content }] });
      if (!r.ok) { console.error("Claude API", r.status); return json(502, { error: "خطأ من مزوّد الذكاء الاصطناعي (" + r.status + ")" }); }
      const j = await r.json();
      const text = (j.content ?? []).filter((x: { type: string }) => x.type === "text").map((x: { text: string }) => x.text).join("").replace(/```json|```/g, "").trim();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { const m = text.match(/[\[{][\s\S]*[\]}]/); try { data = m ? JSON.parse(m[0]) : null; } catch (_) { data = null; } }
      if (data == null) return json(502, { error: "تعذر فهم رد الذكاء الاصطناعي" });
      return json(200, { data });
    }
    return json(404, { error: "غير موجود" });
  } catch (e) {
    console.error("ai function", e instanceof Error ? e.message : String(e));
    return json(400, { error: e instanceof Error ? e.message : "طلب غير صالح" });
  }
});
