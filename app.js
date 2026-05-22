// ── Constants ──────────────────────────────────────────────────────────────────
const COLOR_PALETTE = ["#FF6B6B","#4ECDC4","#45B7D1","#FFA07A","#98D8C8","#F7DC6F","#BB8FCE","#85C1E2"];

const PRESETS = {
  "Tandarts Basis":           { monthly_premium: 15,  coverage_pct: 75,  max_coverage: 250, projected_cost: 150 },
  "Tandarts Plus":            { monthly_premium: 25,  coverage_pct: 100, max_coverage: 500, projected_cost: 250 },
  "Fysiotherapie":            { monthly_premium: 12,  coverage_pct: 80,  max_coverage: 400, projected_cost: 200 },
  "Alternatieve Geneeskunde": { monthly_premium: 10,  coverage_pct: 75,  max_coverage: 300, projected_cost: 100 },
  "Bril/Lenzen":              { monthly_premium: 8,   coverage_pct: 100, max_coverage: 150, projected_cost: 150 },
};

const STORAGE_KEY = "zorgverzekering_data";

// ── State ─────────────────────────────────────────────────────────────────────
let state = { base_monthly: 135, insurances: [] };

// ── Formatting helpers ─────────────────────────────────────────────────────────
function fEuro(v) { return "€\u00A0" + v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
function fShort(v) { return "€" + Math.round(v).toLocaleString("nl-NL"); }
function esc(s)   { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ── Calculation logic (mirrors the Python backend) ────────────────────────────
function calcCoverage(ins) {
  if (!ins.enabled) return 0;
  return Math.min(ins.projected_cost * (ins.coverage_pct / 100), ins.max_coverage);
}

function yearlyPremium(ins) {
  return ins.enabled ? ins.monthly_premium * 12 : 0;
}

function breakEven(ins) {
  if (!ins.enabled || ins.coverage_pct <= 0) return null;
  const p = yearlyPremium(ins);
  const r = ins.coverage_pct / 100;
  if (ins.max_coverage <= p) return null;
  return p / r;
}

function roiPct(ins) {
  const cov  = calcCoverage(ins);
  const prem = yearlyPremium(ins);
  if (prem === 0) return 0;
  return ((cov - prem) / prem) * 100;
}

function computeResults(state) {
  const active       = state.insurances.filter(i => i.enabled);
  const baseYearly   = state.base_monthly * 12;
  const totalPremiums = active.reduce((s, i) => s + yearlyPremium(i), 0);
  const totalCovered  = active.reduce((s, i) => s + calcCoverage(i), 0);
  const totalProjected = active.reduce((s, i) => s + i.projected_cost, 0);
  const totalWithout  = baseYearly + totalProjected;
  const totalWith     = baseYearly + totalPremiums + (totalProjected - totalCovered);

  const perInsurance = [...active]
    .sort((a, b) => roiPct(b) - roiPct(a))
    .map(ins => {
      const cov  = calcCoverage(ins);
      const cost = yearlyPremium(ins);
      return {
        name:        ins.name,
        color:       ins.color || "#4ECDC4",
        roi:         roiPct(ins),
        break_even:  breakEven(ins),
        coverage:    cov,
        yearly_cost: cost,
        benefit:     cov - cost,
        projected:   ins.projected_cost,
      };
    });

  return {
    base_yearly:    baseYearly,
    total_without:  totalWithout,
    total_with:     totalWith,
    total_covered:  totalCovered,
    total_premiums: totalPremiums,
    diff:           totalWithout - totalWith,
    net_benefit:    totalCovered - totalPremiums,
    per_insurance:  perInsurance,
  };
}

function computeGraphData(state, xMin = null, xMax = null) {
  const active = state.insurances.filter(i => i.enabled);
  if (!active.length) return null;

  const baseYearly         = state.base_monthly * 12;
  const totalYearlyPremium = active.reduce((s, i) => s + i.monthly_premium, 0) * 12;
  const totalMaxCoverage   = active.reduce((s, i) => s + i.max_coverage, 0);
  const maxProjected       = Math.max(...active.map(i => i.projected_cost));
  const defaultMax         = Math.max(2.3 * maxProjected, totalMaxCoverage * 2.3, 2000);

  const effectiveXMin = Math.max(0, xMin ?? 0);
  const effectiveXMax = Math.max(effectiveXMin + 100, xMax ?? defaultMax);
  const totalProjectedCosts = active.reduce((s, i) => s + i.projected_cost, 0);

  // Generate 300 evenly-spaced x points
  const x = Array.from({ length: 300 }, (_, i) =>
    effectiveXMin + (effectiveXMax - effectiveXMin) * i / 299
  );

  const without = [], withArr = [], savings = [];
  for (const xi of x) {
    const m = totalProjectedCosts > 0 ? xi / totalProjectedCosts : 0;
    const covered = active.reduce((s, ins) =>
      s + Math.min(ins.projected_cost * m * (ins.coverage_pct / 100), ins.max_coverage), 0);
    without.push(baseYearly + xi);
    withArr.push(baseYearly + totalYearlyPremium + totalProjectedCosts * m - covered);
    savings.push(covered - totalYearlyPremium);
  }

  const indLines = active.map(ins => ({
    name:  ins.name,
    color: ins.color || "#999",
    data:  x.map(xi => {
      const m  = totalProjectedCosts > 0 ? xi / totalProjectedCosts : 0;
      const ac = Math.min(ins.projected_cost * m * (ins.coverage_pct / 100), ins.max_coverage);
      return baseYearly + yearlyPremium(ins) + totalProjectedCosts * m - ac;
    }),
  }));

  // Crossover detection
  const diffArr = withArr.map((w, i) => w - without[i]);
  const crosses = x.filter((_, i) => i < diffArr.length - 1 && diffArr[i] * diffArr[i+1] < 0);
  const lowerCross = (crosses.length && diffArr[0] >= 0) ? Math.min(...crosses) : null;

  const caps = active
    .filter(ins => ins.projected_cost > 0 && ins.coverage_pct > 0)
    .map(ins => (ins.max_coverage / (ins.coverage_pct / 100)) / ins.projected_cost);
  const plateauStart = caps.length ? Math.max(...caps) * totalProjectedCosts : null;

  const allY = [...without, ...withArr];
  return {
    x, without, with: withArr, savings, ind_lines: indLines,
    lower_cross: lowerCross, plateau_start: plateauStart,
    total_yearly_premium: totalYearlyPremium,
    total_max_coverage: totalMaxCoverage,
    default_max: defaultMax,
    x_min: effectiveXMin, x_max: effectiveXMax,
    auto_y_min: Math.min(...allY),
    auto_y_max: Math.max(...allY),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { base_monthly: 135, insurances: [] };
}

function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  const data = loadData();
  state.base_monthly = data.base_monthly ?? 135;
  state.insurances   = Array.isArray(data.insurances) ? data.insurances : [];
  document.getElementById("base-monthly").value = state.base_monthly;
  render();
}

function persist() {
  saveData(state);
  showToast("Opgeslagen ✓");
}

function render() {
  renderInsuranceList();
  refreshResults();
}

// ── Insurance list UI ─────────────────────────────────────────────────────────
function renderInsuranceList() {
  const el = document.getElementById("ins-list");
  if (!state.insurances.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:.85rem;padding:8px 0;">Geen verzekeringen toegevoegd.</p>';
    return;
  }
  el.innerHTML = state.insurances.map((ins, i) => `
    <div class="ins-row ${ins.enabled ? "" : "disabled"}">
      <div class="ins-dot" style="background:${ins.color}"></div>
      <div style="flex:1;min-width:0;">
        <div class="ins-name">${esc(ins.name)}</div>
        <div class="ins-sub">€${ins.monthly_premium}/mnd · ${ins.coverage_pct}% · max €${ins.max_coverage}</div>
      </div>
      <button class="toggle-btn ${ins.enabled ? "toggle-on" : "toggle-off"}" onclick="toggleIns(${i})">${ins.enabled ? "Aan" : "Uit"}</button>
      <button class="btn btn-secondary btn-sm" onclick="openEditModal(${i})">✎</button>
      <button class="btn btn-danger btn-sm"    onclick="deleteIns(${i})">×</button>
    </div>`).join("");
}

// ── Results UI ────────────────────────────────────────────────────────────────
function refreshResults() {
  const baseEl  = document.getElementById("base-monthly");
  if (document.activeElement !== baseEl) baseEl.value = state.base_monthly;

  const active = state.insurances.filter(i => i.enabled);
  if (!active.length) {
    ["r-without","r-with","r-covered","r-premiums"].forEach(id =>
      document.getElementById(id).textContent = "—");
    setVerdict("empty", "Voeg verzekeringen toe");
    document.getElementById("rend-list").innerHTML =
      '<p style="color:var(--muted);font-size:.85rem;">Geen actieve verzekeringen.</p>';
    clearChart();
    document.getElementById("summary-content").innerHTML =
      '<p style="color:var(--muted);font-size:.875rem;padding:40px 0;text-align:center;">Voeg een of meer actieve verzekeringen toe.</p>';
    return;
  }

  const d = computeResults(state);
  document.getElementById("r-without").textContent  = fEuro(d.total_without);
  document.getElementById("r-with").textContent     = fEuro(d.total_with);
  document.getElementById("r-covered").textContent  = fEuro(d.total_covered);
  document.getElementById("r-premiums").textContent = fEuro(d.total_premiums);

  if      (d.diff >  0) setVerdict("good", "💰 Bespaar ± " + fEuro(d.diff) + "/jaar");
  else if (d.diff <  0) setVerdict("bad",  "⚠️ Zonder is ± " + fEuro(-d.diff) + " goedkoper");
  else                   setVerdict("meh",  "Ongeveer gelijk");

  renderRend(d.per_insurance);
  renderChart();
  renderSummary(d);
}

function setVerdict(cls, txt) {
  const el = document.getElementById("verdict");
  el.className = "verdict " + cls;
  el.textContent = txt;
}

function renderRend(list) {
  if (!list.length) {
    document.getElementById("rend-list").innerHTML =
      '<p style="color:var(--muted);font-size:.85rem;">Geen actieve verzekeringen.</p>';
    return;
  }
  document.getElementById("rend-list").innerHTML = list.map(ins => {
    let icon, color;
    if      (ins.roi >    0) { icon = "✓"; color = ins.color; }
    else if (ins.roi < -10)  { icon = "✗"; color = "#dc2626"; }
    else                      { icon = "≈"; color = "#6b7280"; }
    const be = ins.break_even ? "Break-even bij " + fEuro(ins.break_even) : "Nooit rendabel";
    return `<div class="rend-row">
      <span style="color:${color};font-size:1rem;width:20px;">${icon}</span>
      <div class="rend-info"><strong>${esc(ins.name)}</strong><div style="font-size:.78rem;color:var(--muted);">${be}</div></div>
      <span class="rend-roi" style="color:${color}">${ins.roi >= 0 ? "+" : ""}${ins.roi.toFixed(0)}%</span>
    </div>`;
  }).join("");
}

// ── Summary UI ────────────────────────────────────────────────────────────────
function renderSummary(d) {
  const active = state.insurances.filter(i => i.enabled);
  const by = state.base_monthly * 12;
  let html = `<div class="summary-section"><h3>Overzicht</h3>
    <div class="summary-kv"><span class="k">Actieve verzekeringen</span><span class="v">${active.map(i => esc(i.name)).join(", ")}</span></div>
    <div class="summary-kv"><span class="k">Basisverzekering/jaar</span><span class="v">${fEuro(by)}</span></div>
    <div class="summary-kv"><span class="k">Aanvullende premies/jaar</span><span class="v">${fEuro(d.total_premiums)}</span></div>
    <div class="summary-kv"><span class="k">Maximale vergoeding</span><span class="v">${fEuro(active.reduce((s,i) => s + i.max_coverage, 0))}</span></div>
  </div>
  <div class="summary-section"><h3>Verwacht dit jaar</h3>
    <div class="summary-kv"><span class="k">Aanvullende zorgkosten</span><span class="v">${fEuro(active.reduce((s,i) => s + i.projected_cost, 0))}</span></div>
    <div class="summary-kv"><span class="k">Verwachte vergoeding</span><span class="v">${fEuro(d.total_covered)}</span></div>
    <div class="summary-kv"><span class="k">Netto resultaat</span><span class="v" style="color:${d.net_benefit >= 0 ? "var(--green)" : "var(--red)"}">${fEuro(d.net_benefit)}</span></div>
  </div>`;

  let ac, at;
  if      (d.net_benefit >  10) { ac = "good"; at = "✓ RENDABEL — Je spaart ≈ " + fEuro(d.net_benefit) + "/jaar!"; }
  else if (d.net_benefit >= -10) { ac = "meh";  at = "≈ BREAK-EVEN — Verschil: " + fEuro(d.net_benefit) + "."; }
  else                            { ac = "bad";  at = "✗ NIET RENDABEL — Je betaalt ≈ " + fEuro(-d.net_benefit) + " meer dan je terugkrijgt."; }
  html += `<div class="verdict ${ac}" style="margin-top:14px;">${at}</div>`;

  html += `<div class="summary-section"><h3>Per verzekering</h3>`;
  d.per_insurance.forEach(ins => {
    const status = ins.break_even
      ? (ins.projected >= ins.break_even ? "✓ Rendabel" : "✗ Break-even bij " + fEuro(ins.break_even))
      : "✗ Nooit rendabel";
    const mnd = state.insurances.find(i => i.name === ins.name)?.monthly_premium ?? 0;
    html += `<div class="ins-summary-card">
      <h4><span style="color:${ins.color}">●</span> ${esc(ins.name)}</h4>
      <div class="summary-kv"><span class="k">Maandpremie</span><span class="v">€${mnd}/mnd (${fEuro(ins.yearly_cost)}/jaar)</span></div>
      <div class="summary-kv"><span class="k">Verwachte vergoeding</span><span class="v">${fEuro(ins.coverage)}</span></div>
      <div class="summary-kv"><span class="k">Resultaat</span><span class="v" style="color:${ins.benefit >= 0 ? "var(--green)" : "var(--red)"}">${fEuro(ins.benefit)} (ROI: ${ins.roi >= 0 ? "+" : ""}${ins.roi.toFixed(0)}%)</span></div>
      <div class="summary-kv"><span class="k">Status</span><span class="v">${status}</span></div>
    </div>`;
  });
  html += `</div>`;
  document.getElementById("summary-content").innerHTML = html;
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openAddModal() {
  document.getElementById("modal-title").textContent = "Verzekering Toevoegen";
  document.getElementById("edit-index").value = -1;
  document.getElementById("e-name").value    = "Tandarts";
  document.getElementById("e-monthly").value = 20;
  document.getElementById("e-pct").value     = 75;
  document.getElementById("e-max").value     = 250;
  document.getElementById("e-proj").value    = 150;
  updatePreview();
  document.getElementById("modal-edit").classList.remove("hidden");
}

function openEditModal(i) {
  const ins = state.insurances[i];
  document.getElementById("modal-title").textContent = "Verzekering Bewerken";
  document.getElementById("edit-index").value = i;
  document.getElementById("e-name").value     = ins.name;
  document.getElementById("e-monthly").value  = ins.monthly_premium;
  document.getElementById("e-pct").value      = ins.coverage_pct;
  document.getElementById("e-max").value      = ins.max_coverage;
  document.getElementById("e-proj").value     = ins.projected_cost;
  updatePreview();
  document.getElementById("modal-edit").classList.remove("hidden");
}

function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

function updatePreview() {
  const monthly = parseFloat(document.getElementById("e-monthly").value) || 0;
  const pct     = parseFloat(document.getElementById("e-pct").value)     || 0;
  const max     = parseFloat(document.getElementById("e-max").value)     || 0;
  const proj    = parseFloat(document.getElementById("e-proj").value)    || 0;
  const net     = Math.min(proj * pct / 100, max) - monthly * 12;
  const el      = document.getElementById("preview-badge");
  if      (net >  0) { el.className = "preview-badge good"; el.textContent = "💰 Verwacht voordeel: " + fEuro(net) + "/jaar"; }
  else if (net <  0) { el.className = "preview-badge bad";  el.textContent = "⚠️ Verwacht nadeel: "  + fEuro(-net) + "/jaar"; }
  else                { el.className = "preview-badge meh";  el.textContent = "Ongeveer break-even"; }
}

function saveInsurance() {
  const idx     = parseInt(document.getElementById("edit-index").value);
  const name    = document.getElementById("e-name").value.trim()  || "Onbenoemd";
  const monthly = parseFloat(document.getElementById("e-monthly").value) || 0;
  const pct     = parseFloat(document.getElementById("e-pct").value)     || 0;
  const max     = parseFloat(document.getElementById("e-max").value)     || 0;
  const proj    = parseFloat(document.getElementById("e-proj").value)    || 0;

  if (idx >= 0) {
    Object.assign(state.insurances[idx], { name, monthly_premium: monthly, coverage_pct: pct, max_coverage: max, projected_cost: proj });
  } else {
    state.insurances.push({
      name, monthly_premium: monthly, coverage_pct: pct, max_coverage: max, projected_cost: proj,
      enabled: true, color: COLOR_PALETTE[state.insurances.length % COLOR_PALETTE.length],
    });
  }
  closeModal("modal-edit");
  render();
  persist();
}

function toggleIns(i) { state.insurances[i].enabled = !state.insurances[i].enabled; render(); persist(); }

function deleteIns(i) {
  if (!confirm('"' + state.insurances[i].name + '" verwijderen?')) return;
  state.insurances.splice(i, 1);
  render();
  persist();
}

function resetAll() {
  if (!confirm("Alle gegevens wissen?")) return;
  state = { base_monthly: 135, insurances: [] };
  document.getElementById("base-monthly").value = 135;
  render();
  persist();
}

// ── Presets ───────────────────────────────────────────────────────────────────
let loadedPresets = {};

function openPresetModal() {
  loadedPresets = PRESETS;
  document.getElementById("preset-list").innerHTML = Object.entries(loadedPresets).map(([name, v], idx) => `
    <div class="preset-row">
      <div>
        <strong>${esc(name)}</strong>
        <div class="preset-info">€${v.monthly_premium}/mnd · ${v.coverage_pct}% · max €${v.max_coverage} · verwacht €${v.projected_cost}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="addPreset(${idx})">+ Toevoegen</button>
    </div>`).join("");
  document.getElementById("modal-preset").classList.remove("hidden");
}

function addPreset(idx) {
  const entries = Object.entries(loadedPresets);
  if (idx >= entries.length) return;
  const [name, v] = entries[idx];
  state.insurances.push({
    name, monthly_premium: v.monthly_premium, coverage_pct: v.coverage_pct,
    max_coverage: v.max_coverage, projected_cost: v.projected_cost,
    enabled: true, color: COLOR_PALETTE[state.insurances.length % COLOR_PALETTE.length],
  });
  closeModal("modal-preset");
  render();
  persist();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(t) {
  document.getElementById("tab-graph").classList.toggle("shown",   t === "graph");
  document.getElementById("tab-summary").classList.toggle("shown", t === "summary");
  document.getElementById("t-graph").classList.toggle("active",    t === "graph");
  document.getElementById("t-summary").classList.toggle("active",  t === "summary");
  if (t === "graph") renderChart();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("base-monthly").addEventListener("input", e => {
    state.base_monthly = parseFloat(e.target.value) || 0;
    refreshResults();
    persist();
  });

  document.querySelectorAll(".overlay").forEach(el => {
    el.addEventListener("click", e => { if (e.target === el) el.classList.add("hidden"); });
  });

  init();
});

// ── Config export / import ─────────────────────────────────────────────────────
function exportConfig() {
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    base_monthly: state.base_monthly,
    insurances: state.insurances,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = "zorgverzekering-" + date + ".json";
  a.click();
  URL.revokeObjectURL(url);
  showConfigStatus("Opgeslagen ✓");
}

function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.name.endsWith(".json") && file.type !== "application/json") {
    showConfigStatus("Fout: geen JSON bestand ✗", true);
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data.base_monthly !== "number" || !Array.isArray(data.insurances)) {
        throw new Error("Ongeldig formaat");
      }
      state.base_monthly = data.base_monthly;
      state.insurances   = data.insurances;
      document.getElementById("base-monthly").value = state.base_monthly;
      saveData(state);
      render();
      showConfigStatus("Geladen: " + file.name + " ✓");
    } catch (err) {
      showConfigStatus("Fout bij laden: " + err.message + " ✗", true);
    }
    event.target.value = "";
  };
  reader.readAsText(file);
}

let configStatusTimer;
function showConfigStatus(msg, isError = false) {
  const el = document.getElementById("config-status");
  el.textContent  = msg;
  el.style.color  = isError ? "var(--red)" : "var(--green)";
  el.classList.add("visible");
  clearTimeout(configStatusTimer);
  configStatusTimer = setTimeout(() => el.classList.remove("visible"), 3000);
}

// ── Reset chart zoom (also triggered by double-click on canvas) ───────────────
function resetZoom() {
  if (chartInst) {
    chartInst.resetZoom();
    axis = { xMin: null, xMax: null, yMin: null, yMax: null };
    renderChart();
  }
}
