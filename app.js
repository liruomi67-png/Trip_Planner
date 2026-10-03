(() => {
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  raw(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let DATA, map, layer, dayId;
let state = store.get("paris.state") || { days: {}, checks: {} };
let pending = null; // "drop a pin" mode: { stopId?, name? }

// ---------- unlock ----------
async function deriveKey(pw, enc) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(enc.salt), iterations: enc.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
}
async function decrypt(key, enc) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  let enc;
  try { enc = await (await fetch("data.enc.json")).json(); }
  catch { showLock("Could not load the itinerary. Connect to the internet once to download it."); return; }

  const saved = store.raw("paris.key");
  if (saved) {
    try {
      const key = await crypto.subtle.importKey("raw", b64(saved), "AES-GCM", false, ["decrypt"]);
      DATA = await decrypt(key, enc);
      return start();
    } catch { store.del("paris.key"); }
  }
  showLock();
  $("#lockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#lockMsg").textContent = "";
    try {
      const key = await deriveKey($("#pw").value, enc);
      DATA = await decrypt(key, enc);
      if ($("#remember").checked) store.setRaw("paris.key", toB64(await crypto.subtle.exportKey("raw", key)));
      $("#lock").hidden = true;
      start();
    } catch {
      $("#lockMsg").textContent = "That password didn't work.";
    }
  });
}
function showLock(msg) { $("#lock").hidden = false; if (msg) $("#lockMsg").textContent = msg; }

// ---------- helpers ----------
const day = () => DATA.days.find((d) => d.id === dayId);
const stopsFor = (d) => state.days[d.id] || d.stops;
const placeOf = (s) => s.place || (s.pid ? DATA.places[s.pid] : null);
const hasLoc = (p) => p && typeof p.lat === "number" && typeof p.lng === "number";
const clone = (x) => JSON.parse(JSON.stringify(x));
const save = () => store.set("paris.state", state);
const uid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function edit(fn, opts) {
  const d = day();
  const list = clone(stopsFor(d));
  fn(list);
  state.days[d.id] = list;
  save();
  render(opts);
}

function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// straight-line distance, padded for street detours, at a relaxed 4.8 km/h
function walk(a, b) {
  const km = haversine(a, b) * 1.25;
  const min = Math.max(1, Math.round((km / 4.8) * 60));
  return { km, min };
}
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`);

// ---------- start / render ----------
function start() {
  $("#app").hidden = false;
  $("#dates").textContent = DATA.trip.dates;
  dayId = store.raw("paris.day") && DATA.days.some((d) => d.id === store.raw("paris.day")) ? store.raw("paris.day") : DATA.days[0].id;
  map = L.map("map", { zoomControl: true, attributionControl: true, minZoom: 11, maxZoom: 18 }).setView([DATA.hotel.lat, DATA.hotel.lng], 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 16, maxZoom: 18, crossOrigin: true,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);

  document.addEventListener("click", onClick);
  $("#bannerCancel").addEventListener("click", cancelPending);
  $("#scrim").addEventListener("click", closeSheet);
  $("#offlineBtn").addEventListener("click", saveTiles);
  render({ fit: true });
  offlineStatus();
}

function renderTabs() {
  $("#tabs").innerHTML = DATA.days.map((d) =>
    `<button role="tab" data-act="tab" data-id="${d.id}" aria-selected="${d.id === dayId}">${esc(d.tab)}</button>`).join("");
}

function render(opts = {}) {
  renderTabs();
  const d = day();
  const departure = d.kind === "departure";
  $("#dayTitle").textContent = d.title;
  $("#mapWrap").hidden = departure;
  if (departure) { renderDeparture(d); return; }

  const stops = stopsFor(d);
  const pts = [DATA.hotel];
  let total = 0;

  // list
  let html = `<div class="stop"><div class="num h">H</div><div>
      <div class="kicker">Start</div><div class="name">${esc(DATA.hotel.name)}</div>
      <p class="note">${esc(DATA.hotel.address)}</p></div></div>`;
  let prev = DATA.hotel;
  stops.forEach((s, i) => {
    const p = placeOf(s);
    const located = hasLoc(p);
    if (located) {
      const w = walk(prev, p);
      total += w.km;
      html += `<div class="leg">${fmtKm(w.km)} · about ${w.min} min on foot</div>`;
      prev = p;
      pts.push(p);
    } else {
      html += `<div class="leg">Not on the route yet</div>`;
    }
    const name = p ? p.name : "Open slot";
    html += `<div class="stop" id="stop-${s.id}"><div class="num">${i + 1}</div><div>
      <div class="kicker">${esc(s.kicker || "")}</div>
      <div class="name">${esc(name)}</div>
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
      ${s.time ? `<span class="chip">${esc(s.time)}${s.timeLabel ? " · " + esc(s.timeLabel) : ""}</span>` : ""}
      ${!located ? `<span class="chip warn">Needs a location</span>` : ""}
      <div class="tools">
        <button data-act="up" data-id="${s.id}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button data-act="down" data-id="${s.id}" aria-label="Move down" ${i === stops.length - 1 ? "disabled" : ""}>↓</button>
        ${p ? `<button data-act="swap" data-id="${s.id}">Swap</button>` : `<button class="text" data-act="swap" data-id="${s.id}">Choose place</button>`}
        ${!located ? `<button class="text" data-act="pin" data-id="${s.id}">Pin on map</button>` : ""}
        <button data-act="remove" data-id="${s.id}" aria-label="Remove">✕</button>
      </div></div></div>`;
  });
  $("#list").innerHTML = html;

  const n = stops.filter((s) => hasLoc(placeOf(s))).length;
  $("#daySummary").textContent = `${stops.length} stops · about ${total.toFixed(1)} km on foot${n < stops.length ? " (so far)" : ""}`;

  const edited = !!state.days[d.id];
  $("#actions").innerHTML = `<button class="ghost" data-act="add">+ Add a place</button>` +
    (edited ? `<button class="ghost plain" data-act="reset">Reset day</button>` : "");

  drawMap(stops, pts, opts.fit);
}

function drawMap(stops, pts, fit) {
  map.invalidateSize();
  layer.clearLayers();
  const icon = (label, cls = "") => L.divIcon({ className: "", html: `<div class="pin ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  L.marker([DATA.hotel.lat, DATA.hotel.lng], { icon: icon("H", "h") }).bindPopup(esc(DATA.hotel.name)).addTo(layer);
  stops.forEach((s, i) => {
    const p = placeOf(s);
    if (!hasLoc(p)) return;
    L.marker([p.lat, p.lng], { icon: icon(i + 1) }).bindPopup(esc(p.name))
      .on("click", () => flash(s.id)).addTo(layer);
  });
  L.polyline(pts.map((p) => [p.lat, p.lng]), { color: "#b4532a", weight: 3, opacity: .9, dashArray: "1 8", lineCap: "round" }).addTo(layer);
  if (fit) {
    const b = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
    map.fitBounds(b, { padding: [36, 36], maxZoom: 16 });
  }
}

function flash(id) {
  const el = document.getElementById("stop-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1400);
}

function renderDeparture(d) {
  const f = d.flight;
  const checks = state.checks[d.id] || {};
  $("#daySummary").textContent = "No sightseeing today";
  $("#list").innerHTML = `
    <div class="flight">
      <div class="eyebrow" style="color:#bfb5a0">Flight</div>
      <div class="big">${esc(f.number)}</div>
      <p>${esc(f.from)} → ${esc(f.to)}</p>
      <p>Departs ${esc(f.departs)}</p>
      <p>${esc(f.baggage)}</p>
    </div>
    <h4 class="eyebrow" style="margin:22px 0 4px">Before you leave</h4>
    ${d.checklist.map((t, i) => `<label class="check"><input type="checkbox" data-act="check" data-i="${i}" ${checks[i] ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}`;
  $("#actions").innerHTML = "";
}

// ---------- actions ----------
function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const { act, id } = t.dataset;
  if (act === "tab") { dayId = id; store.setRaw("paris.day", id); cancelPending(); render({ fit: true }); window.scrollTo({ top: 0 }); }
  else if (act === "up") edit((l) => move(l, id, -1));
  else if (act === "down") edit((l) => move(l, id, 1));
  else if (act === "remove") edit((l) => { l.splice(l.findIndex((s) => s.id === id), 1); }, { fit: true });
  else if (act === "swap") openSwap(id);
  else if (act === "pin") startPin(id);
  else if (act === "add") openAdd();
  else if (act === "reset") { delete state.days[day().id]; save(); render({ fit: true }); }
  else if (act === "check") {
    const d = day(); state.checks[d.id] = state.checks[d.id] || {};
    state.checks[d.id][t.dataset.i] = t.checked; save();
  }
}
function move(l, id, dir) {
  const i = l.findIndex((s) => s.id === id), j = i + dir;
  if (j < 0 || j >= l.length) return;
  [l[i], l[j]] = [l[j], l[i]];
}

// ---------- pickers ----------
function openSheet(html) {
  $("#sheet").innerHTML = html + `<button class="ghost sheetClose" data-sheet="close">Close</button>`;
  $("#sheet").hidden = false; $("#scrim").hidden = false;
  $("#sheet").querySelector("[data-sheet=close]").addEventListener("click", closeSheet);
}
function closeSheet() { $("#sheet").hidden = true; $("#scrim").hidden = true; }

const catLabel = { sight: "Sight", food: "Eat", shop: "Shop" };

function picker({ title, alts = [], onPick, allowPin }) {
  const all = Object.entries(DATA.places).sort((a, b) => a[1].name.localeCompare(b[1].name));
  openSheet(`<h3>${esc(title)}</h3>
    <input type="search" id="q" placeholder="Search places" aria-label="Search places">
    <div id="results"></div>`);
  const show = () => {
    const q = $("#q").value.trim().toLowerCase();
    const row = ([pid, p]) => `<button class="opt" data-pid="${pid}"><span>${esc(p.name)}</span><span class="tag">${catLabel[p.cat] || ""}</span></button>`;
    let h = "";
    if (!q && alts.length) h += `<h4>Your alternates</h4>` + alts.filter((a) => DATA.places[a]).map((a) => row([a, DATA.places[a]])).join("");
    const rest = all.filter(([pid, p]) => (!q || p.name.toLowerCase().includes(q)) && (q || !alts.includes(pid)));
    h += `<h4>${q ? "Results" : "All places"}</h4>` + (rest.map(row).join("") || `<p class="muted">No match.</p>`);
    if (allowPin) h += `<h4>Somewhere else</h4><button class="opt" data-pid="__pin"><span>Drop my own pin on the map</span><span class="tag">Custom</span></button>`;
    $("#results").innerHTML = h;
  };
  show();
  $("#q").addEventListener("input", show);
  $("#results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pid]");
    if (!b) return;
    closeSheet();
    onPick(b.dataset.pid);
  });
}

function openAdd() {
  picker({
    title: "Add a place", allowPin: true,
    onPick: (pid) => {
      if (pid === "__pin") return startPin(null);
      edit((l) => l.push({ id: uid(), pid, kicker: kickerFor(DATA.places[pid]), note: "" }), { fit: true });
    },
  });
}
const kickerFor = (p) => ({ sight: "Sight", food: "Food", shop: "Shopping" }[p.cat] || "");

function openSwap(id) {
  const s = stopsFor(day()).find((x) => x.id === id);
  picker({
    title: placeOf(s) ? "Swap this stop" : "Choose a place", alts: s.alts || [], allowPin: true,
    onPick: (pid) => {
      if (pid === "__pin") return startPin(id);
      edit((l) => {
        const t = l.find((x) => x.id === id);
        const old = t.pid;
        const alts = [old, ...(t.alts || [])].filter((a) => a && a !== pid);
        Object.assign(t, { pid, place: undefined, alts, time: undefined, timeLabel: undefined, note: "" });
      }, { fit: true });
    },
  });
}

// ---------- drop a pin ----------
function startPin(stopId) {
  const s = stopId ? stopsFor(day()).find((x) => x.id === stopId) : null;
  const known = s && placeOf(s);
  let name = known ? known.name : prompt("Name this place (for example: Dinner at Septime)", s?.kicker === "Dinner" ? "Dinner spot" : "");
  if (!name) return;
  pending = { stopId, name };
  $("#bannerText").textContent = `Tap the map to place “${name}”`;
  $("#banner").hidden = false;
  $("#mapWrap").scrollIntoView({ behavior: "smooth", block: "start" });
}
function cancelPending() { pending = null; $("#banner").hidden = true; }
function onMapClick(e) {
  if (!pending) return;
  const { stopId, name } = pending;
  const place = { name, cat: "sight", lat: +e.latlng.lat.toFixed(5), lng: +e.latlng.lng.toFixed(5) };
  cancelPending();
  edit((l) => {
    if (stopId) { const t = l.find((x) => x.id === stopId); t.place = place; t.pid = null; }
    else l.push({ id: uid(), pid: null, place, kicker: "Custom", note: "" });
  }, { fit: true });
}

// ---------- offline map ----------
const BBOX = { s: 48.835, w: 2.295, n: 48.885, e: 2.375 };
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
function tileUrls() {
  const out = [];
  for (let z = 12; z <= 16; z++)
    for (let x = lon2x(BBOX.w, z); x <= lon2x(BBOX.e, z); x++)
      for (let y = lat2y(BBOX.n, z); y <= lat2y(BBOX.s, z); y++)
        out.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
  return out;
}
async function saveTiles() {
  const btn = $("#offlineBtn"), msg = $("#offlineMsg");
  if (!("caches" in window)) { msg.textContent = "This browser can't save maps offline."; return; }
  const urls = tileUrls();
  btn.disabled = true;
  const cache = await caches.open("paris-tiles-v1");
  let done = 0, failed = 0;
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(urls.slice(i, i + 4).map(async (u) => {
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u, { mode: "cors" });
          if (r.ok) await cache.put(u, r); else failed++;
        }
      } catch { failed++; }
      done++;
    }));
    msg.textContent = `Saving map… ${done} / ${urls.length}`;
  }
  btn.disabled = false;
  if (failed) { msg.textContent = `Saved most of the map (${failed} tiles missing). Try again on Wi-Fi.`; return; }
  store.set("paris.tiles", Date.now());
  offlineStatus();
}
function offlineStatus() {
  const t = store.get("paris.tiles");
  $("#offlineMsg").textContent = t ? "Paris map saved on this phone ✓" : "Tap once on Wi-Fi so the map works without signal.";
  if (t) $("#offlineBtn").textContent = "Refresh offline map";
}

boot();
})();
