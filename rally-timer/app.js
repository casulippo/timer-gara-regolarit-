'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'rally-timer-presets';
const THEME_KEY   = 'rally-timer-theme';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  screen:      'home',
  theme:       localStorage.getItem(THEME_KEY) || 'dark',
  presets:     JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
  editing:     null,
  race:        null,
  routeEditor: null,
};

// ── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freq = 880, dur = 0.12) {
  try {
    const ctx  = getAudio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.6, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch (_) {}
}

// ── Wake Lock ────────────────────────────────────────────────────────────────
let wakeLock = null;

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'race') acquireWakeLock();
});

// ── GPS ───────────────────────────────────────────────────────────────────────
let gpsWatchId = null;

function haversineM(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function startGpsTracking() {
  if (!('geolocation' in navigator)) {
    state.race.gps.error = 'GPS non disponibile su questo dispositivo.';
    return;
  }
  gpsWatchId = navigator.geolocation.watchPosition(
    onGpsUpdate,
    onGpsError,
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function stopGpsTracking() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

function onGpsUpdate(pos) {
  const gps = state.race && state.race.gps;
  if (!gps) return;

  const { latitude: lat, longitude: lon, speed, accuracy } = pos.coords;
  const speedKmh = speed != null ? speed * 3.6 : null;

  if (gps.prevLat !== null && accuracy < 30) {
    const dist = haversineM(gps.prevLat, gps.prevLon, lat, lon);
    if (speedKmh === null || speedKmh > 2) {
      gps.sectorDistM += dist;
      gps.totalDistM  += dist;
    }
  }

  gps.prevLat  = lat;
  gps.prevLon  = lon;
  gps.speedKmh = speedKmh !== null ? speedKmh : gps.speedKmh;
  gps.accuracy = accuracy;
  gps.error    = null;

  updateMapPosition(lat, lon);
}

function onGpsError(err) {
  if (!state.race) return;
  const msgs = { 1: 'Permesso GPS negato.', 2: 'Segnale GPS assente.', 3: 'Timeout GPS.' };
  state.race.gps.error = msgs[err.code] || 'Errore GPS.';
}

function resetSectorGps() {
  if (!state.race) return;
  const gps = state.race.gps;
  gps.sectorDistM = 0;
  gps.prevLat     = null;
  gps.prevLon     = null;
}

// ── Time Utils ───────────────────────────────────────────────────────────────
function parseTimeInput(str) {
  const parts = String(str).trim().split(':').map(p => parseInt(p) || 0);
  if (parts.length === 1) return parts[0] * 100;
  if (parts.length === 2) return parts[0] * 100 + parts[1];
  return parts[0] * 6000 + parts[1] * 100 + parts[2];
}

function formatCs(cs) {
  const abs = Math.abs(cs);
  const mm  = Math.floor(abs / 6000);
  const ss  = Math.floor((abs % 6000) / 100);
  const cc  = abs % 100;
  const s   = cs < 0 ? '-' : '';
  const ccStr = String(cc).padStart(2, '0');
  if (mm > 0) return `${s}${mm}:${String(ss).padStart(2,'0')}.${ccStr}`;
  return `${s}${ss}.${ccStr}`;
}

function csToInput(cs) {
  if (!cs) return '';
  const mm  = Math.floor(cs / 6000);
  const ss  = Math.floor((cs % 6000) / 100);
  const cc  = cs % 100;
  const ccStr = String(cc).padStart(2, '0');
  if (mm > 0) return `${mm}:${String(ss).padStart(2,'0')}:${ccStr}`;
  return `${ss}:${ccStr}`;
}

function formatDelta(cs) {
  const sign = cs >= 0 ? '+' : '';
  return sign + (cs / 100).toFixed(2);
}

function presetDistances(preset) {
  return preset.distances || preset.steps.map(() => 0);
}

// ── Storage ───────────────────────────────────────────────────────────────────
function savePresets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.presets));
}

// ── RAF Loop ──────────────────────────────────────────────────────────────────
let rafId = null;

function startRaf() {
  if (rafId) return;
  function tick() {
    if (state.screen === 'race' && state.race) updateRaceDOM();
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function stopRaf() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function updateRaceDOM() {
  const race      = state.race;
  const now       = performance.now();
  const elapsedCs = Math.round((now - race.stepStartMs) / 10);
  const targetCs  = race.preset.steps[race.stepIndex];
  const sectorDelta = elapsedCs - targetCs;

  const completedActual = race.results.reduce((a, r) => a + r.actualCs, 0);
  const completedTarget = race.preset.steps.slice(0, race.stepIndex).reduce((a, s) => a + s, 0);
  const totalDelta = (completedActual + elapsedCs) - (completedTarget + targetCs);

  const sectorEl = document.getElementById('race-delta-sector');
  const totalEl  = document.getElementById('race-delta-total');
  const stepEl   = document.getElementById('race-step');
  if (sectorEl) sectorEl.textContent = formatDelta(sectorDelta);
  if (totalEl)  totalEl.textContent  = formatDelta(totalDelta);
  if (stepEl)   stepEl.textContent   = `Step ${race.stepIndex + 1} / ${race.preset.steps.length}`;

  // GPS
  const gps = race.gps;
  const speedEl     = document.getElementById('race-speed');
  const distEl      = document.getElementById('race-dist');
  const distDeltaEl = document.getElementById('race-dist-delta');
  const gpsErrEl    = document.getElementById('race-gps-error');

  if (gpsErrEl) {
    gpsErrEl.textContent  = gps.error || '';
    gpsErrEl.style.display = gps.error ? 'block' : 'none';
  }
  if (speedEl) {
    speedEl.textContent = gps.speedKmh != null
      ? `${Math.round(gps.speedKmh)} km/h` : '-- km/h';
  }

  const distances   = presetDistances(race.preset);
  const targetDistM = distances[race.stepIndex] || 0;
  if (distEl) {
    distEl.textContent = targetDistM > 0
      ? `${Math.round(gps.sectorDistM)}/${targetDistM}m`
      : `${Math.round(gps.sectorDistM)}m`;
  }
  if (distDeltaEl) {
    if (targetDistM > 0) {
      const dd = Math.round(gps.sectorDistM - targetDistM);
      distDeltaEl.textContent = (dd >= 0 ? '+' : '') + dd + 'm';
      distDeltaEl.className   = 'map-overlay map-overlay-br ' + (dd > 5 ? 'late' : dd < -5 ? 'early' : 'exact');
    } else {
      distDeltaEl.textContent = '';
    }
  }
}

// ── Race Logic ────────────────────────────────────────────────────────────────
function startRace(preset) {
  state.race = {
    preset,
    stepIndex:   0,
    stepStartMs: performance.now(),
    stepHistory: [],
    results:     [],
    beepIds:     [],
    leafletMap:  null,
    carMarker:   null,
    mapReady:    false,
    gps: {
      prevLat:     null,
      prevLon:     null,
      sectorDistM: 0,
      totalDistM:  0,
      speedKmh:    null,
      accuracy:    null,
      error:       null,
    },
  };
  state.race.stepHistory.push(state.race.stepStartMs);
  scheduleBeeps();
  acquireWakeLock();
  startGpsTracking();
  navigate('race');
  startRaf();
  requestAnimationFrame(initLeafletMap);
}

function initLeafletMap() {
  const race  = state.race;
  const mapEl = document.getElementById('race-map');
  if (!race || !mapEl || race.leafletMap) return;

  const map = L.map('race-map', {
    zoomControl:      false,
    attributionControl: false,
    dragging:         false,
    touchZoom:        false,
    scrollWheelZoom:  false,
    doubleClickZoom:  false,
    boxZoom:          false,
    keyboard:         false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  L.control.attribution({ prefix: false })
    .addAttribution('<a href="https://www.openstreetmap.org/copyright">© OSM</a>')
    .addTo(map);

  // Default view: center Italy until GPS fix
  map.setView([41.9, 12.5], 6);

  const carIcon = L.divIcon({
    html: '<div class="car-dot"></div>',
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  race.carMarker  = L.marker([41.9, 12.5], { icon: carIcon }).addTo(map);
  race.leafletMap = map;

  // Draw saved route
  const route = race.preset.route;
  if (route && route.path && route.path.length > 1) {
    L.polyline(route.path, { color: '#4af', weight: 4, opacity: 0.85 }).addTo(map);
    map.fitBounds(L.polyline(route.path).getBounds(), { padding: [30, 30] });
    race.mapReady = true;
  }
  // Draw checkpoint markers
  (route && route.checkpoints || []).forEach((cp, i) => {
    L.circleMarker(cp, {
      radius: 11,
      color: '#fff',
      fillColor: race.results.length > i ? '#666' : '#f90',
      fillOpacity: 1,
      weight: 2,
    }).bindTooltip(String(i + 1), {
      permanent: true,
      direction: 'center',
      className: 'cp-label',
    }).addTo(map);
  });

  setTimeout(() => map.invalidateSize(), 100);
}

function updateMapPosition(lat, lon) {
  const race = state.race;
  if (!race || !race.leafletMap) return;
  const pos = [lat, lon];
  race.carMarker.setLatLng(pos);
  if (!race.mapReady) {
    race.leafletMap.setView(pos, 16);
    race.mapReady = true;
  } else {
    race.leafletMap.panTo(pos, { animate: true, duration: 0.8 });
  }
}

function scheduleBeeps() {
  const race = state.race;
  race.beepIds.forEach(clearTimeout);
  race.beepIds = [];
  const targetMs  = race.preset.steps[race.stepIndex] * 10;
  const elapsedMs = performance.now() - race.stepStartMs;
  [3000, 2000, 1000].forEach(ms => {
    const delay = targetMs - elapsedMs - ms;
    if (delay > 0) race.beepIds.push(setTimeout(() => beep(880, 0.1), delay));
  });
}

function pressNext() {
  const race = state.race;
  const now  = performance.now();
  const actualCs  = Math.round((now - race.stepStartMs) / 10);
  const targetCs  = race.preset.steps[race.stepIndex];
  const distances = presetDistances(race.preset);

  race.beepIds.forEach(clearTimeout);
  race.beepIds = [];
  race.results.push({
    targetCs,
    actualCs,
    sectorDistM: Math.round(race.gps.sectorDistM),
    targetDistM: distances[race.stepIndex] || 0,
  });

  const isLast = race.stepIndex >= race.preset.steps.length - 1;
  if (isLast) {
    stopRaf();
    stopGpsTracking();
    releaseWakeLock();
    navigate('results');
    return;
  }

  race.stepIndex++;
  race.stepStartMs = now;
  race.stepHistory.push(race.stepStartMs);
  resetSectorGps();
  scheduleBeeps();
  updateRaceControls();
}

function pressUndo() {
  const race = state.race;
  if (race.stepIndex === 0 && race.results.length === 0) return;

  race.beepIds.forEach(clearTimeout);
  race.beepIds = [];

  if (race.results.length > 0) race.results.pop();
  if (race.stepIndex > 0) race.stepIndex--;

  race.stepHistory.pop();
  race.stepStartMs = performance.now();
  race.stepHistory.push(race.stepStartMs);
  resetSectorGps();
  scheduleBeeps();
  updateRaceControls();
}

// Partial update — keeps map alive, only refreshes labels/buttons
function updateRaceControls() {
  const race    = state.race;
  const isFirst = race.stepIndex === 0 && race.results.length === 0;
  const isLast  = race.stepIndex >= race.preset.steps.length - 1;

  const undoBtn = document.getElementById('btn-undo');
  const nextBtn = document.getElementById('btn-next');
  if (undoBtn) undoBtn.disabled = isFirst;
  if (nextBtn) nextBtn.textContent = isLast ? '■ FINE' : '▶ AVANTI';

  // Recalculate initTotal (completed steps changed)
  const totalEl = document.getElementById('race-delta-total');
  if (totalEl) {
    const completedTarget = race.preset.steps.slice(0, race.stepIndex).reduce((a, s) => a + s, 0);
    const completedActual = race.results.reduce((a, r) => a + r.actualCs, 0);
    const targetCs = race.preset.steps[race.stepIndex];
    totalEl.textContent = formatDelta((completedActual - targetCs) - completedTarget);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function navigate(screen) {
  state.screen = screen;
  render();
}

function render() {
  document.body.className = state.theme;
  const app = document.getElementById('app');
  switch (state.screen) {
    case 'home':         app.innerHTML = renderHome();         break;
    case 'config':       app.innerHTML = renderConfig();       break;
    case 'route-editor': app.innerHTML = renderRouteEditor();  break;
    case 'race':         app.innerHTML = renderRace();         break;
    case 'results':      app.innerHTML = renderResults();      break;
  }
  bindEvents();
  if (state.screen === 'route-editor') requestAnimationFrame(initRouteEditorMap);
}

// ── Home ──────────────────────────────────────────────────────────────────────
function renderHome() {
  const icon = state.theme === 'dark' ? '☀️' : '🌙';
  const list = state.presets.length === 0
    ? `<p class="empty">Nessun preset salvato. Creane uno!</p>`
    : state.presets.map((p, i) => {
        const total    = p.steps.reduce((a, b) => a + b, 0);
        const dists    = presetDistances(p);
        const totalDist = dists.reduce((a, b) => a + b, 0);
        const distLabel = totalDist > 0 ? ` · ${totalDist} m` : '';
        return `
          <div class="preset-card">
            <div class="preset-info">
              <span class="preset-name">${escHtml(p.name)}</span>
              <span class="preset-steps">${p.steps.length} step · ${formatCs(total)}${distLabel}</span>
            </div>
            <div class="preset-actions">
              <button class="btn-icon" data-action="share"  data-index="${i}" title="Condividi">🔗</button>
              <button class="btn-icon" data-action="edit"   data-index="${i}" title="Modifica">✏️</button>
              <button class="btn-icon" data-action="delete" data-index="${i}" title="Elimina">🗑️</button>
              <button class="btn-start" data-action="start" data-index="${i}" title="Avvia">▶</button>
            </div>
          </div>`;
      }).join('');

  return `
    <div class="screen home-screen">
      <header>
        <h1>Rally Timer</h1>
        <div class="header-actions">
          <label class="btn-icon" title="Importa JSON" style="cursor:pointer">
            📥<input type="file" accept=".json" id="import-file-input" style="display:none" />
          </label>
          <button class="btn-icon" data-action="export-all" title="Esporta tutti">📤</button>
          <button class="btn-icon" data-action="theme" title="Tema">${icon}</button>
        </div>
      </header>
      <div class="preset-list">${list}</div>
      <button class="btn-primary" data-action="new">+ Nuovo Preset</button>
    </div>`;
}

// ── Config ────────────────────────────────────────────────────────────────────
function renderConfig() {
  const p = state.editing;
  const dists = p.distances || p.steps.map(() => 0);

  const stepsHtml = p.steps.map((cs, i) => `
    <div class="step-row">
      <label>Step ${i + 1}</label>
      <div class="step-inputs">
        <input type="text" inputmode="text" class="time-input" data-step="${i}"
               value="${csToInput(cs)}" placeholder="SS:CC" />
        <input type="number" inputmode="numeric" class="dist-input" data-step="${i}"
               value="${dists[i] || ''}" placeholder="m" min="0" max="9999" />
      </div>
      <button class="btn-remove-step" data-step="${i}" title="Rimuovi">✕</button>
    </div>`).join('');

  const total = p.steps.reduce((a, b) => a + b, 0);
  const totalDist = dists.reduce((a, b) => a + (b || 0), 0);
  const addBtn = p.steps.length < 10
    ? `<button class="btn-secondary" data-action="add-step">+ Aggiungi Step</button>` : '';

  return `
    <div class="screen config-screen">
      <header>
        <button class="btn-icon" data-action="back">←</button>
        <h2>${p.isNew ? 'Nuovo Preset' : 'Modifica Preset'}</h2>
        <button class="btn-icon" data-action="save" title="Salva">✓</button>
      </header>
      <div class="config-name-row">
        <input type="text" id="preset-name" value="${escHtml(p.name)}" placeholder="Nome preset" maxlength="40" />
      </div>
      <div class="config-col-labels">
        <span></span><span>Tempo (SS:CC)</span><span>Metri</span><span></span>
      </div>
      <div class="steps-list">${stepsHtml}</div>
      ${addBtn}
      <div class="total-row">
        Totale: <strong>${formatCs(total)}</strong>
        ${totalDist > 0 ? `&nbsp;·&nbsp;<strong>${totalDist} m</strong>` : ''}
      </div>
      <button class="btn-route" data-action="edit-route">
        🗺️ ${p.route && p.route.path && p.route.path.length > 1
          ? `Percorso salvato (${p.route.path.length} pt · ${(p.route.checkpoints || []).length} checkpoint)`
          : 'Disegna Percorso su Mappa'}
      </button>
    </div>`;
}

// ── Race ──────────────────────────────────────────────────────────────────────
function renderRace() {
  const race      = state.race;
  const isFirst   = race.stepIndex === 0 && race.results.length === 0;
  const isLast    = race.stepIndex >= race.preset.steps.length - 1;
  const targetCs  = race.preset.steps[race.stepIndex];
  const initSector = formatDelta(-targetCs);

  const completedTarget = race.preset.steps.slice(0, race.stepIndex).reduce((a, s) => a + s, 0);
  const completedActual = race.results.reduce((a, r) => a + r.actualCs, 0);
  const initTotal = formatDelta((completedActual - targetCs) - completedTarget);

  const distances   = presetDistances(race.preset);
  const targetDistM = distances[race.stepIndex] || 0;

  return `
    <div class="screen race-screen">
      <div class="race-header">
        <span id="race-step">Step ${race.stepIndex + 1} / ${race.preset.steps.length}</span>
        <span class="preset-label">${escHtml(race.preset.name)}</span>
      </div>

      <div class="race-deltas">
        <div class="race-delta-block">
          <div class="race-delta-sublabel">SETTORE</div>
          <div id="race-delta-sector" class="race-delta">${initSector}</div>
        </div>
        <div class="race-delta-divider"></div>
        <div class="race-delta-block">
          <div class="race-delta-sublabel">TOTALE</div>
          <div id="race-delta-total" class="race-delta">${initTotal}</div>
        </div>
      </div>

      <div class="race-map-wrapper">
        <div id="race-map"></div>
        <div class="map-overlay map-overlay-tl" id="race-speed">-- km/h</div>
        <div class="map-overlay map-overlay-tr" id="race-dist">
          0${targetDistM > 0 ? '/' + targetDistM + 'm' : 'm'}
        </div>
        <div class="map-overlay map-overlay-br" id="race-dist-delta"></div>
        <div class="map-overlay map-overlay-bl gps-error-overlay" id="race-gps-error" style="display:none"></div>
      </div>

      <div class="race-buttons">
        <button id="btn-undo" class="btn-undo" data-action="undo" ${isFirst ? 'disabled' : ''}>◀ UNDO</button>
        <button id="btn-next" class="btn-next" data-action="next">${isLast ? '■ FINE' : '▶ AVANTI'}</button>
      </div>
    </div>`;
}

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
  const { results, preset } = state.race;
  const hasGpsDist = results.some(r => r.targetDistM > 0);

  const rows = results.map((r, i) => {
    const d    = r.actualCs - r.targetCs;
    const cls  = d > 0 ? 'late' : d < 0 ? 'early' : 'exact';
    const sign = d >= 0 ? '+' : '';
    const distCell = hasGpsDist
      ? `<td class="${r.targetDistM > 0 ? (r.sectorDistM - r.targetDistM > 5 ? 'late' : r.sectorDistM - r.targetDistM < -5 ? 'early' : 'exact') : ''}">${
          r.targetDistM > 0
            ? `${r.sectorDistM}/${r.targetDistM}m`
            : `${r.sectorDistM}m`
        }</td>` : '';
    return `
      <tr>
        <td>Step ${i + 1}</td>
        <td>${formatCs(r.targetCs)}</td>
        <td>${formatCs(r.actualCs)}</td>
        <td class="${cls}">${sign}${(d / 100).toFixed(2)}s</td>
        ${distCell}
      </tr>`;
  }).join('');

  const totTarget = results.reduce((a, r) => a + r.targetCs, 0);
  const totActual = results.reduce((a, r) => a + r.actualCs, 0);
  const totDelta  = totActual - totTarget;
  const totCls    = totDelta > 0 ? 'late' : totDelta < 0 ? 'early' : 'exact';
  const totSign   = totDelta >= 0 ? '+' : '';
  const totDistCell = hasGpsDist
    ? `<td>${results.reduce((a, r) => a + r.sectorDistM, 0)}m</td>` : '';
  const distHeader = hasGpsDist ? '<th>Dist GPS</th>' : '';

  return `
    <div class="screen results-screen">
      <header>
        <h2>Risultati — ${escHtml(preset.name)}</h2>
      </header>
      <table class="results-table">
        <thead><tr><th>Step</th><th>Target</th><th>Reale</th><th>Δ Tempo</th>${distHeader}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td><strong>Totale</strong></td>
            <td>${formatCs(totTarget)}</td>
            <td>${formatCs(totActual)}</td>
            <td class="${totCls}"><strong>${totSign}${(totDelta / 100).toFixed(2)}s</strong></td>
            ${totDistCell}
          </tr>
        </tfoot>
      </table>
      <button class="btn-primary" data-action="home">← Home</button>
    </div>`;
}

// ── Route Editor ─────────────────────────────────────────────────────────────
function renderRouteEditor() {
  const re     = state.routeEditor;
  const nSteps = state.editing ? state.editing.steps.filter(s => s > 0).length : 0;
  const cpCount = (re.checkpoints || []).length;
  const ptCount = (re.waypoints || []).length;
  const modePathActive = re.mode === 'path' ? 'active' : '';
  const modeCpActive   = re.mode === 'checkpoint' ? 'active' : '';

  return `
    <div class="screen route-editor-screen">
      <div class="route-editor-header">
        <button class="btn-icon" data-action="route-back">←</button>
        <div class="route-mode-toggle">
          <button class="mode-btn ${modePathActive}" data-action="route-mode-path">
            Tracciato${ptCount > 0 ? ` (${ptCount}pt)` : ''}
          </button>
          <button class="mode-btn ${modeCpActive}" data-action="route-mode-checkpoint">
            Checkpoint${nSteps > 0 ? ` (${cpCount}/${nSteps})` : ''}
          </button>
        </div>
        <button class="btn-icon" data-action="route-save" title="Salva">✓</button>
      </div>

      <div class="route-map-container">
        <div id="route-map" class="route-map"></div>
        <div id="route-loading" class="route-loading" style="display:none">
          <div class="route-loading-spinner"></div>
          <span>Calcolo percorso stradale…</span>
        </div>
        <div id="route-msg" class="route-msg" style="display:none"></div>
        <div class="route-hint">
          ${re.mode === 'path'
            ? 'Tap sulla mappa per aggiungere punti. Il percorso seguirà le strade.'
            : `Tap per aggiungere i checkpoint dei pressostati (${cpCount}/${nSteps}).`}
        </div>
      </div>

      <div class="route-editor-footer">
        <button class="btn-secondary-sm" data-action="route-undo">↩ Annulla</button>
        <button class="btn-secondary-sm" data-action="route-clear">✕ Cancella</button>
      </div>
    </div>`;
}

function initRouteEditorMap() {
  const re    = state.routeEditor;
  const mapEl = document.getElementById('route-map');
  if (!re || !mapEl || re.leafletMap) return;

  const map = L.map('route-map', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  re.leafletMap = map;
  re.pathLine   = L.polyline(re.waypoints, { color: '#4af', weight: 5, opacity: 0.9 }).addTo(map);
  re.cpMarkers  = re.checkpoints.map((cp, i) => makeCpMarker(cp, i).addTo(map));
  re.dotMarkers = [];  // only dots for newly tapped points in this session

  if (re.waypoints.length > 1) {
    map.fitBounds(re.pathLine.getBounds(), { padding: [30, 30] });
  } else {
    map.setView([41.9, 12.5], 6);
  }

  map.on('click', e => {
    const re = state.routeEditor;
    if (re.loading) return;
    const { lat, lng } = e.latlng;
    if (re.mode === 'path') {
      addRouteWaypoint(lat, lng);
    } else {
      const maxCp = state.editing ? state.editing.steps.filter(s => s > 0).length : 10;
      if (re.checkpoints.length >= maxCp) {
        alert(`Massimo ${maxCp} checkpoint (uguale al numero di step).`); return;
      }
      re.checkpoints.push([lat, lng]);
      re.cpMarkers.push(makeCpMarker([lat, lng], re.checkpoints.length - 1).addTo(map));
      updateRouteEditorHeader();
    }
  });

  setTimeout(() => map.invalidateSize(), 100);
}

async function addRouteWaypoint(lat, lon) {
  const re = state.routeEditor;
  if (!re || re.loading) return;

  const newPt = [lat, lon];

  if (re.waypoints.length === 0) {
    // First point — just place it, no OSRM needed
    re.tapBoundaries.push(0);
    re.waypoints.push(newPt);
    re.pathLine.setLatLngs(re.waypoints);
    re.dotMarkers.push(L.circleMarker(newPt, pathDotStyle()).addTo(re.leafletMap));
    return;
  }

  const fromPt = re.waypoints[re.waypoints.length - 1];
  const boundary = re.waypoints.length;

  re.loading = true;
  setRouteLoadingUI(true);

  try {
    const segment = await fetchRoadRoute(fromPt, newPt);
    // segment = [fromPt, ...roadPoints, newPt]; skip first (already in waypoints)
    re.tapBoundaries.push(boundary);
    re.waypoints.push(...segment.slice(1));
    re.pathLine.setLatLngs(re.waypoints);
    re.dotMarkers.push(L.circleMarker(newPt, pathDotStyle()).addTo(re.leafletMap));
  } catch (_) {
    // Offline or OSRM error — straight line fallback
    re.tapBoundaries.push(boundary);
    re.waypoints.push(newPt);
    re.pathLine.setLatLngs(re.waypoints);
    re.dotMarkers.push(L.circleMarker(newPt, { ...pathDotStyle(), color: '#f90', fillColor: '#f90' }).addTo(re.leafletMap));
    showRouteMsg('Offline: tratto in linea retta', 2000);
  } finally {
    re.loading = false;
    setRouteLoadingUI(false);
  }
}

async function fetchRoadRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/`
    + `${from[1]},${from[0]};${to[1]},${to[0]}`
    + `?overview=full&geometries=geojson`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('OSRM HTTP error');
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(data.message);
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}

function setRouteLoadingUI(loading) {
  const el = document.getElementById('route-loading');
  if (el) el.style.display = loading ? 'flex' : 'none';
}

function showRouteMsg(msg, ms = 2500) {
  const el = document.getElementById('route-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, ms);
}

function pathDotStyle() {
  return { radius: 4, color: '#4af', fillColor: '#4af', fillOpacity: 0.7, weight: 1 };
}

function makeCpMarker(latlng, idx) {
  return L.circleMarker(latlng, {
    radius: 12,
    color: '#fff',
    fillColor: '#f90',
    fillOpacity: 1,
    weight: 2,
  }).bindTooltip(String(idx + 1), {
    permanent: true,
    direction: 'center',
    className: 'cp-label',
    offset: [0, 0],
  });
}

function updateRouteEditorHeader() {
  const re      = state.routeEditor;
  const nSteps  = state.editing ? state.editing.steps.filter(s => s > 0).length : 0;
  const cpBtn   = document.querySelector('[data-action="route-mode-checkpoint"]');
  if (cpBtn && nSteps > 0) {
    cpBtn.textContent = `Checkpoint (${re.checkpoints.length}/${nSteps})`;
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', onAction);
  });

  document.querySelectorAll('.time-input').forEach(inp => {
    inp.addEventListener('blur', e => {
      const i = parseInt(e.target.dataset.step);
      state.editing.steps[i] = parseTimeInput(e.target.value);
      updateTotalDisplay();
    });
  });

  document.querySelectorAll('.dist-input').forEach(inp => {
    inp.addEventListener('blur', e => {
      const i = parseInt(e.target.dataset.step);
      if (!state.editing.distances) state.editing.distances = state.editing.steps.map(() => 0);
      state.editing.distances[i] = parseInt(e.target.value) || 0;
      updateTotalDisplay();
    });
  });

  const importInput = document.getElementById('import-file-input');
  if (importInput) {
    importInput.addEventListener('change', e => {
      if (e.target.files[0]) importFromFile(e.target.files[0]);
    });
  }

  document.querySelectorAll('.btn-remove-step').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.step);
      if (state.editing.steps.length > 1) {
        readStepInputs();
        state.editing.steps.splice(i, 1);
        if (state.editing.distances) state.editing.distances.splice(i, 1);
        render();
      }
    });
  });
}

function updateTotalDisplay() {
  readStepInputs();
  const total     = state.editing.steps.reduce((a, b) => a + b, 0);
  const totalDist = (state.editing.distances || []).reduce((a, b) => a + (b || 0), 0);
  const el = document.querySelector('.total-row');
  if (el) el.innerHTML = `Totale: <strong>${formatCs(total)}</strong>${totalDist > 0 ? ` &nbsp;·&nbsp; <strong>${totalDist} m</strong>` : ''}`;
}

function readStepInputs() {
  document.querySelectorAll('.time-input').forEach(inp => {
    const i = parseInt(inp.dataset.step);
    if (!isNaN(i)) state.editing.steps[i] = parseTimeInput(inp.value);
  });
  if (!state.editing.distances) state.editing.distances = state.editing.steps.map(() => 0);
  document.querySelectorAll('.dist-input').forEach(inp => {
    const i = parseInt(inp.dataset.step);
    if (!isNaN(i)) state.editing.distances[i] = parseInt(inp.value) || 0;
  });
}

function onAction(e) {
  const action = e.currentTarget.dataset.action;
  const idx    = e.currentTarget.dataset.index !== undefined
                   ? parseInt(e.currentTarget.dataset.index) : null;

  getAudio();

  switch (action) {
    case 'theme': {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, state.theme);
      render();
      break;
    }
    case 'new': {
      state.editing = { name: '', steps: [0], distances: [0], isNew: true };
      navigate('config');
      break;
    }
    case 'edit': {
      const src = state.presets[idx];
      state.editing = {
        ...src,
        steps:     [...src.steps],
        distances: [...presetDistances(src)],
        route:     src.route ? JSON.parse(JSON.stringify(src.route)) : null,
        isNew:     false,
        originalIndex: idx,
      };
      navigate('config');
      break;
    }
    case 'delete': {
      const name = state.presets[idx].name;
      if (confirm(`Eliminare "${name}"?`)) {
        state.presets.splice(idx, 1);
        savePresets();
        render();
      }
      break;
    }
    case 'start': {
      startRace(state.presets[idx]);
      break;
    }
    case 'back': {
      state.editing = null;
      navigate('home');
      break;
    }
    case 'save': {
      saveConfig();
      break;
    }
    case 'add-step': {
      readStepInputs();
      state.editing.steps.push(0);
      if (!state.editing.distances) state.editing.distances = state.editing.steps.map(() => 0);
      state.editing.distances.push(0);
      render();
      break;
    }
    case 'next':  { pressNext();  break; }
    case 'undo':  { pressUndo();  break; }
    case 'home': {
      stopGpsTracking();
      state.race = null;
      stopRaf();
      navigate('home');
      break;
    }
    case 'share':      { sharePreset(idx);   break; }
    case 'export-all': { exportAllPresets(); break; }

    case 'edit-route': {
      readStepInputs();
      const existing = state.editing.route || { path: [], checkpoints: [] };
      state.routeEditor = {
        mode:          'path',
        waypoints:     existing.path ? existing.path.map(p => [...p]) : [],
        tapBoundaries: [],      // [] = can't undo the base path; filled as user taps
        checkpoints:   existing.checkpoints ? existing.checkpoints.map(p => [...p]) : [],
        loading:       false,
        leafletMap:    null,
        pathLine:      null,
        dotMarkers:    [],
        cpMarkers:     [],
      };
      navigate('route-editor');
      break;
    }
    case 'route-back': {
      if (state.routeEditor && state.routeEditor.leafletMap) state.routeEditor.leafletMap.remove();
      state.routeEditor = null;
      navigate('config');
      break;
    }
    case 'route-save': {
      const re = state.routeEditor;
      if (re) {
        state.editing.route = { path: re.waypoints, checkpoints: re.checkpoints };
        if (re.leafletMap) re.leafletMap.remove();
      }
      state.routeEditor = null;
      navigate('config');
      break;
    }
    case 'route-mode-path': {
      state.routeEditor.mode = 'path';
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      break;
    }
    case 'route-mode-checkpoint': {
      state.routeEditor.mode = 'checkpoint';
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      break;
    }
    case 'route-undo': {
      const re = state.routeEditor;
      if (!re || re.loading) break;
      if (re.mode === 'path') {
        if (re.tapBoundaries.length === 0) break;  // can't undo base path
        const boundary = re.tapBoundaries.pop();
        re.waypoints = re.waypoints.slice(0, boundary);
        re.pathLine.setLatLngs(re.waypoints);
        const dot = re.dotMarkers.pop();
        if (dot) re.leafletMap.removeLayer(dot);
      } else {
        if (re.checkpoints.length === 0) break;
        re.checkpoints.pop();
        const mk = re.cpMarkers.pop();
        if (mk) re.leafletMap.removeLayer(mk);
        updateRouteEditorHeader();
      }
      break;
    }
    case 'route-clear': {
      const re = state.routeEditor;
      if (!re || !re.leafletMap || re.loading) break;
      const what = re.mode === 'path' ? 'il tracciato' : 'i checkpoint';
      if (!confirm(`Cancellare tutto ${what}?`)) break;
      if (re.mode === 'path') {
        re.waypoints = [];
        re.tapBoundaries = [];
        re.pathLine.setLatLngs([]);
        re.dotMarkers.forEach(d => re.leafletMap.removeLayer(d));
        re.dotMarkers = [];
      } else {
        re.checkpoints = [];
        re.cpMarkers.forEach(m => re.leafletMap.removeLayer(m));
        re.cpMarkers = [];
        updateRouteEditorHeader();
      }
      break;
    }
  }
}

function saveConfig() {
  readStepInputs();
  const nameEl = document.getElementById('preset-name');
  const name   = nameEl ? nameEl.value.trim() : '';
  const steps  = state.editing.steps.filter((s, i) => s > 0 || (state.editing.distances && state.editing.distances[i] > 0));
  const validIdx = state.editing.steps.map((s, i) => s > 0 ? i : -1).filter(i => i >= 0);
  const filteredSteps = validIdx.map(i => state.editing.steps[i]);
  const filteredDists = validIdx.map(i => (state.editing.distances || [])[i] || 0);

  if (!name) { alert('Inserisci un nome per il preset.'); nameEl && nameEl.focus(); return; }
  if (filteredSteps.length === 0) { alert('Aggiungi almeno uno step con tempo maggiore di zero.'); return; }

  const preset = {
    id:        state.editing.id || Date.now(),
    name,
    steps:     filteredSteps,
    distances: filteredDists,
    route:     state.editing.route || null,
  };

  if (state.editing.isNew) {
    state.presets.push(preset);
  } else {
    state.presets[state.editing.originalIndex] = preset;
  }

  savePresets();
  state.editing = null;
  navigate('home');
}

// ── Security helpers ──────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Share / Export / Import ───────────────────────────────────────────────────
function sharePreset(idx) {
  const { name, steps, distances } = state.presets[idx];
  const data = { name, steps, distances: distances || steps.map(() => 0) };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = `${location.origin}${location.pathname}#share=${encoded}`;
  navigator.clipboard.writeText(url)
    .then(() => alert(`Link copiato negli appunti!\nInvialo all'altro dispositivo.`))
    .catch(() => prompt('Copia questo link:', url));
}

function exportAllPresets() {
  if (state.presets.length === 0) { alert('Nessun preset da esportare.'); return; }
  const json = JSON.stringify({ version: 2, presets: state.presets }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'rally-timer-presets.json';
  a.click();
}

function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const list = Array.isArray(data.presets) ? data.presets
                 : Array.isArray(data)          ? data : [];
      if (list.length === 0) { alert('Nessun preset trovato nel file.'); return; }
      mergeImportedPresets(list, `${list.length} preset dal file`);
    } catch (_) { alert('File non valido o corrotto.'); }
  };
  reader.readAsText(file);
}

function checkUrlShare() {
  const hash = location.hash;
  if (!hash.startsWith('#share=')) return;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(hash.slice(7)))));
    if (!data.name || !Array.isArray(data.steps) || data.steps.length === 0) return;
    history.replaceState(null, '', location.pathname);
    mergeImportedPresets([data], `"${data.name}"`);
  } catch (_) {}
}

function mergeImportedPresets(list, label) {
  if (!confirm(`Importare ${label}?\nI preset con lo stesso nome verranno sostituiti.`)) return;
  list.forEach(p => {
    if (!p.name || !Array.isArray(p.steps) || p.steps.length === 0) return;
    const idx = state.presets.findIndex(x => x.name === p.name);
    const preset = {
      id:        Date.now() + Math.random(),
      name:      p.name,
      steps:     p.steps,
      distances: p.distances || p.steps.map(() => 0),
      route:     p.route || null,
    };
    if (idx >= 0) {
      state.presets[idx] = { ...preset, id: state.presets[idx].id };
    } else {
      state.presets.push(preset);
    }
  });
  savePresets();
  render();
}

// ── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
checkUrlShare();
render();
