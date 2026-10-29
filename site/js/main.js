/* OpenAI math 词云图 — 前端渲染逻辑（无框架，无构建） */
"use strict";

/* ---------- 学科配色（墨水系） ---------- */
const PALETTE = [
  "#a63d2f", "#2f5d8a", "#3f6f4f", "#8a6d2f", "#6b4f8a",
  "#2f7d8a", "#a34a6b", "#5a7d2f", "#b05a2f", "#4646b0",
  "#2f7a6b", "#7d5a2f"
];
const catColor = new Map();
function colorFor(cat) {
  if (!cat) return "#2f5d8a";
  if (!catColor.has(cat)) catColor.set(cat, PALETTE[catColor.size % PALETTE.length]);
  return catColor.get(cat);
}

/* ---------- 词云渲染 ---------- */
function renderCloud(canvasId, words, opts = {}) {
  const canvas = document.getElementById(canvasId);
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";

  if (!words || words.length === 0) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#5a6478";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("数据尚未生成", canvas.width / 2, canvas.height / 2);
    return;
  }

  const maxC = words[0].count, minC = words[words.length - 1].count;
  // sqrt 映射让长尾词也可读；按画布尺寸自适应字号
  const base = Math.min(canvas.width, canvas.height) / 22;
  const scale = (maxC === minC) ? 0 : (base - base * 0.28) / (Math.sqrt(maxC) - Math.sqrt(minC));
  const weightFactor = (c) => base * 0.28 + (Math.sqrt(c) - Math.sqrt(minC)) * scale;

  const list = words.map(w => [w.word, w.count, colorFor(w.cat)]);

  WordCloud(canvas, {
    list,
    weightFactor,
    fontFamily: 'Georgia, "STZhongsong", "SimSun", serif',
    gridSize: Math.round(base * 0.55),
    rotateRatio: 0.25,
    minRotation: -Math.PI / 6,
    maxRotation: Math.PI / 6,
    shrinkToFit: true,
    clearCanvas: true,
    backgroundColor: "rgba(255,255,255,0)",
    ...opts,
  });
}

/* ---------- Top 30 直条 ---------- */
function renderBars(terms) {
  const ol = document.getElementById("bar-list");
  ol.innerHTML = "";
  const maxC = terms[0].count;
  terms.forEach((t, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="rank">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="term" title="${t.word}">${t.word}</span>` +
      `<span><span class="bar" style="width:${(t.count / maxC) * 100}%"></span></span>` +
      `<span class="count">${t.count.toLocaleString()}</span>`;
    ol.appendChild(li);
  });
}

/* ---------- 分学科 tabs ---------- */
function renderTabs(byDiscipline, currentDiscipline) {
  const wrap = document.getElementById("discipline-tabs");
  wrap.innerHTML = "";
  Object.keys(byDiscipline).forEach(name => {
    const btn = document.createElement("button");
    btn.className = "tab" + (name === currentDiscipline ? " active" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => {
      renderTabs(byDiscipline, name);
      renderCloud("cloud-discipline", byDiscipline[name]);
    });
    wrap.appendChild(btn);
  });
}

/* ---------- 启动 ---------- */
(async function init() {
  let data;
  try {
    const res = await fetch("data/words.json");
    data = await res.json();
  } catch (e) {
    console.error("词频数据加载失败", e);
    document.getElementById("stat-chips").innerHTML =
      '<span class="chip">data/words.json 尚未生成，请先运行离线分析脚本</span>';
    renderCloud("cloud-overall", null);
    renderCloud("cloud-discipline", null);
    return;
  }

  // 统计 chips
  const s = data.stats;
  const chips = [
    `手稿 <b>${s.manuscripts.toLocaleString()}</b> 篇`,
    `问题族 <b>${s.families.toLocaleString()}</b> 个`,
    `收录术语 <b>${s.terms.toLocaleString()}</b> 个`,
    `数据快照 <b>${s.snapshot}</b>`,
  ];
  document.getElementById("stat-chips").innerHTML =
    chips.map(c => `<span class="chip">${c}</span>`).join("");

  // 学科配色映射（overall 词带 cat 字段时生效）

  renderCloud("cloud-overall", data.overall);
  renderBars(data.top_terms.slice(0, 30));

  const firstDiscipline = Object.keys(data.by_discipline)[0];
  renderTabs(data.by_discipline, firstDiscipline);
  renderCloud("cloud-discipline", data.by_discipline[firstDiscipline]);
})();
