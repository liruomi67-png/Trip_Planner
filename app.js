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
state.links = state.links || {};
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
// ---- Google Maps links (free, no key; they open the Maps app or website) ----
const mapText = (p) => {
  if (!p) return "";
  if (!p.address) return `${p.lat},${p.lng}`;
  const t = `${p.name}, ${p.address}`.replace(/\s*\([^)]*\)/g, "").trim();
  return /paris/i.test(t) ? t : t + ", Paris";
};
const hotelText = () => DATA.hotel.address;
const dirUrl = (from, to, mode) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=${mode}`;
const searchUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapText(p))}`;
// live Google Maps results around a point (opens Maps; free, no key)
const gmNear = (term, lat, lng) => `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${(+lat).toFixed(5)},${(+lng).toFixed(5)},17z`;
const gmLinks = (lat, lng) => `<div class="gmrow">${[["Restaurants", "restaurants"], ["Cafés", "cafes"], ["Bakeries", "bakeries"], ["Boutiques", "boutiques"]]
  .map(([l, t]) => `<a href="${esc(gmNear(t, lat, lng))}" target="_blank" rel="noopener">${l} ↗</a>`).join("")}</div>`;
const CAT_LABEL = { eat: "Eat", sweet: "Sweet", shop: "Shop" };

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
  $("#fileIn").addEventListener("change", onFilesChosen);
  refreshCounts().then(() => render());
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
  $("#dayMaps").innerHTML = "";
  if (departure) { renderDeparture(d); return; }

  const stops = stopsFor(d);
  const pts = [DATA.hotel];
  let total = 0;

  // list
  let html = `<div class="stop"><div class="num h">H</div><div>
      <div class="kicker">Start</div><div class="name">${esc(DATA.hotel.name)}</div>
      <p class="note">${esc(DATA.hotel.address)}</p></div></div>`;
  let prev = DATA.hotel, prevText = hotelText();
  const routeTexts = [];
  stops.forEach((s, i) => {
    const p = placeOf(s);
    const located = hasLoc(p);
    if (located) {
      const w = walk(prev, p);
      total += w.km;
      const here = mapText(p);
      html += `<div class="leg"><span>${fmtKm(w.km)} · about ${w.min} min on foot${w.km > 1.5 ? " · transit may be quicker" : ""}</span>
        <span class="legLinks"><a href="${esc(dirUrl(prevText, here, "transit"))}" target="_blank" rel="noopener">Transit ↗</a><a href="${esc(dirUrl(prevText, here, "walking"))}" target="_blank" rel="noopener">Walk ↗</a></span></div>`;
      prev = p; prevText = here; routeTexts.push(here);
      pts.push(p);
    } else {
      html += `<div class="leg">Not on the route yet</div>`;
    }
    const name = p ? p.name : "Open slot";
    const closed = closedOn(s.pid, d.date);
    const tkKey = s.pid || "custom:" + s.id;
    const tk = (ticketCounts[tkKey] || 0) + (state.links[tkKey] ? 1 : 0);
    html += `<div class="stop" id="stop-${s.id}"><div class="num">${i + 1}</div><div>
      <div class="kicker">${esc(s.kicker || "")}</div>
      ${p ? `<button class="name linkname" data-act="detail" data-id="${s.id}">${esc(name)}</button>` : `<div class="name">${esc(name)}</div>`}
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
      ${s.time ? `<span class="chip">${esc(s.time)}${s.timeLabel ? " · " + esc(s.timeLabel) : ""}</span>` : ""}
      ${tk ? `<span class="chip">Ticket saved</span>` : ""}
      ${closed ? `<span class="chip warn">Closed this day</span>` : ""}
      ${!located ? `<span class="chip warn">Needs a location</span>` : ""}
      <div class="tools">
        <button data-act="up" data-id="${s.id}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button data-act="down" data-id="${s.id}" aria-label="Move down" ${i === stops.length - 1 ? "disabled" : ""}>↓</button>
        ${p ? `<button data-act="swap" data-id="${s.id}">Swap</button><button class="text" data-act="detail" data-id="${s.id}">Details</button>` : `<button class="text" data-act="swap" data-id="${s.id}">Choose place</button>`}
        ${!located ? `<button class="text" data-act="pin" data-id="${s.id}">Pin on map</button>` : ""}
        <button data-act="remove" data-id="${s.id}" aria-label="Remove">✕</button>
      </div></div></div>`;
  });
  $("#list").innerHTML = html;

  const n = stops.filter((s) => hasLoc(placeOf(s))).length;
  $("#daySummary").textContent = `${stops.length} stops · about ${total.toFixed(1)} km on foot${n < stops.length ? " (so far)" : ""}`;

  const edited = !!state.days[d.id];
  $("#actions").innerHTML = `<button class="ghost" data-act="add">+ Add a place</button>` +
    `<button class="ghost" data-act="nearMe">Near me</button>` +
    (edited ? `<button class="ghost plain" data-act="reset">Reset day</button>` : "");
  const mids = routeTexts.slice(0, -1).slice(0, 9);
  $("#dayMaps").innerHTML = routeTexts.length
    ? `<a class="ghost" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener" href="${esc(
        `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(hotelText())}&destination=${encodeURIComponent(routeTexts[routeTexts.length - 1])}${mids.length ? `&waypoints=${encodeURIComponent(mids.join("|"))}` : ""}&travelmode=walking`)}">Whole day in Google Maps (walking) ↗</a>`
    : "";

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
  else if (act === "detail") openDetail(id);
  else if (act === "closeDetail") closeDetail();
  else if (act === "addTicket") { $("#fileIn").value = ""; $("#fileIn").click(); }
  else if (act === "nearMe") nearMe();
  else if (act === "nearCat") { nearCat = t.dataset.cat; renderNearSheet(); }
  else if (act === "addNearby") addNearby(t);
  else if (act === "setLink") setNoteLink();
  else if (act === "delLink") { delete state.links[detail.key]; save(); renderNoteLink(); renderTickets(); }
  else if (act === "viewTicket") viewTicket(id);
  else if (act === "delTicket") delTicket(id);
  else if (act === "closeViewer") closeViewer();
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
    if (allowPin) h += `<h4>Somewhere else</h4><button class="opt" data-pid="__gmaps"><span>Paste a Google Maps link</span><span class="tag">From Maps</span></button><button class="opt" data-pid="__pin"><span>Drop my own pin on the map</span><span class="tag">Custom</span></button>`;
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
      if (pid === "__gmaps") return pasteMapsLink(null);
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
      if (pid === "__gmaps") return pasteMapsLink(id);
      edit((l) => {
        const t = l.find((x) => x.id === id);
        const old = t.pid;
        const alts = [old, ...(t.alts || [])].filter((a) => a && a !== pid);
        Object.assign(t, { pid, place: undefined, alts, time: undefined, timeLabel: undefined, note: "" });
      }, { fit: true });
    },
  });
}

// ---------- bring a place back from Google Maps ----------
function parseMapsUrl(text) {
  let u;
  try { u = new URL(text.trim()); } catch { return { err: "link" }; }
  const host = u.hostname;
  if (/(^|\.)goo\.gl$/i.test(host)) return { err: "short" };
  if (!/(^|\.)google\.[a-z.]+$/i.test(host)) return { err: "link" };
  const href = u.href;
  const pin = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  const at = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const q = u.searchParams.get("q") || u.searchParams.get("query") || "";
  const qm = q.match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
  const c = pin || at || qm;
  if (!c) return { err: "coords" };
  const m = u.pathname.match(/\/maps\/place\/([^/]+)/);
  let name = "";
  try { name = m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : (q && !qm ? q : ""); } catch { name = m ? m[1] : ""; }
  return { name: name || "Place from Google Maps", lat: +c[1], lng: +c[2] };
}
function pasteMapsLink(stopId) {
  const v = prompt("Paste the Google Maps link of the place");
  if (!v) return;
  const r = parseMapsUrl(v);
  if (r.err === "short") { alert("That is a short link. Open it in Safari first, then copy the long address from the address bar and paste that instead."); return; }
  if (r.err) { alert("I couldn’t read a place from that link. Open the place in Google Maps, tap Share, copy the link and try again."); return; }
  const place = { name: r.name, cat: "sight", lat: +r.lat.toFixed(5), lng: +r.lng.toFixed(5) };
  edit((l) => {
    if (stopId) { const t = l.find((x) => x.id === stopId); t.place = place; t.pid = null; t.alts = t.alts || []; }
    else l.push({ id: uid(), pid: null, place, kicker: "From Maps", note: "" });
  }, { fit: true });
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

// ---------- nearby recommendations (curated sample list) ----------
let nearCat = "all";
let nearOrigin = null;
function nearbyList(lat, lng, { limit = 8, maxKm = Infinity, cat = "all", exclude = "" } = {}) {
  return (DATA.nearby || [])
    .map((n, i) => ({ ...n, i, km: haversine({ lat, lng }, n) * 1.25 }))
    .filter((n) => n.km <= maxKm && (cat === "all" || n.cat === cat) && n.name !== exclude && !exclude.includes(n.name))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    .map((n) => ({ ...n, min: Math.max(1, Math.round((n.km / 4.8) * 60)) }));
}
function nearbyHtml(list) {
  if (!list.length) return `<p class="muted">Nothing on the list nearby.</p>`;
  return list.map((n) => `<div class="nrow">
      <div class="ninfo"><div class="nname">${esc(n.name)} <span class="tagc">${CAT_LABEL[n.cat] || ""}</span></div>
        <div class="note">${esc(n.note)}</div>
        <div class="note">${fmtKm(n.km)} · about ${n.min} min on foot</div></div>
      <div class="nbtns"><button data-act="addNearby" data-i="${n.i}">Add to day</button><a href="${esc(searchUrl(n))}" target="_blank" rel="noopener">Map ↗</a></div>
    </div>`).join("");
}
function addNearby(btn) {
  const n = DATA.nearby[+btn.dataset.i];
  if (!n || btn.disabled) return;
  edit((l) => l.push({
    id: uid(), pid: null, kicker: { eat: "Eat", sweet: "Treat", shop: "Shopping" }[n.cat] || "Stop", note: n.note,
    place: { name: n.name, cat: n.cat, lat: n.lat, lng: n.lng, address: n.address },
  }), { fit: true });
  btn.textContent = "Added ✓";
  btn.disabled = true;
}
function nearMe() {
  if (!navigator.geolocation) { openSheet(`<h3>Near me</h3><p>This browser can’t share your location.</p>`); return; }
  openSheet(`<h3>Near me</h3><p class="muted">Finding where you are…</p>`);
  navigator.geolocation.getCurrentPosition(
    (pos) => { nearOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude }; nearCat = "all"; renderNearSheet(); },
    () => openSheet(`<h3>Near me</h3><p>Location is off for this app. Turn it on in Settings → Privacy &amp; Security → Location Services → Safari Websites, then try again. You can also open Details on any stop to see places near it.</p>`),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function renderNearSheet() {
  if (!nearOrigin) return;
  const list = nearbyList(nearOrigin.lat, nearOrigin.lng, { limit: 8, cat: nearCat });
  const chip = (c, label) => `<button data-act="nearCat" data-cat="${c}" class="${nearCat === c ? "on" : ""}">${label}</button>`;
  const far = list.length && list[0].km > 4;
  openSheet(`<h3>Near you now</h3>
    <div class="chips">${chip("all", "All")}${chip("eat", "Eat")}${chip("sweet", "Sweet")}${chip("shop", "Shop")}</div>
    <p class="note" style="margin:6px 0 8px">Live results with ratings and hours, in Google Maps:</p>${gmLinks(nearOrigin.lat, nearOrigin.lng)}
    <p class="note" style="margin:14px 0 0">Our hand-picked favourites:</p>
    ${far ? `<p class="note">You seem to be far from the Paris list. Distances below are from where you are.</p>` : ""}
    ${nearbyHtml(list)}
    <p class="privacy">Your location stays on your phone. Favourites are a hand-picked list, so check hours before you go.</p>`);
}

// ---------- tickets (kept in this phone's browser storage only) ----------
let ticketCounts = {};
let detail = null; // { stopId, key }
const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open("paris-tickets", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "id" }).createIndex("key", "key");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const withStore = async (mode, fn) => {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction("files", mode);
    const req = fn(t.objectStore("files"));
    t.oncomplete = () => { db.close(); res(req && req.result); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
};
const ticketsFor = (key) => withStore("readonly", (s) => s.index("key").getAll(key)).then((r) => r || []);
async function refreshCounts() {
  try {
    const all = await withStore("readonly", (s) => s.getAll());
    ticketCounts = {};
    (all || []).forEach((r) => { ticketCounts[r.key] = (ticketCounts[r.key] || 0) + 1; });
  } catch {}
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (date) => DOW[new Date(date + "T12:00:00").getDay()];
const isClosed = (v) => /^closed/i.test(v || "");
function closedOn(pid, date) {
  const g = pid && DATA.guide && DATA.guide[pid];
  return !!(g && date && g.hours && typeof g.hours === "object" && isClosed(g.hours[weekday(date)]));
}

function hoursHtml(g, date) {
  if (!g.hours) return `<p class="muted">Hours not added yet.</p>`;
  if (typeof g.hours === "string") return `<p>${esc(g.hours)}</p>`;
  const wd = weekday(date);
  const label = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const today = g.hours[wd];
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((k) =>
    `<tr class="${k === wd ? "today" : ""} ${isClosed(g.hours[k]) ? "closed" : ""}"><td>${k}</td><td>${esc(g.hours[k])}</td></tr>`).join("");
  return `<div class="callout ${isClosed(today) ? "alert" : ""}">${isClosed(today) ? `Closed on ${esc(label)}. Pick another day or swap this stop.` : `On ${esc(label)}: ${esc(today)}`}</div>
    <table class="hours" style="margin-top:12px">${rows}</table>
    ${g.hoursNote ? `<p class="privacy">${esc(g.hoursNote)}</p>` : ""}`;
}

function openDetail(stopId) {
  const d = day();
  const s = stopsFor(d).find((x) => x.id === stopId);
  const p = s && placeOf(s);
  if (!p) return;
  const key = s.pid || "custom:" + s.id;
  detail = { stopId, key };
  const g = (s.pid && DATA.guide && DATA.guide[s.pid]) || {};
  const q = encodeURIComponent(`${p.name} ${p.address || "Paris"}`);
  const hi = (g.highlights || []).map((h) => `<details><summary><span class="t">${esc(h.title)}</span><span class="by">${esc(h.by || "")}</span></summary><p>${esc(h.story)}</p></details>`).join("");
  const hs = (g.history || []).map((h) => `<div class="story"><h4>${esc(h.title)}</h4><p>${esc(h.text)}</p></div>`).join("");
  $("#detail").innerHTML = `
    <button class="back" data-act="closeDetail">← Back to the day</button>
    <div class="kicker">${esc(s.kicker || "")}</div>
    <h2>${esc(p.name)}</h2>
    ${p.address ? `<div class="muted">${esc(p.address)}</div>` : ""}
    <a class="maplink" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
    ${s.time ? `<div><span class="chip">${esc(s.time)}${s.timeLabel ? " · " + esc(s.timeLabel) : ""}</span></div>` : ""}
    <section><h3>Your ticket</h3><div id="tickets"></div>
      <button class="ghost" data-act="addTicket">+ Add ticket or confirmation (PDF or photo)</button>
      <div id="noteLink"></div>
      <p class="privacy">Saved only on this phone. It is never uploaded. Keep the original in Apple Notes as a backup.</p></section>
    <section><h3>Opening hours</h3>${hoursHtml(g, d.date)}</section>
    ${hasLoc(p) ? `<section><h3>Nearby to eat and browse</h3><p class="note" style="margin:0 0 8px">Live results with ratings and hours, in Google Maps:</p>${gmLinks(p.lat, p.lng)}<p class="note" style="margin:14px 0 0">Our hand-picked favourites:</p>${nearbyHtml(nearbyList(p.lat, p.lng, { limit: 6, maxKm: 1.2, exclude: p.name }))}<p class="privacy">Favourites are a hand-picked list, so check hours before you go.</p></section>` : ""}
    ${g.tip ? `<section><h3>Tour guide tip</h3><div class="callout">${esc(g.tip)}</div></section>` : ""}
    ${hi ? `<section><h3>Don’t miss</h3>${hi}</section>` : ""}
    ${hs ? `<section><h3>Stories and history</h3>${hs}</section>` : ""}
    ${!hi && !hs ? `<section><h3>Stories</h3><p class="muted">No stories for this place yet.</p></section>` : ""}
    <p class="verify">Hours come from public listings checked in October 2026. Stories are curated from general art-history knowledge. Confirm hours on the official site before you go.</p>`;
  renderNoteLink();
  $("#detail").hidden = false;
  $("#detail").scrollTop = 0;
  document.body.style.overflow = "hidden";
  renderTickets();
}
function closeDetail() {
  $("#detail").hidden = true;
  document.body.style.overflow = "";
  detail = null;
  refreshCounts().then(() => render());
}

async function renderTickets() {
  const el = $("#tickets");
  if (!el || !detail) return;
  let list;
  try { list = await ticketsFor(detail.key); }
  catch { el.innerHTML = `<p class="muted">This browser mode can’t save tickets. Open the app from your Home Screen icon.</p>`; return; }
  el.innerHTML = list.length
    ? list.map((t) => `<div class="ticket"><span class="tname">${esc(t.name)}</span><button class="open" data-act="viewTicket" data-id="${t.id}">Open</button><button data-act="delTicket" data-id="${t.id}">Remove</button></div>`).join("")
    : state.links[detail.key]
      ? `<p>Ticket added. It’s in your Apple Note, linked below.</p>`
      : `<p class="muted">No ticket added yet.</p>`;
}

function renderNoteLink() {
  const el = $("#noteLink");
  if (!el || !detail) return;
  const url = state.links[detail.key];
  el.innerHTML = url
    ? `<div class="ticket"><span class="tname">Apple Note link</span><a class="maplink" style="margin:0" href="${esc(url)}" target="_blank" rel="noopener">Open note ↗</a><button data-act="delLink">Remove</button></div>
       <p class="privacy">Needs a signal. Use the saved file above for offline.</p>`
    : `<button class="ghost plain" style="margin-top:8px;width:100%;border-color:var(--line);color:var(--muted)" data-act="setLink">Or link to the Apple Note</button>`;
}
function setNoteLink() {
  const v = (prompt("Paste the Apple Notes link (in Notes: Share → Copy Link)") || "").trim();
  if (!v) return;
  if (!/^(https:\/\/|mobilenotes:\/\/)/i.test(v)) { alert("That doesn’t look like a link. It should start with https://"); return; }
  state.links[detail.key] = v;
  save();
  renderNoteLink();
  renderTickets();
}

async function onFilesChosen(e) {
  const files = [...e.target.files];
  if (!files.length || !detail) return;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  try {
    for (const f of files) {
      // store the bytes (more reliable on iPhone than storing the File object)
      const data = await f.arrayBuffer();
      await withStore("readwrite", (s) => s.put({ id: uid(), key: detail.key, name: f.name, type: f.type, data, added: Date.now() }));
    }
  } catch { alert("Could not save that file on this phone."); }
  await refreshCounts();
  renderTickets();
}

async function delTicket(id) {
  if (!confirm("Remove this ticket from the app? Your original in Notes is untouched.")) return;
  await withStore("readwrite", (s) => s.delete(id));
  await refreshCounts();
  renderTickets();
}

let viewerUrl = null;
const loadScript = (src) => new Promise((res, rej) => {
  if (window.pdfjsLib) return res();
  const el = document.createElement("script");
  el.src = src; el.onload = res; el.onerror = rej;
  document.head.appendChild(el);
});
async function viewTicket(id) {
  const rec = await withStore("readonly", (s) => s.get(id));
  if (!rec) return;
  const body = $("#viewerBody");
  $("#viewerName").textContent = rec.name;
  body.innerHTML = `<div class="vmsg">Raise your screen brightness before scanning.</div>`;
  $("#viewer").hidden = false;
  const isPdf = rec.type === "application/pdf" || /\.pdf$/i.test(rec.name);
  try {
    if (isPdf) {
      await loadScript("vendor/pdf.min.js");
      pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(rec.data.slice(0)) }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const w = body.clientWidth || 360, dpr = window.devicePixelRatio || 1;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, (w * dpr) / base.width) });
        const c = document.createElement("canvas");
        c.width = vp.width; c.height = vp.height;
        body.appendChild(c);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      }
    } else {
      viewerUrl = URL.createObjectURL(new Blob([rec.data], { type: rec.type || "image/jpeg" }));
      const img = document.createElement("img");
      img.src = viewerUrl;
      body.appendChild(img);
    }
  } catch { body.innerHTML = `<div class="vmsg">Could not open this file.</div>`; }
}
function closeViewer() {
  $("#viewer").hidden = true;
  $("#viewerBody").innerHTML = "";
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
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
