// ── Chart state ───────────────────────────────────────────────────────────────
let chartInst    = null;
let lastGraphData = null;
let axis         = { xMin: null, xMax: null, yMin: null, yMax: null };
let sliderBounds = { xAbsMin: 0, xAbsMax: 10000, yAbsMin: 0, yAbsMax: 10000 };
let fetchDebounce = null;

// ── Main render entry point ───────────────────────────────────────────────────
function renderChart() {
  const active = state.insurances.filter(i => i.enabled);
  if (!active.length) { clearChart(); return; }

  clearTimeout(fetchDebounce);
  fetchDebounce = setTimeout(() => {
    const g = computeGraphData(
      state,
      axis.xMin !== null ? axis.xMin : null,
      axis.xMax !== null ? axis.xMax : null,
    );
    if (!g) { clearChart(); return; }
    lastGraphData = g;

    document.getElementById("chart-empty").style.display = "none";
    document.getElementById("chart-wrap").style.display  = "block";
    document.getElementById("axis-panel").classList.add("visible");

    // Initialise slider bounds only on very first load
    if (axis.xMin === null && axis.xMax === null && axis.yMin === null && axis.yMax === null) {
      initSliderBounds(g);
    }
    updateSliderUI();
    drawChart(g);
  }, 150);
}

function clearChart() {
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  document.getElementById("chart-empty").style.display = "block";
  document.getElementById("chart-wrap").style.display  = "none";
  document.getElementById("chart-legend").innerHTML    = "";
  document.getElementById("chart-info").textContent    = "";
  document.getElementById("axis-panel").classList.remove("visible");
  axis         = { xMin: null, xMax: null, yMin: null, yMax: null };
  lastGraphData = null;
}

// ── Draw / update the Chart.js instance ──────────────────────────────────────
function drawChart(g) {
  const datasets = [
    { label: "Zonder aanvullend", data: g.without, borderColor: "#ef4444", borderWidth: 2.5, pointRadius: 0, tension: 0.1, fill: false },
    { label: "Met aanvullend",    data: g.with,    borderColor: "#16a34a", borderWidth: 2.5, pointRadius: 0, tension: 0.1, fill: false },
  ];
  g.ind_lines.forEach(line => datasets.push({
    label:       "Alleen " + line.name,
    data:        line.data,
    borderColor: line.color,
    borderWidth: 1.5,
    pointRadius: 0,
    borderDash:  [5, 4],
    tension:     0.1,
    fill:        false,
  }));

  const yMin = axis.yMin !== null ? axis.yMin : undefined;
  const yMax = axis.yMax !== null ? axis.yMax : undefined;

  if (chartInst) chartInst.destroy();
  chartInst = new Chart(document.getElementById("myChart").getContext("2d"), {
    type: "line",
    data: { labels: g.x.map(v => Math.round(v)), datasets },
    options: {
      animation: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items  => "Kosten: €" + parseInt(items[0].label).toLocaleString("nl-NL"),
            label: item   => " " + item.dataset.label + ": €" + item.parsed.y.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, "."),
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: "xy",
            onPanComplete({ chart }) { syncSlidersFromChart(chart); },
          },
          zoom: {
            wheel:  { enabled: true },
            pinch:  { enabled: true },
            drag: {
              enabled:         true,
              modifierKey:     "shift",
              backgroundColor: "rgba(37,99,235,.1)",
              borderColor:     "rgba(37,99,235,.4)",
              borderWidth:     1,
            },
            mode: "xy",
            onZoomComplete({ chart }) { syncSlidersFromChart(chart); },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Verwachte aanvullende zorgkosten per jaar (€)", font: { size: 12, weight: "600" }, color: "#6b7280", padding: { top: 8 } },
          ticks: { maxTicksLimit: 10, callback: (_, i) => "€" + Math.round(g.x[i]).toLocaleString("nl-NL"), maxRotation: 45 },
          grid:  { color: "rgba(0,0,0,.06)" },
        },
        y: {
          min: yMin, max: yMax,
          title: { display: true, text: "Totale jaarlasten (€)", font: { size: 12, weight: "600" }, color: "#6b7280", padding: { bottom: 8 } },
          ticks: { callback: v => "€" + v.toLocaleString("nl-NL") },
          grid:  { color: "rgba(0,0,0,.06)" },
        },
      },
    },
  });

  // Double-click resets zoom
  document.getElementById("myChart").ondblclick = () => {
    if (chartInst) {
      chartInst.resetZoom();
      axis = { xMin: null, xMax: null, yMin: null, yMax: null };
      renderChart();
    }
  };

  // Legend
  document.getElementById("chart-legend").innerHTML = datasets.map(ds =>
    `<div class="chart-legend-item"><div class="chart-legend-dot" style="background:${ds.borderColor}"></div><span>${ds.label}</span></div>`
  ).join("");

  // Info line
  let info = "";
  if (g.lower_cross)   info += "✅ Besparing start vanaf ≈ " + fEuro(g.lower_cross) + " zorgkosten.  ";
  if (g.plateau_start) info += "🔝 Maximale besparing bereikt bij ≈ " + fEuro(g.plateau_start) + ".";
  document.getElementById("chart-info").textContent = info;
}

// ── Axis slider initialisation ────────────────────────────────────────────────
function initSliderBounds(g) {
  const xAbsMax  = Math.ceil(g.default_max * 4 / 100) * 100;
  const allY     = [...g.without, ...g.with];
  const yAbsMin  = Math.floor(Math.min(...allY) / 100) * 100;
  const yAbsMax  = Math.ceil(Math.max(...allY) * 3 / 100) * 100;
  sliderBounds   = { xAbsMin: 0, xAbsMax, yAbsMin, yAbsMax };

  const step = v => Math.max(50, Math.round(v / 300 / 50) * 50);
  setSliderAttrs("x-min-sl", 0,       xAbsMax, step(xAbsMax),           0);
  setSliderAttrs("x-max-sl", 0,       xAbsMax, step(xAbsMax),           Math.round(g.default_max));
  setSliderAttrs("y-min-sl", yAbsMin, yAbsMax, step(yAbsMax - yAbsMin), yAbsMin);
  setSliderAttrs("y-max-sl", yAbsMin, yAbsMax, step(yAbsMax - yAbsMin), Math.round(g.auto_y_max));
}

function setSliderAttrs(id, min, max, step, val) {
  const el = document.getElementById(id);
  el.min = min; el.max = max; el.step = step; el.value = val;
}

// ── Slider UI update ──────────────────────────────────────────────────────────
function updateSliderUI() {
  if (!lastGraphData) return;
  const xMinV = parseInt(document.getElementById("x-min-sl").value);
  const xMaxV = parseInt(document.getElementById("x-max-sl").value);
  const yMinV = parseInt(document.getElementById("y-min-sl").value);
  const yMaxV = parseInt(document.getElementById("y-max-sl").value);
  document.getElementById("x-min-lbl").textContent = fShort(xMinV);
  document.getElementById("x-max-lbl").textContent = fShort(xMaxV);
  document.getElementById("y-min-lbl").textContent = fShort(yMinV);
  document.getElementById("y-max-lbl").textContent = fShort(yMaxV);
  updateFill("dr-x-fill", "x-min-sl", "x-max-sl");
  updateFill("dr-y-fill", "y-min-sl", "y-max-sl");
}

function updateFill(fillId, minId, maxId) {
  const minEl = document.getElementById(minId);
  const maxEl = document.getElementById(maxId);
  const min   = parseFloat(minEl.min);
  const max   = parseFloat(minEl.max);
  const lo    = (parseFloat(minEl.value) - min) / (max - min) * 100;
  const hi    = (parseFloat(maxEl.value) - min) / (max - min) * 100;
  const fill  = document.getElementById(fillId);
  fill.style.left  = lo + "%";
  fill.style.width = (hi - lo) + "%";
}

// ── Dual-range slider interaction ─────────────────────────────────────────────
function onDualRange(axis_id) {
  const minEl = document.getElementById(axis_id + "-min-sl");
  const maxEl = document.getElementById(axis_id + "-max-sl");
  let lo = parseInt(minEl.value);
  let hi = parseInt(maxEl.value);
  const step = parseInt(minEl.step) || 50;

  // Prevent crossover
  if (lo >= hi) {
    if (document.activeElement === minEl) { lo = hi - step; minEl.value = lo; }
    else                                  { hi = lo + step; maxEl.value = hi; }
  }

  if (axis_id === "x") {
    axis.xMin = lo; axis.xMax = hi;
    renderChart();
  } else {
    axis.yMin = lo; axis.yMax = hi;
    if (lastGraphData) drawChart(lastGraphData);
  }
  updateSliderUI();
}

// ── Reset axis button ─────────────────────────────────────────────────────────
function resetAxis(axis_id) {
  if (axis_id === "x") {
    axis.xMin = null; axis.xMax = null;
    if (lastGraphData) {
      document.getElementById("x-min-sl").value = 0;
      document.getElementById("x-max-sl").value = Math.round(lastGraphData.default_max);
    }
    renderChart();
  } else {
    axis.yMin = null; axis.yMax = null;
    if (lastGraphData) {
      const allY = [...lastGraphData.without, ...lastGraphData.with];
      document.getElementById("y-min-sl").value = Math.floor(Math.min(...allY) / 100) * 100;
      document.getElementById("y-max-sl").value = Math.round(lastGraphData.auto_y_max);
      drawChart(lastGraphData);
    }
  }
  updateSliderUI();
}

// ── Sync sliders when user pans/zooms the chart directly ─────────────────────
function syncSlidersFromChart(chart) {
  if (!lastGraphData) return;
  const xScale = chart.scales.x;
  const yScale = chart.scales.y;
  const labels = lastGraphData.x;

  const lo = Math.max(0, Math.floor(xScale.min));
  const hi = Math.min(labels.length - 1, Math.ceil(xScale.max));
  const xMinVal = labels[Math.max(0, lo)]              ?? labels[0];
  const xMaxVal = labels[Math.min(labels.length - 1, hi)] ?? labels[labels.length - 1];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const xMinCl = clamp(Math.round(xMinVal), sliderBounds.xAbsMin, sliderBounds.xAbsMax);
  const xMaxCl = clamp(Math.round(xMaxVal), sliderBounds.xAbsMin, sliderBounds.xAbsMax);
  const yMinCl = clamp(Math.round(yScale.min), sliderBounds.yAbsMin, sliderBounds.yAbsMax);
  const yMaxCl = clamp(Math.round(yScale.max), sliderBounds.yAbsMin, sliderBounds.yAbsMax);

  document.getElementById("x-min-sl").value = xMinCl;
  document.getElementById("x-max-sl").value = xMaxCl;
  document.getElementById("y-min-sl").value = yMinCl;
  document.getElementById("y-max-sl").value = yMaxCl;
  axis.xMin = xMinCl; axis.xMax = xMaxCl;
  axis.yMin = yMinCl; axis.yMax = yMaxCl;
  updateSliderUI();
}
