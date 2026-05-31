// ── Chart state ───────────────────────────────────────────────────────────────
let chartInst = null;
let lastGraphData = null;
let axis = { xMin: null, xMax: null, yMin: null, yMax: null };
let sliderBounds = { xAbsMin: 0, xAbsMax: 10000, yAbsMin: 0, yAbsMax: 10000 };
let fetchDebounce = null;

// ── Main render entry point ───────────────────────────────────────────────────
function renderChart() {
  const active = state.insurances.filter((i) => i.enabled);
  if (!active.length) {
    clearChart();
    return;
  }

  clearTimeout(fetchDebounce);
  fetchDebounce = setTimeout(() => {
    let g = computeGraphData(
      state,
      axis.xMin !== null ? axis.xMin : null,
      axis.xMax !== null ? axis.xMax : null,
    );
    if (!g) {
      clearChart();
      return;
    }
    lastGraphData = g;

    document.getElementById("chart-empty").style.display = "none";
    document.getElementById("chart-wrap").style.display = "block";
    document.getElementById("axis-panel").classList.add("visible");

    // Initialise slider bounds only on very first load
    const isFirstLoad =
      axis.xMin === null &&
      axis.xMax === null &&
      axis.yMin === null &&
      axis.yMax === null;

    if (isFirstLoad) {
      initSliderBounds(g);
      // If a smart viewport was applied, recompute data for the focused window
      if (axis.xMin !== null || axis.xMax !== null) {
        const gFocused = computeGraphData(state, axis.xMin, axis.xMax);
        if (gFocused) {
          lastGraphData = gFocused;
          g = gFocused;
        }
      }
    }
    updateSliderUI();
    drawChart(g);
  }, 150);
}

function clearChart() {
  if (chartInst) {
    chartInst.destroy();
    chartInst = null;
  }
  document.getElementById("chart-empty").style.display = "block";
  document.getElementById("chart-wrap").style.display = "none";
  document.getElementById("chart-legend").innerHTML = "";
  document.getElementById("chart-info").textContent = "";
  document.getElementById("axis-panel").classList.remove("visible");
  axis = { xMin: null, xMax: null, yMin: null, yMax: null };
  lastGraphData = null;
}

// ── Marker tooltip div (shared, reused across redraws) ───────────────────────
let markerTooltipEl = null;
function getMarkerTooltip() {
  if (!markerTooltipEl) {
    markerTooltipEl = document.createElement("div");
    markerTooltipEl.id = "marker-tooltip";
    markerTooltipEl.style.cssText = [
      "position:fixed",
      "z-index:9999",
      "pointer-events:none",
      "display:none",
      "max-width:220px",
      "background:#1e293b",
      "color:#f1f5f9",
      "font-size:0.75rem",
      "line-height:1.5",
      "padding:8px 11px",
      "border-radius:8px",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)",
      "letter-spacing:0.02em",
    ].join(";");
    document.body.appendChild(markerTooltipEl);
  }
  return markerTooltipEl;
}

// ── Helper: interpolate y value at a given x within a data array ─────────────
function interpY(xArr, yArr, x) {
  const idx = xArr.findIndex((v) => v >= x);
  if (idx <= 0) return yArr[0];
  const t = (x - xArr[idx - 1]) / (xArr[idx] - xArr[idx - 1]);
  return yArr[idx - 1] + t * (yArr[idx] - yArr[idx - 1]);
}

// ── Build marker definitions from graph data ─────────────────────────────────
function buildMarkers(g) {
  const markers = [];
  const active = state.insurances.filter((i) => i.enabled);
  const totalProjected = active.reduce((s, i) => s + i.projected_cost, 0);

  // ── Combined crossover(s) ────────────────────────────────────────────────
  const diffArr = g.with.map((w, i) => w - g.without[i]);
  const crossX = [];
  for (let i = 0; i < diffArr.length - 1; i++) {
    if (diffArr[i] * diffArr[i + 1] < 0) {
      const t = diffArr[i] / (diffArr[i] - diffArr[i + 1]);
      crossX.push(g.x[i] + t * (g.x[i + 1] - g.x[i]));
    }
  }

  crossX.forEach((cx) => {
    const yi = interpY(g.x, g.without, cx);
    const insNames = active.map((i) => i.name).join(", ");

    // Per-insurance individual break-even points for detail
    const insDetail = active
      .filter((ins) => ins.coverage_pct > 0)
      .map((ins) => ({
        name: ins.name,
        be: (ins.monthly_premium * 12) / (ins.coverage_pct / 100),
      }))
      .sort((a, b) => a.be - b.be)
      .map((l) => "• " + l.name + ": break-even bij ≈ " + fEuro(l.be))
      .join("\n");

    markers.push({
      type: "crossover",
      x: cx,
      y: yi,
      color: "#2563eb",
      title: "💡 Break-even punt",
      body:
        "Pakket: " + insNames + "\n\n" +
        "Vanaf ≈ " + fEuro(cx) + " zorgkosten/jaar loont\n" +
        "het totale aanvullende pakket financieel.\n" +
        (insDetail ? "\nPer verzekering:\n" + insDetail : ""),
    });
  });

  // ── Combined plateau ─────────────────────────────────────────────────────
  if (g.plateau_start != null && g.plateau_start > 0) {
    const px = g.plateau_start;
    const pyi = interpY(g.x, g.with, px);

    const capInfo = active
      .filter((ins) => ins.projected_cost > 0 && ins.coverage_pct > 0)
      .map((ins) => {
        const capXInd = ins.max_coverage / (ins.coverage_pct / 100);
        const capXTotal = totalProjected > 0
          ? (capXInd / ins.projected_cost) * totalProjected
          : capXInd;
        return { name: ins.name, capXTotal };
      })
      .sort((a, b) => a.capXTotal - b.capXTotal);

    const plateauNames = capInfo.map((c) => c.name).join(", ");
    const capDetail = capInfo
      .map((c) => "• " + c.name + ": plafond bij ≈ " + fEuro(c.capXTotal))
      .join("\n");

    markers.push({
      type: "plateau",
      x: px,
      y: pyi,
      color: "#d97706",
      title: "🔝 Maximale dekking bereikt",
      body:
        "Pakket: " + plateauNames + "\n\n" +
        "Vanaf ≈ " + fEuro(px) + " is het vergoedings-\n" +
        "plafond bereikt. Extra kosten zijn eigen rekening.\n" +
        (capDetail ? "\nPlafond per verzekering:\n" + capDetail : ""),
    });
  }

  return markers;
}

// ── Custom Chart.js plugin: draws arrows above marker points ─────────────────
function makeMarkerPlugin(markers) {
  return {
    id: "markerArrows",
    afterDraw(chart) {
      const ctx = chart.ctx;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const labels = chart.data.labels;

      markers.forEach((m) => {
        // Find pixel x by interpolating among labels
        const labelVals = labels.map(Number);
        let lx = 0;
        for (let i = 0; i < labelVals.length - 1; i++) {
          if (m.x >= labelVals[i] && m.x <= labelVals[i + 1]) {
            const t = (m.x - labelVals[i]) / (labelVals[i + 1] - labelVals[i]);
            const px0 = xScale.getPixelForValue(i);
            const px1 = xScale.getPixelForValue(i + 1);
            lx = px0 + t * (px1 - px0);
            break;
          }
        }
        if (!lx) return; // out of visible range

        const ly = yScale.getPixelForValue(m.y);
        if (
          ly < chart.chartArea.top ||
          ly > chart.chartArea.bottom ||
          lx < chart.chartArea.left ||
          lx > chart.chartArea.right
        ) return; // out of view

        // Arrow dimensions
        const arrowH = 14;
        const arrowW = 7;
        const gap = 6; // gap between arrowhead tip and the line
        const tipY = ly - gap;
        const baseY = tipY - arrowH;

        ctx.save();
        ctx.fillStyle = m.color;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "rgba(0,0,0,.25)";
        ctx.shadowBlur = 4;

        // Downward-pointing triangle
        ctx.beginPath();
        ctx.moveTo(lx, tipY);
        ctx.lineTo(lx - arrowW, baseY);
        ctx.lineTo(lx + arrowW, baseY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Dot at the crossover point on the line
        ctx.beginPath();
        ctx.arc(lx, ly, 4, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();

        // Store canvas-space coords for hit testing
        m._cx = lx;
        m._cy = (baseY + tipY) / 2; // centre of arrow for hit area
        m._r = arrowW + 6;
      });
    },
  };
}

// ── Draw / update the Chart.js instance ──────────────────────────────────────
function drawChart(g) {
  const datasets = [
    {
      label: "Zonder aanvullend",
      data: g.without,
      borderColor: "#ef4444",
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.1,
      fill: false,
    },
    {
      label: "Met aanvullend",
      data: g.with,
      borderColor: "#16a34a",
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.1,
      fill: false,
    },
  ];
  g.ind_lines.forEach((line) =>
    datasets.push({
      label: "Alleen " + line.name,
      data: line.data,
      borderColor: line.color,
      borderWidth: 1.5,
      pointRadius: 0,
      borderDash: [5, 4],
      tension: 0.1,
      fill: false,
    }),
  );

  const yMin = axis.yMin !== null ? axis.yMin : undefined;
  const yMax = axis.yMax !== null ? axis.yMax : undefined;
  const markers = buildMarkers(g);
  const markerPlugin = makeMarkerPlugin(markers);

  if (chartInst) chartInst.destroy();
  chartInst = new Chart(document.getElementById("myChart").getContext("2d"), {
    type: "line",
    data: { labels: g.x.map((v) => Math.round(v)), datasets },
    plugins: [markerPlugin],
    options: {
      animation: false,
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) =>
              "Kosten: €" + parseInt(items[0].label).toLocaleString("nl-NL"),
            label: (item) =>
              " " +
              item.dataset.label +
              ": €" +
              item.parsed.y.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, "."),
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: "xy",
            onPanComplete({ chart }) {
              syncSlidersFromChart(chart);
            },
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            drag: {
              enabled: true,
              modifierKey: "shift",
              backgroundColor: "rgba(37,99,235,.1)",
              borderColor: "rgba(37,99,235,.4)",
              borderWidth: 1,
            },
            mode: "xy",
            onZoomComplete({ chart }) {
              syncSlidersFromChart(chart);
            },
          },
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: "Verwachte aanvullende zorgkosten per jaar (€)",
            font: { size: 12, weight: "600" },
            color: "#6b7280",
            padding: { top: 8 },
          },
          ticks: {
            maxTicksLimit: 10,
            callback: (_, i) =>
              "€" + Math.round(g.x[i]).toLocaleString("nl-NL"),
            maxRotation: 45,
          },
          grid: { color: "rgba(0,0,0,.06)" },
        },
        y: {
          min: yMin,
          max: yMax,
          title: {
            display: true,
            text: "Totale jaarlasten (€)",
            font: { size: 12, weight: "600" },
            color: "#6b7280",
            padding: { bottom: 8 },
          },
          ticks: { callback: (v) => "€" + v.toLocaleString("nl-NL") },
          grid: { color: "rgba(0,0,0,.06)" },
        },
      },
    },
  });

  // ── Marker hover detection ────────────────────────────────────────────────
  const canvas = document.getElementById("myChart");
  const tip = getMarkerTooltip();

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit = null;
    for (const m of markers) {
      if (m._cx == null) continue;
      const dist = Math.hypot(mx - m._cx, my - m._cy);
      if (dist < m._r + 8) { hit = m; break; }
    }
    if (hit) {
      canvas.style.cursor = "pointer";
      tip.innerHTML =
        "<strong style='display:block;margin-bottom:4px;font-size:0.8rem'>" +
        hit.title + "</strong>" +
        hit.body.replace(/\n/g, "<br>");
      // Position: above & centred on arrow, offset from cursor
      const ttW = 220;
      let left = e.clientX - ttW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - ttW - 8));
      tip.style.left = left + "px";
      tip.style.top = (e.clientY - 90) + "px";
      tip.style.display = "block";
    } else {
      canvas.style.cursor = "";
      tip.style.display = "none";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    canvas.style.cursor = "";
  });

  // Double-click resets zoom
  canvas.ondblclick = () => {
    if (chartInst) {
      chartInst.resetZoom();
      axis = { xMin: null, xMax: null, yMin: null, yMax: null };
      renderChart();
    }
  };

  // Legend
  document.getElementById("chart-legend").innerHTML = datasets
    .map(
      (ds) =>
        `<div class="chart-legend-item"><div class="chart-legend-dot" style="background:${ds.borderColor}"></div><span>${ds.label}</span></div>`,
    )
    .join("");

  // Info line
  let info = "";
  if (g.lower_cross)
    info +=
      "✅ Besparing start vanaf ≈ " +
      fEuro(g.lower_cross) +
      " gemaakte zorgkosten.  ";
  if (g.plateau_start)
    info +=
      "🔝 Maximale besparing bereikt bij ≈ " +
      fEuro(g.plateau_start) +
      " gemaakte zorgkosten.  ";
  document.getElementById("chart-info").textContent = info;
}

// ── Smart viewport: centre view on crossover / plateau region ─────────────────
function computeSmartViewport(g) {
  // Collect all "interesting" x positions: crossovers + plateau start
  const anchors = [];
  if (g.lower_cross != null) anchors.push(g.lower_cross);
  if (g.plateau_start != null) anchors.push(g.plateau_start);

  // Also detect ALL sign-change crossings directly from the data arrays
  const diffArr = g.with.map((w, i) => w - g.without[i]);
  for (let i = 0; i < diffArr.length - 1; i++) {
    if (diffArr[i] * diffArr[i + 1] < 0) {
      // Linear interpolation for a precise crossing x
      const t = diffArr[i] / (diffArr[i] - diffArr[i + 1]);
      anchors.push(g.x[i] + t * (g.x[i + 1] - g.x[i]));
    }
  }

  // No crossover found → fall back to full default view
  if (!anchors.length) return null;

  const anchorMin = Math.min(...anchors);
  const anchorMax = Math.max(...anchors);

  // Pad the x-window: 40% before the first anchor, 60% after the last
  const span = Math.max(anchorMax - anchorMin, g.default_max * 0.15);
  const xPadL = span * 0.55;
  const xPadR = span * 0.75;
  const xViewMin = Math.max(0, Math.round(anchorMin - xPadL));
  const xViewMax = Math.round(anchorMax + xPadR);

  // Compute y-range for only the visible x-window
  const pts = g.x.reduce((acc, xi, i) => {
    if (xi >= xViewMin && xi <= xViewMax) {
      acc.push(g.without[i], g.with[i]);
    }
    return acc;
  }, []);
  if (!pts.length) return null;

  const yRaw = Math.max(...pts) - Math.min(...pts);
  const yPad = yRaw * 0.12;
  const yViewMin = Math.floor((Math.min(...pts) - yPad) / 50) * 50;
  const yViewMax = Math.ceil((Math.max(...pts) + yPad) / 50) * 50;

  return { xViewMin, xViewMax, yViewMin, yViewMax };
}

// ── Axis slider initialisation ────────────────────────────────────────────────
function initSliderBounds(g) {
  const xAbsMax = Math.ceil((g.default_max * 4) / 100) * 100;
  const allY = [...g.without, ...g.with];
  const yAbsMin = Math.floor(Math.min(...allY) / 100) * 100;
  const yAbsMax = Math.ceil((Math.max(...allY) * 3) / 100) * 100;
  sliderBounds = { xAbsMin: 0, xAbsMax, yAbsMin, yAbsMax };

  const step = (v) => Math.max(50, Math.round(v / 300 / 50) * 50);
  setSliderAttrs("x-min-sl", 0, xAbsMax, step(xAbsMax), 0);
  setSliderAttrs("x-max-sl", 0, xAbsMax, step(xAbsMax), Math.round(g.default_max));
  setSliderAttrs("y-min-sl", yAbsMin, yAbsMax, step(yAbsMax - yAbsMin), yAbsMin);
  setSliderAttrs("y-max-sl", yAbsMin, yAbsMax, step(yAbsMax - yAbsMin), Math.round(g.auto_y_max));

  // ── Auto-zoom to crossover region ──────────────────────────────────────────
  const vp = computeSmartViewport(g);
  if (vp) {
    // Clamp to absolute bounds
    const xVMin = Math.max(sliderBounds.xAbsMin, vp.xViewMin);
    const xVMax = Math.min(sliderBounds.xAbsMax, vp.xViewMax);
    const yVMin = Math.max(sliderBounds.yAbsMin, vp.yViewMin);
    const yVMax = Math.min(sliderBounds.yAbsMax, vp.yViewMax);

    // Apply to axis state so renderChart uses the focused window
    axis.xMin = xVMin;
    axis.xMax = xVMax;
    axis.yMin = yVMin;
    axis.yMax = yVMax;

    // Sync slider thumbs to the focused window
    document.getElementById("x-min-sl").value = xVMin;
    document.getElementById("x-max-sl").value = xVMax;
    document.getElementById("y-min-sl").value = yVMin;
    document.getElementById("y-max-sl").value = yVMax;
  }
}

function setSliderAttrs(id, min, max, step, val) {
  const el = document.getElementById(id);
  el.min = min;
  el.max = max;
  el.step = step;
  el.value = val;
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
  const min = parseFloat(minEl.min);
  const max = parseFloat(minEl.max);
  const lo = ((parseFloat(minEl.value) - min) / (max - min)) * 100;
  const hi = ((parseFloat(maxEl.value) - min) / (max - min)) * 100;
  const fill = document.getElementById(fillId);
  fill.style.left = lo + "%";
  fill.style.width = hi - lo + "%";
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
    if (document.activeElement === minEl) {
      lo = hi - step;
      minEl.value = lo;
    } else {
      hi = lo + step;
      maxEl.value = hi;
    }
  }

  if (axis_id === "x") {
    axis.xMin = lo;
    axis.xMax = hi;
    renderChart();
  } else {
    axis.yMin = lo;
    axis.yMax = hi;
    if (lastGraphData) drawChart(lastGraphData);
  }
  updateSliderUI();
}

// ── Reset axis button ─────────────────────────────────────────────────────────
function resetAxis(axis_id) {
  if (axis_id === "x") {
    // Re-apply smart viewport if crossovers exist, else full range
    axis.xMin = null;
    axis.xMax = null;
    axis.yMin = null;
    axis.yMax = null;
    // Force re-init on next render
    renderChart();
  } else {
    axis.yMin = null;
    axis.yMax = null;
    if (lastGraphData) {
      const allY = [...lastGraphData.without, ...lastGraphData.with];
      document.getElementById("y-min-sl").value =
        Math.floor(Math.min(...allY) / 100) * 100;
      document.getElementById("y-max-sl").value = Math.round(
        lastGraphData.auto_y_max,
      );
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
  const labels = lastGraphData.x; // actual euro values, indexed 0..N-1

  // xScale.min/max are label indices; interpolate back to euro values
  const n = labels.length;
  const loIdx = Math.max(0, Math.floor(xScale.min));
  const hiIdx = Math.min(n - 1, Math.ceil(xScale.max));
  const fracLo = xScale.min - Math.floor(xScale.min);
  const fracHi = xScale.max - Math.floor(xScale.max);
  const xMinVal = loIdx < n - 1
    ? labels[loIdx] + fracLo * (labels[loIdx + 1] - labels[loIdx])
    : labels[loIdx];
  const xMaxVal = hiIdx < n - 1
    ? labels[hiIdx] + fracHi * (labels[Math.min(hiIdx + 1, n - 1)] - labels[hiIdx])
    : labels[hiIdx];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const xMinCl = clamp(Math.round(xMinVal), sliderBounds.xAbsMin, sliderBounds.xAbsMax);
  const xMaxCl = clamp(Math.round(xMaxVal), sliderBounds.xAbsMin, sliderBounds.xAbsMax);
  const yMinCl = clamp(Math.round(yScale.min), sliderBounds.yAbsMin, sliderBounds.yAbsMax);
  const yMaxCl = clamp(Math.round(yScale.max), sliderBounds.yAbsMin, sliderBounds.yAbsMax);

  document.getElementById("x-min-sl").value = xMinCl;
  document.getElementById("x-max-sl").value = xMaxCl;
  document.getElementById("y-min-sl").value = yMinCl;
  document.getElementById("y-max-sl").value = yMaxCl;
  axis.xMin = xMinCl;
  axis.xMax = xMaxCl;
  axis.yMin = yMinCl;
  axis.yMax = yMaxCl;
  updateSliderUI();
}
