'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'rally-timer-presets';
const THEME_KEY   = 'rally-timer-theme';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  screen:  'home',
  theme:   localStorage.getItem(THEME_KEY) || 'dark',
  presets: JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
  editing: null,
  race:    null,
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
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) {}
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'race') {
    acquireWakeLock();
  }
});

// ── Time Utils ───────────────────────────────────────────────────────────────
// Parse "MM:SS:CC" or "SS:CC" or "SS" → centesimi integer
function parseTimeInput(str) {
  const parts = String(str).trim().split(':').map(p => parseInt(p) || 0);
  if (parts.length === 1) return parts[0] * 100;
  if (parts.length === 2) return parts[0] * 100 + parts[1];
  return parts[0] * 6000 + parts[1] * 100 + parts[2];
}

// centesimi → "SS.cc" or "M:SS.cc"
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

// centesimi → input value "MM:SS:CC" or "SS:CC"
function csToInput(cs) {
  if (!cs) return '';
  const mm  = Math.floor(cs / 6000);
  const ss  = Math.floor((cs % 6000) / 100);
  const cc  = cs % 100;
  const ccStr = String(cc).padStart(2, '0');
  if (mm > 0) return `${mm}:${String(ss).padStart(2,'0')}:${ccStr}`;
  return `${ss}:${ccStr}`;
}

// centesimi delta → "+1.23" / "-0.45"
function formatDelta(cs) {
  const sign = cs >= 0 ? '+' : '';
  return sign + (cs / 100).toFixed(2);
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
  const deltaCs   = elapsedCs - targetCs;

  const deltaEl = document.getElementById('race-delta');
  const stepEl  = document.getElementById('race-step');
  if (deltaEl) deltaEl.textContent = formatDelta(deltaCs);
  if (stepEl)  stepEl.textContent  = `Step ${race.stepIndex + 1} / ${race.preset.steps.length}`;
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
  };
  state.race.stepHistory.push(state.race.stepStartMs);
  scheduleBeeps();
  acquireWakeLock();
  navigate('race');
  startRaf();
}

function scheduleBeeps() {
  const race = state.race;
  race.beepIds.forEach(clearTimeout);
  race.beepIds = [];
  const targetMs  = race.preset.steps[race.stepIndex] * 10;
  const elapsedMs = performance.now() - race.stepStartMs;
  [3000, 2000, 1000].forEach(ms => {
    const delay = targetMs - elapsedMs - ms;
    if (delay > 0) {
      race.beepIds.push(setTimeout(() => beep(880, 0.1), delay));
    }
  });
}

function pressNext() {
  const race = state.race;
  const now  = performance.now();
  const actualCs = Math.round((now - race.stepStartMs) / 10);
  const targetCs = race.preset.steps[race.stepIndex];

  race.beepIds.forEach(clearTimeout);
  race.beepIds = [];
  race.results.push({ targetCs, actualCs });

  const isLast = race.stepIndex >= race.preset.steps.length - 1;
  if (isLast) {
    stopRaf();
    releaseWakeLock();
    navigate('results');
    return;
  }

  race.stepIndex++;
  race.stepStartMs = now;
  race.stepHistory.push(race.stepStartMs);
  scheduleBeeps();
  render();
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
  scheduleBeeps();
  render();
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
    case 'home':    app.innerHTML = renderHome();    break;
    case 'config':  app.innerHTML = renderConfig();  break;
    case 'race':    app.innerHTML = renderRace();    break;
    case 'results': app.innerHTML = renderResults(); break;
  }
  bindEvents();
}

// ── Home ──────────────────────────────────────────────────────────────────────
function renderHome() {
  const icon = state.theme === 'dark' ? '☀️' : '🌙';
  const list = state.presets.length === 0
    ? `<p class="empty">Nessun preset salvato. Creane uno!</p>`
    : state.presets.map((p, i) => {
        const total = p.steps.reduce((a, b) => a + b, 0);
        return `
          <div class="preset-card">
            <div class="preset-info">
              <span class="preset-name">${escHtml(p.name)}</span>
              <span class="preset-steps">${p.steps.length} step &middot; ${formatCs(total)}</span>
            </div>
            <div class="preset-actions">
              <button class="btn-icon" data-action="edit" data-index="${i}" title="Modifica">✏️</button>
              <button class="btn-icon" data-action="delete" data-index="${i}" title="Elimina">🗑️</button>
              <button class="btn-start" data-action="start" data-index="${i}" title="Avvia">▶</button>
            </div>
          </div>`;
      }).join('');

  return `
    <div class="screen home-screen">
      <header>
        <h1>Rally Timer</h1>
        <button class="btn-icon" data-action="theme" title="Tema">${icon}</button>
      </header>
      <div class="preset-list">${list}</div>
      <button class="btn-primary" data-action="new">+ Nuovo Preset</button>
    </div>`;
}

// ── Config ────────────────────────────────────────────────────────────────────
function renderConfig() {
  const p = state.editing;
  const stepsHtml = p.steps.map((cs, i) => `
    <div class="step-row">
      <label>Step ${i + 1}</label>
      <input type="text" inputmode="text" class="time-input" data-step="${i}"
             value="${csToInput(cs)}" placeholder="SS:CC" />
      <button class="btn-remove-step" data-step="${i}" title="Rimuovi">✕</button>
    </div>`).join('');

  const total = p.steps.reduce((a, b) => a + b, 0);
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
      <div class="steps-list">${stepsHtml}</div>
      ${addBtn}
      <div class="total-row">Totale: <strong>${formatCs(total)}</strong></div>
    </div>`;
}

// ── Race ──────────────────────────────────────────────────────────────────────
function renderRace() {
  const race   = state.race;
  const isFirst = race.stepIndex === 0 && race.results.length === 0;
  const isLast  = race.stepIndex >= race.preset.steps.length - 1;
  const targetCs = race.preset.steps[race.stepIndex];
  const initDelta = formatDelta(-targetCs);

  return `
    <div class="screen race-screen">
      <div class="race-header">
        <span id="race-step">Step ${race.stepIndex + 1} / ${race.preset.steps.length}</span>
        <span class="preset-label">${escHtml(race.preset.name)}</span>
      </div>
      <div class="race-delta-wrapper">
        <div id="race-delta" class="race-delta">${initDelta}</div>
        <div class="race-delta-label">secondi</div>
      </div>
      <div class="race-buttons">
        <button class="btn-undo" data-action="undo" ${isFirst ? 'disabled' : ''}>◀ UNDO</button>
        <button class="btn-next" data-action="next">${isLast ? '■ FINE' : '▶ AVANTI'}</button>
      </div>
    </div>`;
}

// ── Results ───────────────────────────────────────────────────────────────────
function renderResults() {
  const { results, preset } = state.race;
  const rows = results.map((r, i) => {
    const d    = r.actualCs - r.targetCs;
    const cls  = d > 0 ? 'late' : d < 0 ? 'early' : 'exact';
    const sign = d >= 0 ? '+' : '';
    return `
      <tr>
        <td>Step ${i + 1}</td>
        <td>${formatCs(r.targetCs)}</td>
        <td>${formatCs(r.actualCs)}</td>
        <td class="${cls}">${sign}${(d / 100).toFixed(2)}s</td>
      </tr>`;
  }).join('');

  const totTarget = results.reduce((a, r) => a + r.targetCs, 0);
  const totActual = results.reduce((a, r) => a + r.actualCs, 0);
  const totDelta  = totActual - totTarget;
  const totCls    = totDelta > 0 ? 'late' : totDelta < 0 ? 'early' : 'exact';
  const totSign   = totDelta >= 0 ? '+' : '';

  return `
    <div class="screen results-screen">
      <header>
        <h2>Risultati — ${escHtml(preset.name)}</h2>
      </header>
      <table class="results-table">
        <thead><tr><th>Step</th><th>Target</th><th>Reale</th><th>Delta</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td><strong>Totale</strong></td>
            <td>${formatCs(totTarget)}</td>
            <td>${formatCs(totActual)}</td>
            <td class="${totCls}"><strong>${totSign}${(totDelta / 100).toFixed(2)}s</strong></td>
          </tr>
        </tfoot>
      </table>
      <button class="btn-primary" data-action="home">← Home</button>
    </div>`;
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

  document.querySelectorAll('.btn-remove-step').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.step);
      if (state.editing.steps.length > 1) {
        readStepInputs();
        state.editing.steps.splice(i, 1);
        render();
      }
    });
  });
}

function updateTotalDisplay() {
  readStepInputs();
  const total = state.editing.steps.reduce((a, b) => a + b, 0);
  const el = document.querySelector('.total-row strong');
  if (el) el.textContent = formatCs(total);
}

function readStepInputs() {
  document.querySelectorAll('.time-input').forEach(inp => {
    const i = parseInt(inp.dataset.step);
    if (!isNaN(i)) state.editing.steps[i] = parseTimeInput(inp.value);
  });
}

function onAction(e) {
  const action = e.currentTarget.dataset.action;
  const idx    = e.currentTarget.dataset.index !== undefined
                   ? parseInt(e.currentTarget.dataset.index) : null;

  // Unlock audio on first gesture
  getAudio();

  switch (action) {
    case 'theme': {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, state.theme);
      render();
      break;
    }
    case 'new': {
      state.editing = { name: '', steps: [0], isNew: true };
      navigate('config');
      break;
    }
    case 'edit': {
      const src = state.presets[idx];
      state.editing = { ...src, steps: [...src.steps], isNew: false, originalIndex: idx };
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
      render();
      break;
    }
    case 'next': {
      pressNext();
      break;
    }
    case 'undo': {
      pressUndo();
      break;
    }
    case 'home': {
      state.race = null;
      stopRaf();
      navigate('home');
      break;
    }
  }
}

function saveConfig() {
  readStepInputs();
  const nameEl = document.getElementById('preset-name');
  const name   = nameEl ? nameEl.value.trim() : '';
  const steps  = state.editing.steps.filter(s => s > 0);

  if (!name) { alert('Inserisci un nome per il preset.'); nameEl && nameEl.focus(); return; }
  if (steps.length === 0) { alert('Aggiungi almeno uno step con tempo maggiore di zero.'); return; }

  const preset = {
    id:    state.editing.id || Date.now(),
    name,
    steps,
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

// ── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
