// Lead & Support Engine API — Cloudflare Worker + D1.
// Rebuild of the Muse fullstack app `lead-support-engine` as an independent
// app. Auth: single shared password (APP_PASSWORD Worker secret) -> HMAC
// session cookie `lse_session`, 30 days. Every /api/* route except
// /api/health, /api/login and /api/me requires a valid session (401 else).
//
// CONTACT PROVIDER IS A STUB (spec §6.4): reveal() returns what the seed
// record already holds, counts once, logs the reveal, costs $0. No real
// contact-data API key exists and none is fetched or invented here.
// Reveals are counted, not deliverability-verified.

const STATUSES = ["discovered", "scored", "contact_revealed", "staged",
  "approved", "sent", "replied", "fit_call", "won", "supported",
  "disqualified", "closed", "suppressed"];
const TERMINAL = new Set(["disqualified", "closed", "suppressed"]);
const BUDGET_CAP_CENTS = 5000; // $50/mo, from the snapshot

const ALLOWED_ORIGINS = new Set([
  "https://leads.dvaughnhouse.com",
  "https://lead-support-engine.pages.dev",
  "http://localhost:8787",
  "http://localhost:8000",
]);

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64url = (s) => atob(s.replaceAll("-", "+").replaceAll("_", "/"));

async function hmacSig(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function makeToken(secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    exp: Date.now() + 30 * 864e5, r: crypto.randomUUID(),
  })));
  return `${payload}.${await hmacSig(payload, secret)}`;
}

async function verifyToken(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expect = await hmacSig(payload, secret);
  if (sig.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const data = JSON.parse(unb64url(payload));
    return data.exp > Date.now();
  } catch { return false; }
}

function timingSafeStrEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sessionCookie(token) {
  return `lse_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}
const clearSessionCookie =
  "lse_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

async function authorized(req, env) {
  const secret = env.APP_PASSWORD;
  if (!secret) return false;
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)lse_session=([^;]+)/);
  if (m && m[1]) return verifyToken(m[1], secret);
  return false;
}

// --- D1 helpers (one JSON document per row) ---
async function allRows(db, table) {
  const r = await db.prepare(`SELECT data FROM ${table} ORDER BY id`).all();
  return r.results.map((x) => JSON.parse(x.data));
}
async function getRow(db, table, id) {
  const r = await db.prepare(`SELECT data FROM ${table} WHERE id = ?`).bind(id).first();
  return r ? JSON.parse(r.data) : null;
}
async function nextId(db, table) {
  const r = await db.prepare(`SELECT MAX(id) AS m FROM ${table}`).first();
  return (r && r.m ? r.m : 0) + 1;
}
async function insertRow(db, table, doc) {
  await db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
    .bind(doc.id, JSON.stringify(doc)).run();
  return doc;
}
async function updateRow(db, table, doc) {
  await db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`)
    .bind(JSON.stringify(doc), doc.id).run();
  return doc;
}
async function getSetting(db, key) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  } catch { return null; }
}
async function setSetting(db, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value).run();
}

async function readBody(req) {
  try {
    const data = await req.json();
    return typeof data === "object" && data !== null ? data : null;
  } catch { return null; }
}

// --- KB grounding: keyword match with stopwords removed. A page counts
// as grounding only on >=2 distinct matched words, or 1 matched word of
// >=6 letters (a distinctive term like "founding"). This stops a lone
// stopword ("for", "the") from falsely grounding an unrelated question.
const KB_STOPWORDS = new Set(("a an the and or of to in on for with from at by is are was were be been " +
  "what how why when where which who whom whose this that these those it its as do does did can could " +
  "should would will shall may might i you he she we they me him her us them my your his our their " +
  "not no yes if then than so such very much more most per").split(" "));
function kbLookup(pages, query) {
  const words = [...new Set(String(query || "").toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !KB_STOPWORDS.has(w)))];
  const scored = pages.map((p) => {
    const text = (p.title + " " + p.content).toLowerCase();
    const matched = words.filter((w) => text.includes(w));
    const grounded = matched.length >= 2 ||
      (matched.length === 1 && matched[0].length >= 6);
    return { page: p, matched, grounded };
  }).filter((s) => s.grounded).sort((a, b) => b.matched.length - a.matched.length);
  return { words, scored };
}

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s || "").trim().toLowerCase();

// --- Fit scoring: transparent rule-based rubric (no LLM wired here).
// Never invents details: every point cites a field actually in the record.
// Staff size, location, and daily/weekly frequency are NOT in the seed
// records, so every seed lead carries that -20 until confirmed on a call.
function rubricScore(lead) {
  let score = 50;
  const parts = ["Base 50."];
  if (lead.workflowTask) { score += 10; parts.push("+10: a repeatable workflow task is named (" + lead.workflowTask + ")."); }
  if (lead.email) { score += 5; parts.push("+5: email on file."); }
  if (lead.phone) { score += 5; parts.push("+5: phone on file."); }
  score -= 20;
  parts.push("-20: staff size, Cincinnati location, and daily/weekly task frequency are not stated in the record — ICP fit unconfirmed.");
  score = Math.max(0, Math.min(100, score));
  return { score, reason: parts.join(" ") };
}

// --- Stub contact provider (spec §6.4) ---
// Returns the contact already held in the seed record. Counts only when an
// email OR a phone is revealed; dedupes on already-revealed leads (free);
// costs $0; every reveal is logged.
function stubReveal(lead) {
  const hasEmail = !!lead.email;
  const hasPhone = !!lead.phone;
  if (!hasEmail && !hasPhone) return { result: "no_match", person: null };
  return {
    result: hasEmail && hasPhone ? "email_and_phone"
      : hasEmail ? "email_only" : "phone_only",
    person: {
      business: lead.business, email: lead.email || null,
      phone: lead.phone || null, emailVerified: false, source: "stub: Oct 27 verified seed list",
    },
  };
}

function stageCounts(leads) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const l of leads) if (counts[l.status] !== undefined) counts[l.status]++;
  return STATUSES.map((status) => ({ status, count: counts[status] }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);
    const withCors = (res) => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const db = env.LSE_DB;

    // Public: health
    if (path === "/api/health" && req.method === "GET")
      return withCors(json({ ok: true, service: "lead-support-engine-api", provider: "stub" }));

    // Public: login
    if (path === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !timingSafeStrEq(String(body.password || ""), env.APP_PASSWORD || "")) {
        return withCors(json({ ok: false, error: "wrong password" }, 401));
      }
      const token = await makeToken(env.APP_PASSWORD);
      return withCors(json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) }));
    }
    if (path === "/api/logout" && req.method === "POST")
      return withCors(json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie }));
    if (path === "/api/me" && req.method === "GET")
      return withCors(json({ ok: true, authed: await authorized(req, env) }));

    // Everything else requires auth
    if (!(await authorized(req, env)))
      return withCors(json({ ok: false, error: "unauthorized" }, 401));

    // --- Overview (same shape as the Muse snapshot's getOverview) ---
    if (path === "/api/overview" && req.method === "GET") {
      const leads = await allRows(db, "leads");
      const reveals = await allRows(db, "reveals");
      const kbPages = await allRows(db, "kb_pages");
      const dnc = await allRows(db, "dnc");
      const monthSpendCents = reveals.reduce((s, r) => s + (r.costCents || 0), 0);
      const icpRaw = await getSetting(db, "icp");
      return withCors(json({
        ok: true, seeded: true, provider: "stub",
        budgetCapCents: BUDGET_CAP_CENTS, monthSpendCents,
        countedReveals: reveals.length,
        stageCounts: stageCounts(leads),
        leads, kbPages, dnc, reveals,
        icp: icpRaw ? JSON.parse(icpRaw) : null,
      }));
    }

    // --- Settings (ICP text, budget cap display) ---
    if (path === "/api/settings" && req.method === "GET") {
      const icpRaw = await getSetting(db, "icp");
      return withCors(json({
        ok: true, provider: "stub", budgetCapCents: BUDGET_CAP_CENTS,
        icp: icpRaw ? JSON.parse(icpRaw) : null,
        note: "Contact provider is a stub (spec §6.4): reveals are counted, $0, not deliverability-verified. No real contact-data API key is held.",
      }));
    }
    if (path === "/api/settings" && req.method === "PATCH") {
      const body = await readBody(req);
      if (!body) return withCors(json({ ok: false, error: "bad json" }, 400));
      if (body.icp !== undefined) await setSetting(db, "icp", JSON.stringify(body.icp));
      return withCors(json({ ok: true }));
    }

    // --- Reveal log ---
    if (path === "/api/reveals" && req.method === "GET")
      return withCors(json(await allRows(db, "reveals")));

    // --- Approvals queue: staged leads + decision records ---
    if (path === "/api/approvals" && req.method === "GET") {
      const leads = await allRows(db, "leads");
      const decisions = await allRows(db, "approvals");
      return withCors(json({
        queue: leads.filter((l) => l.status === "staged"),
        approved: leads.filter((l) => ["approved", "sent"].includes(l.status)),
        decisions,
      }));
    }

    // --- Leads ---
    if (path === "/api/leads" && req.method === "GET")
      return withCors(json(await allRows(db, "leads")));

    if (path === "/api/leads" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !body.business) return withCors(json({ ok: false, error: "business is required" }, 400));
      const dncList = await allRows(db, "dnc");
      if (dncList.some((d) => norm(d.name) === norm(body.business)))
        return withCors(json({ ok: false, error: "business is on the do-not-contact list" }, 409));
      const id = await nextId(db, "leads");
      const doc = {
        id, business: body.business, vertical: body.vertical || null,
        workflowTask: body.workflowTask || null, phone: body.phone || null,
        email: body.email || null, emailVerified: false,
        source: body.source || "manual entry", signal: body.signal || null,
        status: "discovered", fitScore: null, fitReason: null,
        contactRevealed: false, isAlternate: !!body.isAlternate,
        notes: body.notes || null, replyCategory: null, replySummary: null,
        replyText: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      await insertRow(db, "leads", doc);
      return withCors(json(doc, 201));
    }

    const leadMatch = path.match(/^\/api\/leads\/(\d+)(?:\/([a-z-]+))?$/);
    if (leadMatch) {
      const leadId = Number(leadMatch[1]);
      const action = leadMatch[2] || null;
      const lead = await getRow(db, "leads", leadId);
      if (!lead) return withCors(json({ ok: false, error: "lead not found" }, 404));
      const touch = (patch) => updateRow(db, "leads", { ...lead, ...patch, updatedAt: nowIso() });

      if (req.method === "GET" && !action) return withCors(json(lead));

      if (req.method === "PATCH" && !action) {
        const body = await readBody(req);
        if (!body) return withCors(json({ ok: false, error: "bad json" }, 400));
        const allowed = ["business", "vertical", "workflowTask", "phone", "email",
          "source", "signal", "status", "notes", "isAlternate", "fitCallAt",
          "fitScore", "fitReason"];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        if (patch.status && !STATUSES.includes(patch.status))
          return withCors(json({ ok: false, error: "bad status" }, 400));
        return withCors(json(await touch(patch)));
      }

      if (req.method === "DELETE" && !action) {
        await db.prepare("DELETE FROM leads WHERE id = ?").bind(leadId).run();
        return withCors(json({ ok: true, id: leadId }));
      }

      // POST /api/leads/:id/score — idempotent: a scored lead keeps its score.
      if (req.method === "POST" && action === "score") {
        if (lead.fitScore !== null && lead.fitScore !== undefined)
          return withCors(json({ ...lead, alreadyScored: true }));
        const { score, reason } = rubricScore(lead);
        return withCors(json(await touch({
          fitScore: score, fitReason: reason,
          status: lead.status === "discovered" ? "scored" : lead.status,
        })));
      }

      // POST /api/leads/:id/reveal — STUB provider (§6.4).
      if (req.method === "POST" && action === "reveal") {
        const dncList = await allRows(db, "dnc");
        if (dncList.some((d) => norm(d.name) === norm(lead.business)))
          return withCors(json({ ok: false, error: "do-not-contact" }, 409));
        if (lead.contactRevealed) {
          return withCors(json({ ...lead, deduped: true, counted: false,
            note: "Already revealed — dedupe: no count, no charge (spec §6.2)." }));
        }
        const reveals = await allRows(db, "reveals");
        const monthSpend = reveals.reduce((s, r) => s + (r.costCents || 0), 0);
        if (monthSpend >= BUDGET_CAP_CENTS)
          return withCors(json({ ok: false, error: "monthly budget cap reached ($50)" }, 402));
        const out = stubReveal(lead);
        if (out.result === "no_match")
          return withCors(json({ ok: true, result: "no_match", counted: false,
            note: "Stub found no email or phone — counts as nothing, costs nothing." }));
        const rid = await nextId(db, "reveals");
        await insertRow(db, "reveals", {
          id: rid, leadId: lead.id, leadBusiness: lead.business,
          provider: "stub", result: out.result, costCents: 0, createdAt: nowIso(),
        });
        return withCors(json(await touch({ contactRevealed: true, status: "contact_revealed" })));
      }

      // POST /api/leads/:id/stage — draft the first touch (teaser + email),
      // staged, never sent. Copy uses only record fields — no invented stats.
      if (req.method === "POST" && action === "stage") {
        const task = lead.workflowTask || "a task your team repeats";
        const teaser = `Today: ${task}. With a build: the routine runs, with 2 human checks built in — one week, one workflow, one working system.`;
        const email = `Hi — I work with Cincinnati service teams on one repeated workflow at a time. ` +
          `For ${lead.business}, that could be ${task}. The First Build is one week, one workflow, ` +
          `one working system, with a human check built in — $126/hour, $75/hour founding rate for the first 3 clients. ` +
          `Open to a 20-minute fit call Thursday or Friday afternoon?`;
        return withCors(json(await touch({
          status: "staged", firstTouchTeaser: teaser, firstMessage: email,
        })));
      }

      // POST /api/leads/:id/approve {decision: approved|rejected, editedCopy?}
      if (req.method === "POST" && action === "approve") {
        const body = await readBody(req);
        if (!body || !["approved", "rejected"].includes(body.decision))
          return withCors(json({ ok: false, error: "decision must be approved or rejected" }, 400));
        if (lead.status !== "staged")
          return withCors(json({ ok: false, error: "only staged leads can be decided" }, 409));
        const aid = await nextId(db, "approvals");
        await insertRow(db, "approvals", {
          id: aid, leadId: lead.id, leadBusiness: lead.business,
          decision: body.decision,
          message: body.editedCopy || lead.firstMessage || null,
          at: nowIso(),
        });
        const updated = await touch({
          status: body.decision === "approved" ? "approved" : "contact_revealed",
          ...(body.editedCopy ? { firstMessage: String(body.editedCopy).slice(0, 2000) } : {}),
        });
        return withCors(json(updated));
      }

      // POST /api/leads/:id/send — approved → sent. Manual marker only:
      // no real sending is wired (Postal domain not held). Approval-first.
      if (req.method === "POST" && action === "send") {
        if (lead.status !== "approved")
          return withCors(json({ ok: false, error: "only approved leads can be sent" }, 409));
        return withCors(json(await touch({ status: "sent", sentAt: nowIso() })));
      }

      // POST /api/leads/:id/reply {replyText, replyCategory} — a reply at
      // any step stops the sequence and moves the lead toward a fit call.
      if (req.method === "POST" && action === "reply") {
        const body = await readBody(req);
        if (!body || !body.replyText) return withCors(json({ ok: false, error: "replyText is required" }, 400));
        return withCors(json(await touch({
          status: "replied", replyText: body.replyText,
          replyCategory: body.replyCategory || "unclassified",
          replySummary: String(body.replyText).slice(0, 200),
          sequenceStopped: true,
        })));
      }

      // POST /api/leads/:id/fit-call {fitCallAt?} / /win
      if (req.method === "POST" && action === "fit-call") {
        const body = (await readBody(req)) || {};
        return withCors(json(await touch({ status: "fit_call", fitCallAt: body.fitCallAt || null })));
      }
      if (req.method === "POST" && action === "win")
        return withCors(json(await touch({ status: "won" })));
      if (req.method === "POST" && action === "support")
        return withCors(json(await touch({ status: "supported" })));

      return withCors(json({ ok: false, error: "not found" }, 404));
    }

    // --- Knowledge base ---
    if (path === "/api/kb" && req.method === "GET")
      return withCors(json(await allRows(db, "kb_pages")));
    if (path === "/api/kb" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !body.title || !body.content)
        return withCors(json({ ok: false, error: "title and content are required" }, 400));
      const id = await nextId(db, "kb_pages");
      return withCors(json(await insertRow(db, "kb_pages", {
        id, title: body.title, content: body.content,
        url: body.url || null, createdAt: nowIso(),
      }), 201));
    }
    const kbMatch = path.match(/^\/api\/kb\/(\d+)$/);
    if (kbMatch) {
      const id = Number(kbMatch[1]);
      if (req.method === "PATCH") {
        const page = await getRow(db, "kb_pages", id);
        if (!page) return withCors(json({ ok: false, error: "not found" }, 404));
        const body = await readBody(req) || {};
        return withCors(json(await updateRow(db, "kb_pages", {
          ...page, title: body.title ?? page.title,
          content: body.content ?? page.content, url: body.url ?? page.url,
        })));
      }
      if (req.method === "DELETE") {
        await db.prepare("DELETE FROM kb_pages WHERE id = ?").bind(id).run();
        return withCors(json({ ok: true, id }));
      }
    }
    // POST /api/kb/lookup — grounded lookup: answers ONLY from KB pages.
    if (path === "/api/kb/lookup" && req.method === "POST") {
      const body = await readBody(req);
      const q = String((body && body.query) || "").trim();
      if (!q) return withCors(json({ ok: false, error: "query is required" }, 400));
      const pages = await allRows(db, "kb_pages");
      const { scored } = kbLookup(pages, q);
      if (!scored.length) {
        const uid = await nextId(db, "unanswered");
        await insertRow(db, "unanswered", { id: uid, question: q, createdAt: nowIso(), answered: false });
        return withCors(json({
          ok: true, grounded: false, matches: [],
          answer: "Not covered by the knowledge base. The question was added to the unanswered list for a human to answer once — the answer then joins the knowledge base.",
        }));
      }
      const top = scored[0].page;
      return withCors(json({
        ok: true, grounded: true,
        matches: scored.map((s) => ({ id: s.page.id, title: s.page.title, hits: s.matched.length })),
        answer: `From "${top.title}": ${top.content}`,
        sourceTitle: top.title,
      }));
    }
    if (path === "/api/unanswered" && req.method === "GET")
      return withCors(json(await allRows(db, "unanswered")));

    // --- Support chats ---
    if (path === "/api/chats" && req.method === "GET")
      return withCors(json(await allRows(db, "chats")));
    if (path === "/api/chats" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !body.visitor) return withCors(json({ ok: false, error: "visitor is required" }, 400));
      const id = await nextId(db, "chats");
      return withCors(json(await insertRow(db, "chats", {
        id, visitor: body.visitor, business: body.business || null,
        status: "open", messages: [], handoff: null,
        createdAt: nowIso(), updatedAt: nowIso(),
      }), 201));
    }
    const chatMatch = path.match(/^\/api\/chats\/(\d+)(?:\/([a-z-]+))?$/);
    if (chatMatch) {
      const chatId = Number(chatMatch[1]);
      const action = chatMatch[2] || null;
      const chat = await getRow(db, "chats", chatId);
      if (!chat) return withCors(json({ ok: false, error: "chat not found" }, 404));
      if (req.method === "GET" && !action) return withCors(json(chat));
      if (req.method === "DELETE" && !action) {
        await db.prepare("DELETE FROM chats WHERE id = ?").bind(chatId).run();
        return withCors(json({ ok: true, id: chatId }));
      }
      // POST /api/chats/:id/message {from: visitor|agent|human, text}
      // Agent replies are KB-grounded: if the lookup finds nothing, the
      // agent says so instead of inventing an answer.
      if (req.method === "POST" && action === "message") {
        const body = await readBody(req);
        if (!body || !body.text) return withCors(json({ ok: false, error: "text is required" }, 400));
        const from = body.from === "human" ? "human" : body.from === "agent" ? "agent" : "visitor";
        const msgs = [...(chat.messages || []), { from, text: body.text, at: nowIso() }];
        let agentReply = null;
        if (from === "visitor") {
          const pages = await allRows(db, "kb_pages");
          const { scored } = kbLookup(pages, body.text);
          const hit = scored[0] || null;
          const wantsPerson = /human|person|someone|billing|refund|charge/i.test(body.text);
          if (wantsPerson) {
            agentReply = "I'll flag this for a human — billing and person requests always go to a human. A recap is on its way and someone will take over this conversation.";
            msgs.push({ from: "agent", text: agentReply, at: nowIso(), handoff: true });
            await updateRow(db, "chats", { ...chat, messages: msgs, status: "needs_human",
              handoff: { reason: wantsPerson ? "person/billing request" : "agent unsure", at: nowIso() }, updatedAt: nowIso() });
            return withCors(json({ chat: await getRow(db, "chats", chatId), agentReply }));
          }
          agentReply = hit
            ? `From "${hit.page.title}": ${hit.page.content}`
            : "I don't know from the knowledge base — I've added your question to the list for a human to answer once, and the answer will join the knowledge base.";
          msgs.push({ from: "agent", text: agentReply, at: nowIso(), grounded: !!hit });
          if (!hit) {
            const uid = await nextId(db, "unanswered");
            await insertRow(db, "unanswered", { id: uid, question: body.text, createdAt: nowIso(), answered: false });
          }
        }
        const updated = await updateRow(db, "chats", { ...chat, messages: msgs, updatedAt: nowIso() });
        return withCors(json({ chat: updated, agentReply }));
      }
      // POST /api/chats/:id/handoff {reason} — one-click human takeover.
      if (req.method === "POST" && action === "handoff") {
        const body = (await readBody(req)) || {};
        const updated = await updateRow(db, "chats", {
          ...chat, status: "needs_human",
          handoff: { reason: body.reason || "human requested", at: nowIso() },
          updatedAt: nowIso(),
        });
        return withCors(json(updated));
      }
      // POST /api/chats/:id/capture — buying interest → lead on the shared record.
      if (req.method === "POST" && action === "capture") {
        const body = (await readBody(req)) || {};
        const id = await nextId(db, "leads");
        const doc = {
          id, business: chat.business || body.business || chat.visitor,
          vertical: body.vertical || null, workflowTask: body.workflowTask || null,
          phone: body.phone || null, email: body.email || null, emailVerified: false,
          source: "support chat #" + chat.id, signal: "inbound buying interest",
          status: "discovered", fitScore: null, fitReason: null,
          contactRevealed: false, isAlternate: false, notes: null,
          replyCategory: null, replySummary: null, replyText: null,
          createdAt: nowIso(), updatedAt: nowIso(),
        };
        await insertRow(db, "leads", doc);
        await updateRow(db, "chats", { ...chat, leadId: id, updatedAt: nowIso() });
        return withCors(json(doc, 201));
      }
      return withCors(json({ ok: false, error: "not found" }, 404));
    }

    // --- Do-not-contact (absolute; never shared with other engines) ---
    if (path === "/api/dnc" && req.method === "GET")
      return withCors(json(await allRows(db, "dnc")));
    if (path === "/api/dnc" && req.method === "POST") {
      const body = await readBody(req);
      if (!body || !body.name) return withCors(json({ ok: false, error: "name is required" }, 400));
      const id = await nextId(db, "dnc");
      return withCors(json(await insertRow(db, "dnc", {
        id, name: body.name, reason: body.reason || null, createdAt: nowIso(),
      }), 201));
    }
    const dncMatch = path.match(/^\/api\/dnc\/(\d+)$/);
    if (dncMatch && req.method === "DELETE") {
      await db.prepare("DELETE FROM dnc WHERE id = ?").bind(Number(dncMatch[1])).run();
      return withCors(json({ ok: true, id: Number(dncMatch[1]) }));
    }

    return withCors(json({ ok: false, error: "not found" }, 404));
  },
};
