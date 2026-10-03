(() => {
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SVG = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
  out: '<path d="M7 17L17 7M9 7h8v8"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 0 0-4V4H3z" transform="translate(0 2)"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
};
const ic = (n) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${SVG[n] || ""}</svg>`;
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
let addAt = null; // where the next added stop goes (index in the day), or null for the end

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
let cityId = "paris";
const city = () => DATA.cities.find((c) => c.id === cityId);
const HOTEL = () => city().hotel;
const allDays = () => DATA.cities.flatMap((c) => c.days);
const day = () => city().days.find((d) => d.id === dayId);
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
  const cn = city().name;
  return t.toLowerCase().includes(cn.toLowerCase()) ? t : `${t}, ${cn}`;
};
const hotelText = () => HOTEL().address;
const dirUrl = (from, to, mode) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=${mode}`;
const searchUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapText(p))}`;
// live Google Maps results around a point (opens Maps; free, no key)
const gmNear = (term, lat, lng) => `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${(+lat).toFixed(5)},${(+lng).toFixed(5)},17z`;
const gmLinks = (lat, lng) => `<div class="gmrow">${[["Restaurants", "restaurants"], ["Cafés", "cafes"], ["Bakeries", "bakeries"], ["Boutiques", "boutiques"]]
  .map(([l, t]) => `<a href="${esc(gmNear(t, lat, lng))}" target="_blank" rel="noopener">${l} ↗</a>`).join("")}</div>`;
const CAT_LABEL = { eat: "Eat", sweet: "Sweet", shop: "Shop", sight: "Sight" };

const fmtKm = (km) => (km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`);

// ---------- start / render ----------
function start() {
  $("#app").hidden = false;
  $("#dates").textContent = DATA.trip.dates;
  const savedDay = store.raw("paris.day");
  const hit = DATA.cities.find((c) => c.days.some((d) => d.id === savedDay));
  cityId = hit ? hit.id : DATA.cities[0].id;
  dayId = hit ? savedDay : city().days[0].id;
  map = L.map("map", { zoomControl: true, attributionControl: true, minZoom: 11, maxZoom: 18 }).setView([HOTEL().lat, HOTEL().lng], 14);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 16, maxZoom: 18, crossOrigin: true,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", (e) => {
    const t = e.target.closest && e.target.closest('[role="button"][data-act]');
    if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); t.click(); }
  });
  $("#bannerCancel").addEventListener("click", cancelPending);
  $("#scrim").addEventListener("click", () => { if (Date.now() - sheetOpenedAt > 350) closeSheet(); }); // ignore the tap that opened it
  $("#offlineBtn").addEventListener("click", saveTiles);
  $("#fileIn").addEventListener("change", onFilesChosen);
  initDrag();
  const bar = $("#datebar");
  addEventListener("scroll", () => bar.classList.toggle("stuck", bar.getBoundingClientRect().top <= 0 && scrollY > 40), { passive: true });
  refreshCounts().then(() => render());
  render({ fit: true, animate: true });
  offlineStatus();
}

const dateObj = (d) => new Date(d.date + "T12:00:00");
const fmtDate = (d, o) => dateObj(d).toLocaleDateString("en-US", o);
function splitTime(t) {
  const m = /^(\d{1,2}:\d{2})\s*(am|pm)$/i.exec((t || "").trim());
  return m ? `${m[1]}<small>${m[2]}</small>` : "";
}

function renderTabs() {
  $("#cities").innerHTML = DATA.cities.map((c) =>
    `<button data-act="city" data-id="${c.id}" aria-pressed="${c.id === cityId}">${esc(c.name)}</button>`).join("");
  $("#tabs").innerHTML = city().days.map((d) =>
    `<button role="tab" data-act="tab" data-id="${d.id}" aria-selected="${d.id === dayId}">
       <span class="dow">${d.kind === "departure" ? "✈ " : ""}${esc(fmtDate(d, { weekday: "short" }))}</span><span class="dnum">${dateObj(d).getDate()}</span></button>`).join("");
  const on = $("#tabs [aria-selected=true]");
  if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
}

function animateIn(...els) {
  els.forEach((el) => { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); });
}

function render(opts = {}) {
  renderTabs();
  const c = city(), d = day();
  const departure = d.kind === "departure";
  document.body.dataset.city = c.id;
  document.title = c.name;
  $("#cityTitle").textContent = c.name;
  $("#citySub").textContent = `${c.dates} · ${c.hotel.name}`;
  $("#dayNum").textContent = dateObj(d).getDate();
  $("#dayDate").textContent = `${fmtDate(d, { weekday: "long" })} · ${fmtDate(d, { month: "long" })}`;
  $("#dayTitle").textContent = d.title;
  $("#dayNote").textContent = d.note || "";
  $("#heads").innerHTML = (d.heads || []).length
    ? `<details class="headsup"><summary>Planner's notes · ${d.heads.length}</summary><ul>${d.heads.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></details>` : "";
  $("#mapWrap").hidden = departure;
  if (opts.animate) animateIn($("#dayHead"), $("#list"));
  if (departure) { $("#hint").hidden = true; renderDeparture(d); return; }

  const stops = stopsFor(d);
  const pts = [HOTEL()];
  let total = 0;

  let html = `<div class="stop start"><div class="when"></div><div class="rail"><span class="dot h">H</span></div>
      <div class="body"><div class="kicker">Start · your hotel</div><div class="name">${esc(HOTEL().name)}</div>
      <p class="note">${esc(HOTEL().address)}</p></div></div>`;
  let prev = HOTEL(), prevText = hotelText();
  const routeTexts = [];
  const addBtn = (at) => `<button class="addhere" data-act="addAt" data-at="${at}" aria-label="Add a stop here">+</button>`;
  stops.forEach((s, i) => {
    const p = placeOf(s);
    const located = hasLoc(p);
    if (located) {
      const w = walk(prev, p);
      total += w.km;
      const here = mapText(p);
      const far = w.km > 1.5;
      html += `<div class="leg"><div></div><div class="rail">${addBtn(i)}</div><div class="info">
          <span class="walk">${w.min} min on foot · ${fmtKm(w.km)}</span>
          <span class="links"><a class="${far ? "rec" : ""}" href="${esc(dirUrl(prevText, here, "transit"))}" target="_blank" rel="noopener">${far ? "Take transit ↗" : "Transit ↗"}</a><a href="${esc(dirUrl(prevText, here, "walking"))}" target="_blank" rel="noopener">Walk ↗</a></span></div></div>`;
      prev = p; prevText = here; routeTexts.push(here);
      pts.push(p);
    } else {
      html += `<div class="leg"><div></div><div class="rail">${addBtn(i)}</div><div class="info"><span class="walk">not on the route yet</span></div></div>`;
    }
    const closed = closedOn(s.pid, d.date);
    const warn = timeWarn(s, d.date);
    const notice = alertFor(s.pid, d.date);
    const tkKey = s.pid || "custom:" + s.id;
    const tk = (ticketCounts[tkKey] || 0) + (state.links[tkKey] ? 1 : 0);
    const tags = [
      s.timeLabel ? `<span class="tag solid">${esc(s.timeLabel)}</span>` : "",
      tk ? `<span class="tag ok">Ticket saved</span>` : "",
      closed ? `<span class="tag warn">Closed this day</span>` : "",
      !closed && warn ? `<span class="tag warn">${esc(warn)}</span>` : "",
      notice ? `<span class="tag warn">Closure notice</span>` : "",
      p && !located ? `<span class="tag warn">Needs a location</span>` : "",
    ].join("");
    html += `<div class="stop" id="stop-${s.id}" data-id="${s.id}">
      <div class="when" data-act="setTime" data-id="${s.id}" role="button" tabindex="0" aria-label="${s.time ? "Change time" : "Add a time"}">${splitTime(s.time)}</div>
      <div class="rail"><span class="dot grip${p ? "" : " empty"}" data-id="${s.id}" aria-label="Stop ${i + 1}. Drag to reorder, or tap for options">${i + 1}</span></div>
      <div class="body${p ? " tap" : ""}" ${p ? `data-act="detail" data-id="${s.id}" role="button" tabindex="0"` : ""}>
        <div class="kicker">${esc(s.kicker || "")}</div>
        <div class="name">${p ? esc(p.name) : `<span class="muted">Open — choose a place</span>`}</div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        ${!p || !located ? `<div class="inline-actions">
            <button class="lead" data-act="swap" data-id="${s.id}">${p ? "Change place" : "Choose a place"}</button>
            <button data-act="pin" data-id="${s.id}">Drop a pin</button></div>` : ""}
      </div>
      <button class="more" data-act="menu" data-id="${s.id}" aria-label="Options for ${esc(p ? p.name : "this stop")}">⋯</button>
    </div>`;
  });
  html += `<div class="leg addend"><div></div><div class="rail">${addBtn(stops.length)}</div>
    <div class="info"><button class="addline" data-act="addAt" data-at="${stops.length}">Add a stop</button></div></div>`;
  $("#list").innerHTML = html;

  const n = stops.filter((s) => hasLoc(placeOf(s))).length;
  $("#daySummary").textContent = `${stops.length} stops · about ${total.toFixed(1)} km on foot${n < stops.length ? " so far" : ""}`;

  const edited = !!state.days[d.id];
  const mids = routeTexts.slice(0, -1).slice(0, 9);
  const routeUrl = routeTexts.length
    ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(hotelText())}&destination=${encodeURIComponent(routeTexts[routeTexts.length - 1])}${mids.length ? `&waypoints=${encodeURIComponent(mids.join("|"))}` : ""}&travelmode=walking`
    : "";
  $("#actions").innerHTML = `
       <button class="tool" data-act="addAt" data-at="${stops.length}">${ic("plus")} Add a stop</button>
       <button class="tool" data-act="nearMe">${ic("locate")} Near me</button>
       ${routeUrl ? `<a class="tool" target="_blank" rel="noopener" href="${esc(routeUrl)}">${ic("route")} Whole day</a>` : ""}
       ${edited ? `<button class="tool quiet" data-act="reset">${ic("reset")} Restore plan</button>` : ""}`;
  $("#hint").hidden = !!store.raw("paris.hintSeen") || stops.length < 2;

  drawMap(stops, pts, opts.fit);
}

function drawMap(stops, pts, fit) {
  map.invalidateSize();
  layer.clearLayers();
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#2c4a6e";
  const icon = (label, cls = "") => L.divIcon({ className: "", html: `<div class="pin ${cls}">${label}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  L.marker([HOTEL().lat, HOTEL().lng], { icon: icon("H", "h"), zIndexOffset: -10 }).bindPopup(esc(HOTEL().name)).addTo(layer);
  L.polyline(pts.map((p) => [p.lat, p.lng]), { color: accent, weight: 2.5, opacity: .85, dashArray: "2 7", lineCap: "round" }).addTo(layer);
  stops.forEach((s, i) => {
    const p = placeOf(s);
    if (!hasLoc(p)) return;
    L.marker([p.lat, p.lng], { icon: icon(i + 1) }).bindPopup(esc(p.name))
      .on("click", () => flash(s.id)).addTo(layer);
  });
  if (fit) {
    const b = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
    map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
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
  const [from, to] = [f.from, f.to];
  $("#daySummary").textContent = "Travel day";
  $("#actions").innerHTML = "";
  $("#list").innerHTML = `
    <div class="pass">
      <div class="eyebrow">Boarding · ${esc(fmtDate(d, { weekday: "long", month: "short", day: "numeric" }))}</div>
      <div class="flightno">${esc(f.number)}</div>
      <div class="route"><div class="place">${esc(from)}</div><div class="plane">✈</div><div class="place">${esc(to)}</div></div>
      <div class="perf"></div>
      <div class="row"><div><span class="eyebrow">Departs</span><b>${esc(f.departs)}</b></div><div><span class="eyebrow">Bags</span><b>${esc(f.baggage)}</b></div></div>
    </div>
    <div class="checklist"><h3>Before you leave</h3>
    ${d.checklist.map((t, i) => `<label class="check"><input type="checkbox" data-act="check" data-i="${i}" ${checks[i] ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}</div>`;
}

// ---------- actions ----------
function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const { act, id } = t.dataset;
  if (t.dataset.close) closeSheet();
  if (act === "city") {
    if (id !== cityId) {
      cityId = id; cancelPending();
      const saved = store.raw("paris.day." + id);
      dayId = city().days.some((d) => d.id === saved) ? saved : city().days[0].id;
      store.setRaw("paris.day", dayId);
      render({ fit: true, animate: true }); offlineStatus(); window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  else if (act === "tab") { dayId = id; store.setRaw("paris.day", id); store.setRaw("paris.day." + cityId, id); cancelPending(); render({ fit: true, animate: true });
    const top = $("#datebar").offsetTop;
    if (scrollY > top) window.scrollTo({ top, behavior: "smooth" }); }
  else if (act === "menu") openMenu(id);
  else if (act === "setTime") setTime(id);
  else if (act === "addAt") { store.setRaw("paris.hintSeen", "1"); openAdd(+t.dataset.at); }
  else if (act === "hideHint") { store.setRaw("paris.hintSeen", "1"); $("#hint").hidden = true; }
  else if (act === "up") edit((l) => move(l, id, -1));
  else if (act === "down") edit((l) => move(l, id, 1));
  else if (act === "remove") { if (confirm("Remove this stop from the day?")) edit((l) => { l.splice(l.findIndex((s) => s.id === id), 1); }, { fit: true }); }
  else if (act === "swap") openSwap(id);
  else if (act === "pin") startPin(id);
  else if (act === "add") openAdd(null);
  else if (act === "reset") { if (confirm("Restore this day to the original plan? Your changes to this day will be undone.")) { delete state.days[day().id]; save(); render({ fit: true }); } }
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

// ---------- stop options, time, drag to reorder ----------
function openMenu(id) {
  const stops = stopsFor(day());
  const i = stops.findIndex((x) => x.id === id);
  if (i < 0) return;
  const s = stops[i], p = placeOf(s);
  const b = (act, label, extra = "") => `<button data-act="${act}" data-id="${id}" data-close="1" ${extra}>${label}</button>`;
  openSheet(`<p class="kicker">Stop ${i + 1}${s.time ? " · " + esc(s.time) : ""}</p><h3>${p ? esc(p.name) : "Open slot"}</h3>
    <div class="menu">
      ${p ? b("detail", "Details, tickets & stories") : ""}
      ${b("swap", p ? "Swap for another place" : "Choose a place")}
      ${b("setTime", s.time ? "Change the time" : "Add a time")}
      ${b("up", "Move earlier", i === 0 ? "disabled" : "")}
      ${b("down", "Move later", i === stops.length - 1 ? "disabled" : "")}
      <button data-act="addAt" data-at="${i + 1}" data-close="1">Add a stop after this</button>
      ${b("remove", "Remove from the day", 'class="danger"')}
    </div>`);
}

function setTime(id) {
  const s = stopsFor(day()).find((x) => x.id === id);
  if (!s) return;
  const v = prompt("Time for this stop, for example 2:30 pm. Leave empty to clear it.", s.time || "");
  if (v === null) return;
  let t = v.trim().toLowerCase().replace(/\s+/g, " ");
  const h24 = /^([01]?\d|2[0-3])[:.h]([0-5]\d)$/.exec(t);
  if (h24) { const h = +h24[1]; t = `${h % 12 || 12}:${h24[2]} ${h >= 12 ? "pm" : "am"}`; }
  t = t.replace(/^(\d{1,2})[.:h](\d{2}) ?(am|pm)$/, "$1:$2 $3");
  if (t && !/^(1[0-2]|0?[1-9]):[0-5]\d (am|pm)$/.test(t)) { alert("Please write the time like 2:30 pm."); return; }
  edit((l) => { const x = l.find((y) => y.id === id); if (t) x.time = t.replace(/^0/, ""); else delete x.time; });
}

// drag a stop's number up or down; a plain tap on the number opens the options
function initDrag() {
  $("#list").addEventListener("pointerdown", (e) => {
    const g = e.target.closest(".grip");
    const row = g && g.closest(".stop[data-id]");
    if (!row || e.button > 0) return;
    e.preventDefault();
    const rows = [...document.querySelectorAll("#list .stop[data-id]")];
    const from = rows.indexOf(row);
    const others = rows.filter((r) => r !== row);
    const mids = rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + scrollY + b.height / 2; });
    const startY = e.clientY + scrollY;
    let lastY = e.clientY, moved = false, to = from, raf = 0;
    try { g.setPointerCapture(e.pointerId); } catch {}

    const update = () => {
      const dy = lastY + scrollY - startY;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) { moved = true; row.classList.add("dragging"); document.body.classList.add("drag-active"); if (navigator.vibrate) navigator.vibrate(8); }
      row.style.transform = `translateY(${dy}px)`;
      const center = mids[from] + dy;
      to = mids.filter((m, j) => j !== from && m < center).length;
      others.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      if (to !== from) {
        if (to < others.length) others[to].classList.add("drop-before");
        else others[others.length - 1].classList.add("drop-after");
      }
    };
    const loop = () => {   // gently scroll when the finger nears the top or bottom edge
      if (!moved) { raf = requestAnimationFrame(loop); return; }
      const edge = 90, top = 70;
      if (lastY < top + edge) scrollBy(0, -Math.ceil((top + edge - lastY) / 8));
      else if (lastY > innerHeight - edge) scrollBy(0, Math.ceil((lastY - innerHeight + edge) / 8));
      update();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onMove = (ev) => { lastY = ev.clientY; update(); };
    const finish = (ev, cancelled) => {
      cancelAnimationFrame(raf);
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      g.removeEventListener("pointercancel", onCancel);
      row.style.transform = "";
      row.classList.remove("dragging");
      document.body.classList.remove("drag-active");
      others.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      if (cancelled) return;
      if (!moved) { openMenu(row.dataset.id); return; }
      if (to !== from) {
        store.setRaw("paris.hintSeen", "1");
        edit((l) => { const [x] = l.splice(from, 1); l.splice(to, 0, x); });
      }
    };
    const onUp = (ev) => finish(ev, false);
    const onCancel = (ev) => finish(ev, true);
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
    g.addEventListener("pointercancel", onCancel);
  });
}

// ---------- pickers ----------
function openSheet(html) {
  $("#sheet").innerHTML = html + `<button class="sheetClose" data-sheet="close">Close</button>`;
  $("#sheet").hidden = false; $("#scrim").hidden = false;
  sheetOpenedAt = Date.now();
  $("#sheet").querySelector("[data-sheet=close]").addEventListener("click", closeSheet);
}
let sheetOpenedAt = 0;
function closeSheet() { $("#sheet").hidden = true; $("#scrim").hidden = true; }

const catLabel = { sight: "Sight", food: "Eat", shop: "Shop" };

function picker({ title, alts = [], onPick, allowPin }) {
  const all = Object.entries(DATA.places).filter(([, p]) => (p.city || "paris") === cityId).sort((a, b) => a[1].name.localeCompare(b[1].name));
  openSheet(`<h3>${esc(title)}</h3>
    <input type="search" id="q" placeholder="Search places" aria-label="Search places">
    <div id="results"></div>`);
  const show = () => {
    const q = $("#q").value.trim().toLowerCase();
    const row = ([pid, p]) => `<button class="opt" data-pid="${pid}"><span>${esc(p.name)}</span><span class="optcat">${catLabel[p.cat] || ""}</span></button>`;
    let h = "";
    if (!q && alts.length) h += `<h4>Your alternates</h4>` + alts.filter((a) => DATA.places[a]).map((a) => row([a, DATA.places[a]])).join("");
    const rest = all.filter(([pid, p]) => (!q || p.name.toLowerCase().includes(q)) && (q || !alts.includes(pid)));
    h += `<h4>${q ? "Results" : "All places"}</h4>` + (rest.map(row).join("") || `<p class="muted">No match.</p>`);
    if (allowPin) h += `<h4>Somewhere else</h4><button class="opt" data-pid="__gmaps"><span>Paste a Google Maps link</span><span class="optcat">From Maps</span></button><button class="opt" data-pid="__pin"><span>Drop my own pin on the map</span><span class="optcat">Custom</span></button>`;
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

const insertStop = (l, x) => {
  const at = addAt == null || addAt > l.length ? l.length : addAt;
  l.splice(at, 0, x);
  addAt = null;
};
function openAdd(at) {
  addAt = at == null || Number.isNaN(at) ? null : at;
  picker({
    title: "Add a place", allowPin: true,
    onPick: (pid) => {
      if (pid === "__pin") return startPin(null);
      if (pid === "__gmaps") return pasteMapsLink(null);
      edit((l) => insertStop(l, { id: uid(), pid, kicker: kickerFor(DATA.places[pid]), note: "" }), { fit: true });
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
    else insertStop(l, { id: uid(), pid: null, place, kicker: "From Maps", note: "" });
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
function cancelPending() { if (pending) addAt = null; pending = null; $("#banner").hidden = true; }
function onMapClick(e) {
  if (!pending) return;
  const { stopId, name } = pending;
  const place = { name, cat: "sight", lat: +e.latlng.lat.toFixed(5), lng: +e.latlng.lng.toFixed(5) };
  cancelPending();
  edit((l) => {
    if (stopId) { const t = l.find((x) => x.id === stopId); t.place = place; t.pid = null; }
    else insertStop(l, { id: uid(), pid: null, place, kicker: "Custom", note: "" });
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
        <div class="dist">${n.min} min walk · ${fmtKm(n.km)}</div></div>
      <div class="nbtns"><button data-act="addNearby" data-i="${n.i}">Add to day</button><a href="${esc(searchUrl(n))}" target="_blank" rel="noopener">Map ↗</a></div>
    </div>`).join("");
}
function addNearby(btn) {
  const n = DATA.nearby[+btn.dataset.i];
  if (!n || btn.disabled) return;
  edit((l) => l.push({
    id: uid(), pid: null, kicker: { eat: "Eat", sweet: "Treat", shop: "Shopping", sight: "Sight" }[n.cat] || "Stop", note: n.note,
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
    <div class="chips">${chip("all", "All")}${chip("eat", "Eat")}${chip("sweet", "Sweet")}${chip("shop", "Shop")}${chip("sight", "Sights")}</div>
    <p class="sublabel" style="margin-top:6px">Live in Google Maps</p>${gmLinks(nearOrigin.lat, nearOrigin.lng)}
    <p class="sublabel">Hand-picked favourites</p>
    ${far ? `<p class="note">You seem to be far from the hand-picked list. Distances below are from where you are.</p>` : ""}
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
const toMin = (h, m, ap) => (+h % 12 + (/pm/i.test(ap) ? 12 : 0)) * 60 + +m;
const fmtMin = (t) => { const h = Math.floor(t / 60), m = t % 60; return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`; };
function parseRanges(str) {
  const out = [], re = /(\d{1,2}):(\d{2})\s*(am|pm)\s*[–-]\s*(\d{1,2}):(\d{2})\s*(am|pm)/gi;
  let m;
  while ((m = re.exec(str || ""))) out.push([toMin(m[1], m[2], m[3]), toMin(m[4], m[5], m[6])]);
  return out;
}
function parseTime(str) { const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(str || ""); return m ? toMin(m[1], m[2], m[3]) : null; }
// compares the time you planned with the opening hours; returns a short warning or ""
function timeWarn(s, date) {
  const g = s.pid && DATA.guide && DATA.guide[s.pid];
  if (!g || !g.hours || typeof g.hours !== "object" || !s.time || !date) return "";
  const t = parseTime(s.time), v = g.hours[weekday(date)];
  if (t == null || !v || isClosed(v)) return "";
  const r = parseRanges(v);
  if (!r.length || r.some(([a, b]) => t >= a && t < b)) return "";
  return t < r[0][0] ? `Opens at ${fmtMin(r[0][0])}` : "May be closed at that time";
}
function alertFor(pid, date) {
  const g = pid && DATA.guide && DATA.guide[pid];
  const a = g && (g.alerts || []).find((x) => date >= x.from && date <= x.to);
  return a ? a.text : "";
}
const weekday = (date) => DOW[new Date(date + "T12:00:00").getDay()];
const isClosed = (v) => /^closed/i.test(v || "");
function closedOn(pid, date) {
  const g = pid && DATA.guide && DATA.guide[pid];
  return !!(g && date && g.hours && typeof g.hours === "object" && isClosed(g.hours[weekday(date)]));
}

function hoursHtml(g, date) {
  if (!g.hours) return `<p class="muted">Hours not added yet.</p>`;
  if (typeof g.hours === "string") return `<div class="callout">${esc(g.hours)}</div>${g.hoursNote ? `<p class="fineprint">${esc(g.hoursNote)}</p>` : ""}`;
  const wd = weekday(date);
  const label = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const today = g.hours[wd];
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((k) =>
    `<tr class="${k === wd ? "today" : ""} ${isClosed(g.hours[k]) ? "closed" : ""}"><td>${k}</td><td>${esc(g.hours[k])}</td></tr>`).join("");
  return `<div class="callout ${isClosed(today) ? "alert" : ""}">${isClosed(today) ? `Closed on ${esc(label)}. Pick another day or swap this stop.` : `<span class="muted">${esc(label)}</span><br><b style="font-weight:600">${esc(today)}</b>`}</div>
    <table class="hours">${rows}</table>
    ${g.hoursNote ? `<p class="fineprint">${esc(g.hoursNote)}</p>` : ""}`;
}

function openDetail(stopId) {
  const d = day();
  const s = stopsFor(d).find((x) => x.id === stopId);
  const p = s && placeOf(s);
  if (!p) return;
  const key = s.pid || "custom:" + s.id;
  detail = { stopId, key };
  const g = (s.pid && DATA.guide && DATA.guide[s.pid]) || {};
  const q = encodeURIComponent(`${p.name} ${p.address || city().name}`);
  const hi = (g.highlights || []).map((h, i) => `<details><summary><span class="no">${i + 1}.</span><span><span class="t">${esc(h.title)}</span><span class="by">${esc(h.by || "")}</span></span><span class="plus">+</span></summary><p>${esc(h.story)}</p></details>`).join("");
  const hs = (g.history || []).map((h) => `<div class="story"><h4>${esc(h.title)}</h4><p>${esc(h.text)}</p></div>`).join("");
  const notice = alertFor(s.pid, d.date);
  $("#detail").innerHTML = `<div class="dwrap">
    <div class="dtop"><button class="back" data-act="closeDetail">${ic("back")} ${esc(fmtDate(d, { weekday: "long" }))}</button><span class="eyebrow">${esc(city().name)}</span></div>
    <div class="dhero">
      <div class="kicker">${esc(s.kicker || "")}${s.time ? ` · ${esc(s.time)}` : ""}</div>
      <h2>${esc(p.name)}</h2>
      ${p.address ? `<div class="addr">${esc(p.address)}</div>` : ""}
      <div class="tags">
        ${s.timeLabel ? `<span class="tag solid">${esc(s.timeLabel)}</span>` : ""}
        <a class="tag" style="text-decoration:none" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">${ic("map")} Open in Google Maps</a>
      </div>
    </div>
    <div class="dbody">
      ${g.tip ? `<section class="dsec"><h3>From your guide</h3><div class="callout tip">${esc(g.tip)}</div></section>` : ""}
      <section class="dsec"><h3>Your ticket</h3>
        <div class="ticketcard"><div id="tickets"></div><div id="noteLink"></div></div>
        <div class="btn-row"><button class="tool" data-act="addTicket">${ic("plus")} Add PDF or photo</button><span id="linkBtn"></span></div>
        <p class="privacy">Saved only on this phone, never uploaded. Keep the original in Apple Notes as a backup.</p></section>
      <section class="dsec"><h3>Opening hours</h3>${notice ? `<div class="callout alert" style="margin-bottom:12px">${esc(notice)}</div>` : ""}${hoursHtml(g, d.date)}</section>
      ${hi ? `<section class="dsec catalog"><h3>Don’t miss</h3>${hi}</section>` : ""}
      ${hs ? `<section class="dsec"><h3>Stories</h3>${hs}</section>` : ""}
      ${hasLoc(p) ? `<section class="dsec"><h3>Nearby</h3><p class="sublabel" style="margin-top:0">Live in Google Maps</p>${gmLinks(p.lat, p.lng)}<p class="sublabel">Hand-picked favourites</p>${nearbyHtml(nearbyList(p.lat, p.lng, { limit: 6, maxKm: 1.2, exclude: p.name }))}<p class="privacy">Favourites are a hand-picked list, so check hours before you go.</p></section>` : ""}
      <p class="verify">Hours come from public listings checked in October 2026.<br>Stories are curated from general art-history knowledge.</p>
    </div></div>`;
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
  catch { el.innerHTML = `<p class="ticket-empty">This browser mode can’t save tickets. Open the app from your Home Screen icon.</p>`; return; }
  el.innerHTML = list.length
    ? list.map((t) => `<div class="ticket"><span class="tname">${esc(t.name)}</span><button class="open" data-act="viewTicket" data-id="${t.id}">Open</button><button data-act="delTicket" data-id="${t.id}">Remove</button></div>`).join("")
    : state.links[detail.key]
      ? `<p class="ticket-added">Ticket added, in your Apple Note.</p>`
      : `<p class="ticket-empty">No ticket added yet.</p>`;
}

function renderNoteLink() {
  const el = $("#noteLink");
  if (!el || !detail) return;
  const url = state.links[detail.key];
  el.innerHTML = url
    ? `<div class="ticket"><span class="tname">Apple Note <span class="muted" style="font-size:12px">· needs signal</span></span><a class="small-btn" href="${esc(url)}" target="_blank" rel="noopener">Open ↗</a><button data-act="delLink">Remove</button></div>`
    : "";
  const lb = $("#linkBtn");
  if (lb) lb.innerHTML = url ? "" : `<button class="tool quiet" data-act="setLink">Link an Apple Note</button>`;
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
const bboxOf = (c) => ({ s: c.bbox[0], w: c.bbox[1], n: c.bbox[2], e: c.bbox[3] });
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
function tileUrls() {
  const out = [], BBOX = bboxOf(city());
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
  const cid = cityId;
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
  store.set("paris.tiles." + cid, Date.now());
  offlineStatus();
}
function offlineStatus() {
  const t = store.get("paris.tiles." + cityId) || (cityId === "paris" && store.get("paris.tiles"));
  $("#offlineMsg").textContent = t ? `${city().name} map saved on this phone ✓` : "Tap once on Wi-Fi so the map works without signal.";
  $("#offlineBtn").innerHTML = `${ic("map")} ${t ? `Refresh ${esc(city().name)} offline map` : `Save ${esc(city().name)} map for offline`}`;
}

boot();
})();
