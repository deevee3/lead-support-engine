// Lead & Support Engine SPA — calls the Worker API with credentials
// (HttpOnly session cookie). All reads/writes 401 without a session.
const API = window.LSE_API_BASE;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

let overview = null;
let currentTab = "pipeline";

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}
function showApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

async function refresh() {
  overview = await api("/api/overview");
  renderAll();
}

function money(cents) { return "$" + (cents / 100).toFixed(2); }

function renderAll() {
  const o = overview;
  $("#budget-badge").textContent =
    `Reveals ${o.countedReveals} · Spend ${money(o.monthSpendCents)} / ${money(o.budgetCapCents)} cap · stub`;
  $("#approval-count").textContent =
    o.leads.filter((l) => l.status === "staged").length || "";
  renderPipeline(o);
  renderApprovals(o);
  renderSupport();
  renderSetup(o);
}

// ---------- Pipeline ----------
function renderPipeline(o) {
  const counts = $("#stage-counts");
  counts.innerHTML = o.stageCounts.map((s) =>
    `<span class="stage"><b>${s.count}</b>${esc(s.status)}</span>`).join("");
  const sel = $("#lead-status-filter");
  if (!sel.dataset.filled) {
    sel.dataset.filled = "1";
    o.stageCounts.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.status; opt.textContent = s.status;
      sel.appendChild(opt);
    });
  }
  const q = ($("#lead-search").value || "").toLowerCase();
  const status = sel.value;
  const altOnly = $("#lead-alt-only").checked;
  const list = o.leads.filter((l) => {
    if (status && l.status !== status) return false;
    if (altOnly && !l.isAlternate) return false;
    if (q && !((l.business + " " + (l.vertical || "") + " " + (l.workflowTask || "") + " " + (l.email || "")).toLowerCase().includes(q))) return false;
    return true;
  });
  $("#lead-list").innerHTML = list.map((l) => `
    <div class="lead" data-id="${l.id}">
      <div class="lead-head"><b>${esc(l.business)}</b>
        <span class="status ${esc(l.status)}">${esc(l.status)}${l.isAlternate ? " · alternate" : ""}</span></div>
      <div class="meta">${esc(l.vertical || "")} · ${esc(l.workflowTask || "")}</div>
      <div class="meta">${esc(l.phone || "no phone")} · ${esc(l.email || "no email")}${l.emailVerified ? " · verified" : " · unverified"} · ${esc(l.source || "")} · ${esc(l.signal || "")}</div>
      ${l.fitScore !== null && l.fitScore !== undefined
        ? `<div class="fit">Fit <b>${l.fitScore}/100</b> — ${esc(l.fitReason || "")}</div>` : ""}
      ${l.firstMessage ? `<pre class="msg">${esc(l.firstMessage)}</pre>` : ""}
      ${l.replyText ? `<div class="fit">Reply (${esc(l.replyCategory || "")}): ${esc(l.replySummary || l.replyText)}</div>` : ""}
      ${l.notes ? `<div class="meta">Notes: ${esc(l.notes)}</div>` : ""}
      <div class="actions">
        <button class="small" data-act="score" ${l.fitScore !== null && l.fitScore !== undefined ? "disabled" : ""}>Score</button>
        <button class="small" data-act="reveal" ${l.contactRevealed ? "disabled" : ""}>${l.contactRevealed ? "Revealed ✓" : "Reveal contact (stub)"}</button>
        <button class="small" data-act="stage" ${!["scored", "contact_revealed", "discovered"].includes(l.status) ? "disabled" : ""}>Stage first touch</button>
        <button class="small" data-act="fit-call" ${!["replied", "sent", "approved"].includes(l.status) ? "disabled" : ""}>Book fit call</button>
        <button class="small" data-act="win" ${l.status !== "fit_call" ? "disabled" : ""}>Mark won</button>
        <button class="small ghost" data-act="disqualify">Disqualify</button>
        <button class="small ghost" data-act="delete">Delete</button>
      </div>
    </div>`).join("") || `<p class="muted">No leads match.</p>`;
}

$("#lead-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = e.target.closest(".lead");
  const id = card.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "score") await api(`/api/leads/${id}/score`, { method: "POST", body: "{}" });
    else if (act === "reveal") {
      const r = await api(`/api/leads/${id}/reveal`, { method: "POST", body: "{}" });
      if (r.deduped) alert("Already revealed — dedupe: no count, no charge.");
      else if (r.result === "no_match") alert("Stub found no email or phone — counts as nothing.");
    }
    else if (act === "stage") await api(`/api/leads/${id}/stage`, { method: "POST", body: "{}" });
    else if (act === "fit-call") {
      const at = prompt("Fit call time (e.g. Thu 3:00 PM ET):", "Thu 3:00 PM ET");
      if (at === null) return;
      await api(`/api/leads/${id}/fit-call`, { method: "POST", body: JSON.stringify({ fitCallAt: at }) });
    }
    else if (act === "win") await api(`/api/leads/${id}/win`, { method: "POST", body: "{}" });
    else if (act === "disqualify") {
      const reason = prompt("Disqualify reason:");
      if (reason === null) return;
      await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ status: "disqualified", notes: reason }) });
    }
    else if (act === "delete") {
      if (!confirm("Delete this lead?")) return;
      await api(`/api/leads/${id}`, { method: "DELETE" });
    }
    await refresh();
  } catch (err) { alert(err.message); }
});

$("#lead-search").addEventListener("input", () => overview && renderPipeline(overview));
$("#lead-status-filter").addEventListener("change", () => overview && renderPipeline(overview));
$("#lead-alt-only").addEventListener("change", () => overview && renderPipeline(overview));
$("#add-lead-open").addEventListener("click", () => $("#add-lead-form").classList.toggle("hidden"));
$("#add-lead-cancel").addEventListener("click", () => $("#add-lead-form").classList.add("hidden"));
$("#add-lead-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/leads", { method: "POST", body: JSON.stringify({
      business: fd.get("business"), vertical: fd.get("vertical") || null,
      workflowTask: fd.get("workflowTask") || null, phone: fd.get("phone") || null,
      email: fd.get("email") || null, source: fd.get("source") || null,
      isAlternate: fd.get("isAlternate") === "on",
    }) });
    e.target.reset(); e.target.classList.add("hidden"); await refresh();
  } catch (err) { alert(err.message); }
});

// ---------- Approvals ----------
async function renderApprovals(o) {
  const data = await api("/api/approvals");
  $("#approval-queue").innerHTML = data.queue.map((l) => `
    <div class="card"><b>${esc(l.business)}</b> — ${esc(l.workflowTask || "")}
      <pre class="msg">${esc(l.firstMessage || "")}</pre>
      <div class="row">
        <button class="small" data-approve="${l.id}">Approve — send on my go</button>
        <button class="small ghost" data-reject="${l.id}">Reject</button>
      </div></div>`).join("") || `<p class="muted">Queue is empty.</p>`;
  $("#approval-decided").innerHTML = data.decisions.slice().reverse().map((d) => `
    <div class="card">${esc(d.decision)} — <b>${esc(d.leadBusiness)}</b> · ${esc(d.at)}</div>`).join("")
    || `<p class="muted">No decisions yet.</p>`;
  $("#approval-queue").querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/leads/${b.dataset.approve}/approve`, { method: "POST", body: JSON.stringify({ decision: "approved" }) }); await refresh(); }
    catch (err) { alert(err.message); }
  }));
  $("#approval-queue").querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/leads/${b.dataset.reject}/approve`, { method: "POST", body: JSON.stringify({ decision: "rejected" }) }); await refresh(); }
    catch (err) { alert(err.message); }
  }));
}

// ---------- Support ----------
async function renderSupport() {
  const pages = await api("/api/kb");
  $("#kb-list").innerHTML = pages.map((p) => `
    <div class="card"><b>${esc(p.title)}</b><div class="muted" style="font-size:.9rem">${esc(p.content)}</div>
    <button class="small ghost" data-kb-del="${p.id}">Delete</button></div>`).join("");
  $("#kb-list").querySelectorAll("[data-kb-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this KB page?")) return;
    await api(`/api/kb/${b.dataset.kbDel}`, { method: "DELETE" });
    await renderSupport();
  }));
  const un = await api("/api/unanswered");
  $("#unanswered-list").innerHTML = un.length
    ? un.map((u) => `<div>• ${esc(u.question)} <span class="muted">(${esc(u.createdAt)})</span></div>`).join("")
    : "None — every question so far was covered by the knowledge base.";
  const chats = await api("/api/chats");
  $("#chat-list").innerHTML = chats.map((c) => `
    <div class="card"><b>${esc(c.visitor)}</b> ${c.business ? `· ${esc(c.business)}` : ""} —
      <span class="status ${esc(c.status)}">${esc(c.status)}</span>
      ${c.handoff ? `<div class="muted">Handoff: ${esc(c.handoff.reason)}</div>` : ""}
      <div>${(c.messages || []).map((m) => `<div class="chat-msg"><b>${esc(m.from)}:</b> ${esc(m.text)}</div>`).join("")}</div>
      <form class="row chat-form" data-chat="${c.id}">
        <input name="text" placeholder="Message as visitor…" required>
        <button class="small" type="submit">Send</button>
        <button class="small ghost" type="button" data-handoff="${c.id}">Hand off to human</button>
        <button class="small ghost" type="button" data-capture="${c.id}">Capture as lead</button>
      </form></div>`).join("") || `<p class="muted">No chats yet.</p>`;
  document.querySelectorAll(".chat-form").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    await api(`/api/chats/${f.dataset.chat}/message`, { method: "POST", body: JSON.stringify({ from: "visitor", text: fd.get("text") }) });
    await renderSupport();
  }));
  document.querySelectorAll("[data-handoff]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/chats/${b.dataset.handoff}/handoff`, { method: "POST", body: JSON.stringify({ reason: "human requested from dashboard" }) });
    await renderSupport();
  }));
  document.querySelectorAll("[data-capture]").forEach((b) => b.addEventListener("click", async () => {
    try { await api(`/api/chats/${b.dataset.capture}/capture`, { method: "POST", body: "{}" }); await refresh(); }
    catch (err) { alert(err.message); }
  }));
}

$("#kb-lookup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#kb-query").value;
  try {
    const r = await api("/api/kb/lookup", { method: "POST", body: JSON.stringify({ query: q }) });
    const box = $("#kb-answer");
    box.classList.remove("hidden");
    box.innerHTML = `<b>${r.grounded ? "Grounded answer" : "Not in the knowledge base"}</b><p>${esc(r.answer)}</p>` +
      (r.matches && r.matches.length ? `<p class="muted">Matched: ${r.matches.map((m) => esc(m.title)).join(", ")}</p>` : "");
    await renderSupport();
  } catch (err) { alert(err.message); }
});

$("#kb-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/kb", { method: "POST", body: JSON.stringify({ title: fd.get("title"), content: fd.get("content") }) });
    e.target.reset(); await renderSupport();
  } catch (err) { alert(err.message); }
});

$("#new-chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/chats", { method: "POST", body: JSON.stringify({ visitor: $("#chat-visitor").value, business: $("#chat-business").value || null }) });
    e.target.reset(); await renderSupport();
  } catch (err) { alert(err.message); }
});

// ---------- Setup & Seam ----------
async function renderSetup(o) {
  const s = await api("/api/settings");
  $("#seam-info").innerHTML = `
    <p><b>Provider:</b> stub — returns the contact already held in the seed record.</p>
    <p><b>Counting:</b> a lead counts only when an email OR a phone is revealed. Same person twice is free (dedupe). No-match counts as nothing.</p>
    <p><b>Cost:</b> $0 per reveal. Reveals are counted, <b>not</b> deliverability-verified.</p>
    <p class="muted">No real contact-data API key is held. When one lands, only the provider behind this seam changes.</p>`;
  $("#budget-info").innerHTML = `
    <p><b>Monthly cap:</b> ${money(o.budgetCapCents)} — enforced in the seam, never silently overspent.</p>
    <p><b>Spent this month:</b> ${money(o.monthSpendCents)} · <b>Counted reveals:</b> ${o.countedReveals}</p>`;
  $("#reveal-log").innerHTML = (o.reveals || []).map((r) => `
    <div class="card">#${r.id} — <b>${esc(r.leadBusiness)}</b> · ${esc(r.provider)} · ${esc(r.result)} · ${money(r.costCents)} · ${esc(r.createdAt)}</div>`).join("")
    || `<p class="muted">No reveals logged.</p>`;
  $("#dnc-list").innerHTML = (o.dnc || []).map((d) => `
    <div class="card"><b>${esc(d.name)}</b> — ${esc(d.reason || "")}</div>`).join("");
  $("#icp-text").value = s.icp ? (typeof s.icp === "string" ? s.icp : JSON.stringify(s.icp, null, 2)) : "";
}

$("#dnc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/dnc", { method: "POST", body: JSON.stringify({ name: $("#dnc-name").value, reason: $("#dnc-reason").value || null }) });
    e.target.reset(); await refresh();
  } catch (err) { alert(err.message); }
});

$("#icp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", { method: "PATCH", body: JSON.stringify({ icp: $("#icp-text").value }) });
    alert("ICP saved.");
  } catch (err) { alert(err.message); }
});

// ---------- Tabs / auth ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  $("#tab-" + b.dataset.tab).classList.add("active");
  currentTab = b.dataset.tab;
}));

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.classList.add("hidden");
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) });
    $("#password").value = "";
    showApp();
    await refresh();
  } catch {
    err.textContent = "Wrong password.";
    err.classList.remove("hidden");
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin();
});

// Boot: check session without forcing the login form to flash an error.
(async () => {
  try {
    const me = await api("/api/me");
    if (me.authed) { showApp(); await refresh(); } else showLogin();
  } catch { showLogin(); }
})();
