/* 学科树 — 学科 / 问题族 / 手稿 的层级树
   数据来自 data/graph.json，现算层级，不新增数据文件。
   桌面与平板（>640px）：SVG 三列 tidy tree；≤640px：DOM 行列表（两层，无连线）。
   命中判定按指针 y 与行中心的最近距离（二分），不用 DOM 叠放顺序。 */
"use strict";

(function () {
  if (typeof d3 === "undefined") return;

  /* 与 graph.js 同一份 13 色，只在 17 个具名学科间循环；Unclassified 单独取灰 */
  const PALETTE = [
    "#a63d2f", "#2f5d8a", "#3f6f4f", "#8a6d2f", "#6b4f8a",
    "#2f7d8a", "#a34a6b", "#5a7d2f", "#b05a2f", "#4646b0",
    "#2f7a6b", "#7d5a2f", "#54427a"
  ];
  const UNCLASSIFIED = "Unclassified";
  const UNCLASSIFIED_COLOR = "#a49d8d";
  const LEAF_INK = "#8a8272";   /* 叶点/叶标签的中性墨水；对纸底约 3.8:1，过 WCAG 1.4.11 */
  const NS = "http://www.w3.org/2000/svg";
  const SERIF = 'Georgia, "STZhongsong", "SimSun", serif';
  const SANS = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const GITHUB_TREE = "https://github.com/openai/math/tree/main/preprints/";
  const GITHUB_CONTENTS = "https://github.com/openai/math/blob/main/CONTENTS.md";

  /* 列位与截断上限（v1.3）。
     leafCap / RAIL_MAX 是**防御性上限**（容器超宽时才生效），不是验收目标：
     真实站点内容宽恒 972 → min(408, 972-620) = 352、min(960, 1016) = 960，
     两个上限永远不 binding。验收只看「gap ≥ 12px」与「W 相对式子」。 */
  const LAYOUT = {
    wide: {
      disc: 96, fam: 280, leaf: 540,
      famLabel: 292, famMax: 236,
      leafLabel: 552, leafPad: 620, leafCap: 408,
      railSlot: 44, leafChars: 34
    },
    mid: {
      disc: 72, fam: 232, leaf: 428,
      famLabel: 244, famMax: 172,
      leafLabel: 440, leafPad: 490, leafCap: 240,
      railSlot: 26, leafChars: 20
    }
  };
  const ROWH = { wide: 32, mid: 32, mobile: 36 };
  const ROWH_FAM = { wide: 22, mid: 22, mobile: 28 };
  const ROWH_LEAF = { wide: 13, mid: 13, mobile: 0 };
  const LABEL_GAP = 12;
  const LEAF_X = 540;          /* 视觉暂定叶列常量，两侧断点各自覆盖 */
  const BAND_X = 48;
  const RAIL_MAX = 1016;
  const SEARCH_EXPAND_LIMIT = 40;   /* 命中族数超过它只做高亮，不自动展开 */
  const ANIM_SKIP_NODES = 120;      /* 单次影响超过它跳过 220ms 过渡 */
  const FRAME_CHUNK = 200;          /* 每帧最多建 200 个节点 */

  const frame = document.querySelector(".tree-frame");
  const scroller = document.querySelector(".tree-scroll");
  const svgEl = document.getElementById("tree-svg");
  const listEl = document.getElementById("tree-list");
  const infoPanel = document.getElementById("tree-info");
  const statusEl = document.getElementById("tree-status");
  const liveEl = document.getElementById("tree-live");
  const searchInput = document.getElementById("tree-search");
  const topSearch = document.getElementById("graph-search");
  const collapseBtn = document.getElementById("tree-collapse-all");
  if (!frame || !scroller || !svgEl || !listEl || !infoPanel || !statusEl) return;

  /* --- SVG 层序，勿重排 ---
     elbow 连线 → 铺底 + 文字 → band → focus 环
     1. 铺底（.tree-label-bg，18px 纸块）的职责是盖住连线，让 n=1 族退化成水平线时
        线在字处断开 —— 所以铺底必须在连线之上。
     2. band 在 rows 之上：这样铺底切不动 band，hover 学科/族行时不会出现
        「band 被挖掉一块」的矩形缺口。7% 蓝压 #26221c 文字肉眼无感（视觉定稿）。
     3. focus 环最上，靠 DOM 顺序而不是 z-index。 */
  const svg = d3.select(svgEl);
  const gLinks = svg.append("g").attr("class", "tree-links");
  const gRows = svg.append("g").attr("class", "tree-rows");

  /* 单元素 hover band：只移动，不新建，重叠区只会有一条 */
  const bandEl = mk("rect", { "class": "tree-band", x: 0, y: 0, width: 0, height: 0 });
  const gBand = svg.append("g").attr("class", "tree-band-layer");
  gBand.node().appendChild(bandEl);

  const focusEl = mk("rect", { "class": "tree-focus-ring", x: 0, y: 0, width: 0, height: 0, rx: 2 });
  svg.append("g").attr("class", "tree-focus-layer").node().appendChild(focusEl);

  const measureCtx = document.createElement("canvas").getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarseQuery = window.matchMedia("(pointer: coarse)");

  const state = {
    mode: "wide",
    width: 900,
    rowH: ROWH.wide,
    rowHFam: ROWH_FAM.wide,
    rowHLeaf: ROWH_LEAF.wide,
    cols: LAYOUT.wide,
    nodes: [],
    byId: new Map(),
    expanded: new Set(),
    selected: null,
    focusId: null,
    focusElPrev: null,
    pointerFocus: false,
    hoverId: null,
    query: "",
    snapshot: null,
    search: { active: false, q: "" },
    hitRows: [],
    ready: false,
    svgBuilt: false,
    mobileBuilt: false,
    uid: 0
  };

  /* ---------------- 工具 ---------------- */

  function mk(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function reduced() { return !!(reduceMotion && reduceMotion.matches); }
  function coarse() { return !!(coarseQuery && coarseQuery.matches); }
  function measure(text, font) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  function ellipsize(text, maxChars) {
    const t = String(text == null ? "" : text);
    return (maxChars && t.length > maxChars) ? t.slice(0, maxChars) + "…" : t;
  }
  /* 按最大像素宽收缩（中文无空格，直接按字数折半查找） */
  function fitText(text, font, maxW) {
    const t = String(text == null ? "" : text);
    measureCtx.font = font;
    if (measureCtx.measureText(t).width <= maxW) return t;
    let lo = 1;
    let hi = t.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      measureCtx.font = font;
      if (measureCtx.measureText(t.slice(0, mid) + "…").width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return t.slice(0, Math.max(1, lo)) + "…";
  }
  function announce(text) {
    if (!liveEl) return;
    liveEl.textContent = "";
    window.setTimeout(function () { liveEl.textContent = text; }, 30);
  }
  function rowH(n) {
    if (n.type === "discipline") return state.rowH;
    if (n.type === "family") return state.rowHFam;
    return state.rowHLeaf;
  }
  /* 命中高度：coarse 下族 32、叶 23，其余等于行高 */
  function hitH(n) {
    const base = rowH(n);
    if (!coarse()) return base;
    if (n.type === "family") return Math.max(base, 32);
    if (n.type === "leaf") return Math.max(base, 23);
    return base;
  }
  function modeFor() {
    const w = window.innerWidth;
    if (w <= 640) return "mobile";
    return w <= 880 ? "mid" : "wide";
  }
  function contentWidth() {
    const cs = window.getComputedStyle(scroller);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const w = scroller.clientWidth - padL - padR;
    return Math.max(240, Math.round(w));
  }
  function applyMetrics() {
    const mobile = state.mode === "mobile";
    state.cols = mobile ? LAYOUT.wide : LAYOUT[state.mode];
    state.rowH = ROWH[state.mode];
    state.rowHFam = ROWH_FAM[state.mode];
    state.rowHLeaf = ROWH_LEAF[state.mode];
    state.width = contentWidth();
  }
  function railRight() { return Math.min(state.width - 12, RAIL_MAX); }

  /* ---------------- 状态浮层 ---------------- */

  function showStatus(text, actionText, onAction) {
    statusEl.textContent = "";
    const p = document.createElement("p");
    p.textContent = text;
    statusEl.appendChild(p);
    if (actionText) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tree-status-btn";
      b.textContent = actionText;
      b.addEventListener("click", onAction);
      statusEl.appendChild(b);
    }
    statusEl.hidden = false;
  }
  function hideStatus() { statusEl.hidden = true; }

  /* ---------------- 建模 ---------------- */

  function buildModel(data) {
    const fams = Array.isArray(data.families) ? data.families : [];
    const mss = Array.isArray(data.manuscripts) ? data.manuscripts : [];
    const famById = new Map();
    fams.forEach(function (f) { if (f && f.id) famById.set(f.id, f); });

    const byDisc = new Map();
    mss.forEach(function (m) {
      if (!m) return;
      const d = m.discipline || UNCLASSIFIED;
      if (!byDisc.has(d)) byDisc.set(d, []);
      byDisc.get(d).push(m);
    });

    /* 学科名升序，Unclassified 固定最后（sort 后本来就在最后，这里显式保证） */
    const discNames = Array.from(byDisc.keys()).sort(function (a, b) {
      if (a === UNCLASSIFIED) return 1;
      if (b === UNCLASSIFIED) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    /* 13 色只在具名学科间按 i%13 分配，Unclassified 不占位 */
    const colorOf = {};
    let ci = 0;
    discNames.forEach(function (d) {
      colorOf[d] = d === UNCLASSIFIED ? UNCLASSIFIED_COLOR : PALETTE[ci++ % PALETTE.length];
    });

    const nodes = [];
    const byId = new Map();
    function add(node) {
      node.domId = "tree-item-" + (++state.uid);
      node.children = node.children || [];
      nodes.push(node);
      byId.set(node.id, node);
      return node;
    }

    discNames.forEach(function (disc) {
      const color = colorOf[disc];
      const list = byDisc.get(disc).slice().sort(function (a, b) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const groups = new Map();
      const loose = [];
      list.forEach(function (m) {
        if (m.family && famById.has(m.family)) {
          if (!groups.has(m.family)) groups.set(m.family, []);
          groups.get(m.family).push(m);
        } else {
          loose.push(m);
        }
      });

      const dNode = add({
        id: "d|" + disc, type: "discipline", depth: 1, title: disc,
        discipline: disc, color: color, parent: null,
        n: list.length, famCount: groups.size, looseCount: loose.length
      });
      dNode.discNode = dNode;

      Array.from(groups.keys()).sort(function (a, b) {
        return Number(a) - Number(b);
      }).forEach(function (fid) {
        const f = famById.get(fid);
        const kids = groups.get(fid);
        const fNode = add({
          id: "f|" + fid, type: "family", depth: 2, fid: fid,
          title: (f && f.title) || "问题族 #" + fid,
          discipline: disc, color: color, parent: dNode,
          n: (f && typeof f.n === "number") ? f.n : kids.length
        });
        fNode.discNode = dNode;
        dNode.children.push(fNode);
        kids.forEach(function (m) {
          const leaf = add({
            id: "m|" + m.id, type: "leaf", depth: 3, manuscriptId: m.id,
            title: m.title || m.id, discipline: disc, color: color,
            parent: fNode, loose: false
          });
          leaf.discNode = dNode;
          fNode.children.push(leaf);
        });
      });

      loose.forEach(function (m) {
        /* 无族手稿直接挂学科下当叶：不造合成「未分组」族行，
           否则 31 个假族会污染 373 族计数和 rail 数字列。
           depth 2 = discipline 的直接子节点，aria-level 才是对的（不是 3）。
           排序上它们落在该学科所有族之后，即「学科叶序列末尾」。 */
        const leaf = add({
          id: "m|" + m.id, type: "leaf", depth: 2, manuscriptId: m.id,
          title: m.title || m.id, discipline: disc, color: color,
          parent: dNode, loose: true
        });
        leaf.discNode = dNode;
        dNode.children.push(leaf);
      });
    });

    state.nodes = nodes;
    state.byId = byId;
  }

  function discNodes() {
    return state.nodes.filter(function (n) { return n.type === "discipline"; });
  }

  /* 默认展开：序列第 1、2 项；族数不足 8 就顺延，最多 4 个学科。
     同时展开这些学科的族，保证首屏就看得见「族 + 叶」两层。 */
  function defaultExpanded() {
    const discs = discNodes();
    const picks = [];
    let famTotal = 0;
    for (let i = 0; i < discs.length && picks.length < 4; i++) {
      picks.push(discs[i].id);
      famTotal += discs[i].famCount;
      if (picks.length >= 2 && famTotal >= 8) break;
    }
    const out = picks.slice();
    picks.forEach(function (id) {
      const d = state.byId.get(id);
      if (!d) return;
      d.children.forEach(function (f) {
        if (f.children.length) out.push(f.id);
      });
    });
    return out;
  }

  /* ---------------- 可见性 / 搜索 ---------------- */

  function computeSearch(q) {
    if (!q) {
      return { active: false, q: "", leafHits: null, famHits: null, discHits: null, highlightOnly: false, empty: false };
    }
    const leafHits = new Set();
    const famHits = new Set();
    const discHits = new Set();
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (n.type !== "leaf") continue;
      if (String(n.title).toLowerCase().indexOf(q) === -1) continue;
      leafHits.add(n.id);
      discHits.add(n.discNode.id);
      if (n.parent && n.parent.type === "family") famHits.add(n.parent.id);
    }
    return {
      active: true, q: q,
      leafHits: leafHits, famHits: famHits, discHits: discHits,
      highlightOnly: famHits.size > SEARCH_EXPAND_LIMIT,
      empty: leafHits.size === 0
    };
  }

  function isVisible(n, s) {
    if (n.depth === 1) {
      if (s.active && !s.highlightOnly) return s.discHits.has(n.id);
      return true;
    }
    const p = n.parent;
    if (!p || !p._vis) return false;
    if (!state.expanded.has(p.id)) return false;
    if (s.active && !s.highlightOnly) {
      return n.type === "family" ? s.famHits.has(n.id) : s.leafHits.has(n.id);
    }
    if (n.type === "leaf" && state.mode === "mobile") return false;
    return true;
  }

  function computeVisibility() {
    const s = state.search;
    for (let i = 0; i < state.nodes.length; i++) {
      state.nodes[i]._vis = isVisible(state.nodes[i], s);
    }
  }

  function applySearch(raw) {
    const q = String(raw || "").trim().toLowerCase();
    state.query = q;

    if (!q) {
      if (state.snapshot) {
        state.expanded = new Set(state.snapshot);
        state.snapshot = null;
      }
      state.search = { active: false, q: "" };
      hideStatus();
      applyMetrics();
      refreshLabels();
      render();
      return;
    }

    if (!state.snapshot) state.snapshot = new Set(state.expanded);
    const s = computeSearch(q);
    state.search = s;

    if (!s.highlightOnly) {
      s.discHits.forEach(function (id) { state.expanded.add(id); });
      s.famHits.forEach(function (id) { state.expanded.add(id); });
    }

    if (s.empty) {
      showStatus("没有匹配「" + q + "」的手稿", "清除搜索", clearSearch);
      announce("没有匹配的手稿");
    } else {
      hideStatus();
      announce(s.highlightOnly
        ? "匹配到 " + s.famHits.size + " 个问题族，只做高亮"
        : "匹配到 " + s.leafHits.size + " 篇手稿");
    }
    applyMetrics();
    refreshLabels();
    render();
  }

  function clearSearch() {
    if (searchInput) searchInput.value = "";
    if (topSearch) topSearch.value = "";
    try {
      if (topSearch) topSearch.dispatchEvent(new Event("input"));
    } catch (e) { /* ignore */ }
    applySearch("");
  }

  /* ================================================================
     桌面 / 平板：SVG 三列
     ================================================================ */

  function svgX(n) {
    const c = state.cols;
    if (n.type === "discipline") return c.disc;
    if (n.type === "family") return c.fam;
    return c.leaf;
  }

  function createSvgRow(n) {
    const h = rowH(n);
    const kind = n.type === "discipline" ? "d" : (n.type === "family" ? "f" : "leaf");
    const g = mk("g", {
      "class": "tree-row tree-row--" + kind + (n.loose ? " is-loose" : ""),
      role: "treeitem",
      id: n.domId,
      "aria-level": String(n.depth),
      "aria-selected": state.selected === n.id ? "true" : "false",
      "aria-label": ariaLabelOf(n)
    });
    if (n.children.length) {
      g.setAttribute("aria-expanded", state.expanded.has(n.id) ? "true" : "false");
    }

    /* 族 / 学科标签的纸底，让连线在字下断开 */
    const bg = mk("rect", { "class": "tree-label-bg", x: 0, y: -9, width: 0, height: 18 });
    if (n.type === "leaf") bg.setAttribute("opacity", "0");
    g.appendChild(bg);

    const r = n.type === "discipline" ? 9 : (n.type === "family" ? 4.5 : 2.8);
    const dot = mk("circle", { "class": "tree-dot", cx: 0, cy: 0, r: r });
    if (n.type === "discipline") {
      dot.setAttribute("fill", n.color);
    } else if (n.type === "family") {
      dot.setAttribute("class", "tree-dot tree-dot--family");
      dot.setAttribute("stroke", n.color);
      dot.setAttribute("stroke-width", "1.5");
    } else {
      /* 叶一律用中性墨水 #8a8272（对纸底约 3.8:1，过 WCAG 1.4.11 的 3:1）。
         不描白边：白环当初是为「族标签压到叶点」准备的遮挡，改用 528 硬边界后
         几何冲突已消失，环只剩损耗——13px 行高下 1.5px 环会把 2.8px 的点糊大一圈。
         无族散叶 = 空心环 + 深一档的 #6f6656（--ink-soft，约 5.6:1）：
         「未归类」是特殊状态，用比实心叶点更深的墨色表达层级；空心 vs 实心是
         第二通道，色弱用户也能分。 */
      dot.setAttribute("fill", LEAF_INK);
      if (n.loose) {
        dot.setAttribute("fill", "none");
        dot.setAttribute("stroke", "#6f6656");
        dot.setAttribute("stroke-width", "1.5");
      }
    }
    g.appendChild(dot);

    const ring = mk("circle", {
      "class": "tree-ring", cx: 0, cy: 0, r: r + 3, fill: "none",
      stroke: n.color, "stroke-width": "2",
      opacity: state.selected === n.id ? "0.35" : "0"
    });
    g.appendChild(ring);

    let inner = null;
    if (n.type === "discipline") {
      inner = mk("circle", {
        "class": "tree-inner", cx: 0, cy: 0, r: 6, fill: "none",
        stroke: "#fffdf8", "stroke-width": "2",
        opacity: state.expanded.has(n.id) ? "0" : "1"
      });
      g.appendChild(inner);
    }

    const label = mk("text", {
      "class": "tree-label tree-label--" + (n.type === "discipline" ? "discipline" : n.type === "family" ? "family" : "leaf"),
      x: n.type === "leaf" ? state.cols.leafLabel - svgX(n) : LABEL_GAP,
      y: 0,
      "dominant-baseline": "middle"
    });
    label.textContent = n.title;
    label.setAttribute("title", n.title);
    g.appendChild(label);

    let count = null;
    if (n.type === "discipline") {
      count = mk("text", { "class": "tree-count", x: 0, y: 0, "dominant-baseline": "middle" });
      g.appendChild(count);
    }

    let badge = null;
    if (n.type === "family") {
      badge = mk("g", { "class": "tree-badge-slot", "aria-hidden": "true" });
      if (n.n <= 1) badge.setAttribute("class", "tree-badge-slot is-empty");  /* 占位不渲染，用 visibility 藏 */
      const bgR = mk("rect", { "class": "tree-badge-bg", x: 0, y: -8, width: 0, height: 16, rx: 2 });
      const txt = mk("text", { "class": "tree-badge", x: 0, y: 0, "dominant-baseline": "middle", "text-anchor": "end" });
      badge.appendChild(bgR);
      badge.appendChild(txt);
      g.appendChild(badge);
    }

    n.el = g;
    n.bgEl = bg;
    n.labelEl = label;
    n.countEl = count;
    n.badgeEl = badge;
    n.badgeBgEl = badge ? badge.firstChild : null;
    n.badgeTxtEl = badge ? badge.lastChild : null;
    n.ringEl = ring;
    n.innerEl = inner;

    if (n.depth >= 2) {
      const path = mk("path", {
        "class": "tree-link", d: "",
        "stroke-width": n.type === "family" ? "1.2" : "0.8"
      });
      gLinks.node().appendChild(path);
      d3.select(path).datum(n);
      n.linkEl = path;
    }

    d3.select(g).datum(n);
    gRows.node().appendChild(g);
  }

  function ariaLabelOf(n) {
    if (n.type === "discipline") return n.title + "，" + n.famCount + " 个族，" + n.n + " 篇手稿";
    if (n.type === "family") return n.title + "，" + n.n + " 篇";
    return n.loose ? n.title + "，未分组" : n.title;
  }

  /* 标签文字与几何：宽度 / 展开状态变化时重算 */
  function layoutSvgText(n) {
    if (!n || !n.labelEl) return;
    const c = state.cols;
    const W = state.width;
    const x = n._x == null ? svgX(n) : n._x;

    if (n.type === "leaf") {
      n.labelEl.setAttribute("x", c.leafLabel - x);
      /* 叶标签宽度上限：max(110, min(leafCap, 内容宽 - leafPad))，两档是两条独立链：
           wide (≥881)   leafCap 408 · leafPad 620 · 内容宽 972 → 352（封顶 408）
           mid  (641–880) leafCap 240 · leafPad 490 · 内容宽 757 → 240
         110 是地板：641 宽时内容宽只剩 518，按 490 算只余 28px，
         保留 110px（约 8 字）比截成 3 个字可用得多。
         徽标一律右缘钉在 railRight() = min(内容宽-12, 1016)、槽向左生长，永不越界；
         所以 mid 档叶标签列可能压到徽标列上——二者永不同行（叶标签只在叶行、
         徽标只在族行），视觉上不会同排相撞，不要为「把两档公式凑相等」去削字数。 */
      const cap = Math.max(110, Math.min(c.leafCap, W - c.leafPad));
      const font = "400 12px " + SERIF;
      n.labelEl.textContent = fitText(ellipsize(n.title, c.leafChars), font, cap);
      return;
    }

    const isDisc = n.type === "discipline";
    const font = isDisc ? ("700 15px " + SERIF) : ("600 13px " + SERIF);

    let countText = "";
    let countW = 0;
    if (isDisc) {
      countText = n.famCount + " 族 · " + n.n + " 篇";
      countW = measure(countText, "400 11px " + SANS);
    } else if (n.n > 1) {
      countText = n.n + " 篇";
      countW = measure(countText, "400 11px " + SANS) + 10;  /* padding 1px 5px */
    }

    /* 学科：标签后 8px 内联计数，右界到叶列前 */
    let labelRight;
    if (isDisc) {
      labelRight = Math.min(c.leaf - 24, W - 24) - (countW ? countW + 8 : 0);
    } else {
      labelRight = c.famLabel + c.famMax;
    }
    const avail = Math.max(40, labelRight - x - LABEL_GAP);
    /* 族标签按像素宽收（236px 对中文约 18 字），完整名放 title */
    const text = fitText(n.title, font, avail);
    n.labelEl.textContent = text;
    const lw = measure(text, font);

    /* 纸底：学科覆盖标签+计数，族只覆盖标签 */
    const bgW = isDisc && countW ? lw + 8 + countW + 8 : lw + 8;
    n.bgEl.setAttribute("x", LABEL_GAP - 4);
    n.bgEl.setAttribute("width", Math.round(bgW));

    if (n.countEl) {
      n.countEl.textContent = countText;
      n.countEl.setAttribute("x", Math.round(Math.min(LABEL_GAP + lw + 8, labelRight - x)));
    }

    if (n.badgeEl) {
      const slot = c.railSlot;
      const right = railRight() - x;          /* 局部坐标 */
      const slotX = right - slot;
      if (n.n > 1) {
        n.badgeTxtEl.textContent = countText;
        n.badgeTxtEl.setAttribute("x", Math.round(right - 5));
        n.badgeBgEl.setAttribute("x", Math.round(right - countW));
        n.badgeBgEl.setAttribute("width", Math.round(countW));
      } else {
        /* n=1 用 visibility:hidden 占位，不给 display:none，避免切换抖动 */
        n.badgeTxtEl.textContent = "";
        n.badgeBgEl.setAttribute("width", 0);
      }
      /* 槽位宽度固定，仅用于布局占位（不可见） */
      n.badgeEl.setAttribute("data-slot-x", Math.round(slotX));
      n.badgeEl.setAttribute("data-slot-w", slot);
    }
  }

  function refreshLabels() {
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (!n.labelEl) continue;
      layoutSvgText(n);
    }
  }

  function buildSvgRows(onDone) {
    gRows.node().textContent = "";
    gLinks.node().textContent = "";
    const total = state.nodes.length;
    let i = 0;
    function chunk() {
      const end = Math.min(i + FRAME_CHUNK, total);
      for (; i < end; i++) createSvgRow(state.nodes[i]);
      if (i < total) requestAnimationFrame(chunk);
      else {
        state.svgBuilt = true;
        if (onDone) onDone();
      }
    }
    requestAnimationFrame(chunk);
  }

  /* 布局：算 y、写 transform、移动 band */
  function layoutSvg(opts) {
    opts = opts || {};
    const animate = !!opts.animate && !reduced();
    let y = 0;
    let changed = 0;

    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (!n._vis) continue;
      const h = rowH(n);
      n._x = svgX(n);
      const ny = y + h / 2;
      if (n._wasVis && n._appliedY != null && Math.abs(n._appliedY - ny) > 0.4) changed++;
      n._y = ny;
      y += h;
    }

    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (n._vis) continue;
      if (n._shown !== false) {
        n.el.setAttribute("display", "none");
        if (n.linkEl) n.linkEl.setAttribute("display", "none");
        n._shown = false;
      }
    }

    const rowSel = d3.select(gRows.node()).selectAll("g.tree-row");
    const linkSel = d3.select(gLinks.node()).selectAll("path.tree-link");
    const visRows = rowSel.filter(function (n) { return n._vis; });
    const visLinks = linkSel.filter(function (n) { return n._vis; });

    visRows.attr("display", null);
    visLinks.attr("display", null);

    const animated = animate && changed > 0 && changed <= ANIM_SKIP_NODES;

    if (animated) {
      visRows.filter(function (n) { return !!n._wasVis; })
        .transition("pos").duration(220).ease(d3.easeCubicOut)
        .attr("transform", function (n) { return "translate(" + n._x + "," + n._y + ")"; });
      visRows.filter(function (n) { return !n._wasVis; })
        .attr("transform", function (n) { return "translate(" + n._x + "," + n._y + ")"; });
      visLinks.filter(function (n) { return !!n._wasVis; })
        .transition("pos").duration(220).ease(d3.easeCubicOut)
        .attr("d", linkPath);
      visLinks.filter(function (n) { return !n._wasVis; }).attr("d", linkPath);
    } else {
      rowSel.interrupt("pos");
      linkSel.interrupt("pos");
      visRows.attr("transform", function (n) { return "translate(" + n._x + "," + n._y + ")"; });
      visLinks.attr("d", linkPath);
    }

    state.hitRows = [];
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      n._wasVis = n._vis;
      if (n._vis) {
        n._appliedY = n._y;
        n._shown = true;
        state.hitRows.push(n);
      }
    }

    svgEl.setAttribute("width", state.width);
    svgEl.setAttribute("height", Math.max(160, Math.round(y + 24)));

    updateCollapseMarks();
    updateSelectionMarks();
    updateSearchMarks();
    syncBandToActive();
  }

  function linkPath(n) {
    const p = n.parent;
    if (!p || p._x == null || n._x == null) return "";
    const mx = Math.round((p._x + n._x) / 2);   /* 学科→族 188，族→叶 410 */
    return "M" + p._x + "," + p._y + "H" + mx + "V" + n._y + "H" + n._x;
  }

  function updateCollapseMarks() {
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (!n.el) continue;
      if (n.type === "discipline") {
        const open = state.expanded.has(n.id);
        if (n.innerEl) n.innerEl.setAttribute("opacity", open ? "0" : "1");
        n.el.setAttribute("aria-expanded", open ? "true" : "false");
      } else if (n.type === "family") {
        n.el.setAttribute("aria-expanded", state.expanded.has(n.id) ? "true" : "false");
      }
    }
  }

  function updateSelectionMarks() {
    const sel = state.selected;
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      const on = n.id === sel;
      if (n.ringEl) n.ringEl.setAttribute("opacity", on ? "0.35" : "0");
      if (n.el) {
        n.el.classList.toggle("is-sel", on);
        n.el.setAttribute("aria-selected", on ? "true" : "false");
      }
      if (n.mEl) {
        n.mEl.classList.toggle("is-sel", on);
        n.mEl.setAttribute("aria-selected", on ? "true" : "false");
      }
    }

    if (!sel) {
      for (let i = 0; i < state.nodes.length; i++) {
        const n = state.nodes[i];
        if (n.el) n.el.classList.remove("is-dim");
        if (n.mEl) n.mEl.classList.remove("is-dim");
        if (n.linkEl) n.linkEl.classList.remove("is-dim");
      }
      return;
    }

    const keep = new Set();
    let p = state.byId.get(sel);
    while (p) { keep.add(p.id); p = p.parent; }
    (function walk(node) {
      for (let i = 0; i < node.children.length; i++) {
        keep.add(node.children[i].id);
        walk(node.children[i]);
      }
    })(state.byId.get(sel));

    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      const dim = !keep.has(n.id);
      if (n.el) n.el.classList.toggle("is-dim", dim);
      if (n.mEl) n.mEl.classList.toggle("is-dim", dim);
      if (n.linkEl) n.linkEl.classList.toggle("is-dim", dim);
    }
  }

  function updateSearchMarks() {
    const s = state.search;
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      let m = false;
      if (s.active) {
        if (n.type === "leaf") m = !!(s.leafHits && s.leafHits.has(n.id));
        else if (n.type === "family") m = !!(s.famHits && s.famHits.has(n.id));
        else m = !!(s.discHits && s.discHits.has(n.id));
      }
      if (n.el) n.el.classList.toggle("is-match", m);
      if (n.mEl) n.mEl.classList.toggle("is-match", m);
    }
  }

  /* ---------------- hover band（单元素） ---------------- */

  function setHotLeaf(n) {
    if (state.hotLeaf === n) return;
    if (state.hotLeaf && state.hotLeaf.el) state.hotLeaf.el.classList.remove("is-hot");
    state.hotLeaf = (n && n.type === "leaf") ? n : null;
    if (state.hotLeaf && state.hotLeaf.el) state.hotLeaf.el.classList.add("is-hot");
  }

  function moveBand(n, instant) {
    if (!n || n._y == null) {
      bandEl.classList.remove("is-on");
      setHotLeaf(null);
      return;
    }
    const h = hitH(n);
    const bx = n.type === "leaf" ? state.cols.leaf - 12 : BAND_X;
    bandEl.classList.toggle("is-coarse", coarse());
    bandEl.setAttribute("x", bx);
    bandEl.setAttribute("width", Math.max(0, state.width - bx));
    bandEl.setAttribute("height", h);
    bandEl.setAttribute("y", -h / 2);
    if (instant) {
      bandEl.classList.add("is-instant");
      bandEl.style.transform = "translateY(" + n._y + "px)";
      window.setTimeout(function () { bandEl.classList.remove("is-instant"); }, 0);
    } else {
      bandEl.style.transform = "translateY(" + n._y + "px)";
    }
    /* 显隐走类：CSS 里的 opacity:0 优先级高于 presentation attribute，
       写 setAttribute("opacity","1") 会被压掉，band 永远不出现。 */
    bandEl.classList.add("is-on");

    /* 叶标签只在 hover 时露出来 */
    setHotLeaf(n);
  }

  function hideBand() {
    bandEl.classList.remove("is-on");
    setHotLeaf(null);
  }

  function activeRow() {
    if (state.hoverId) return state.byId.get(state.hoverId) || null;
    if (state.focusId) return state.byId.get(state.focusId) || null;
    return null;
  }

  function syncBandToActive() {
    if (state.mode === "mobile") return;
    const n = activeRow();
    if (!n || !n._vis) { hideBand(); return; }
    moveBand(n, true);
  }

  /* 指针 y → 最近行（二分） */
  function rowAtY(y) {
    const rows = state.hitRows;
    if (!rows.length) return null;
    let n;
    if (y <= rows[0]._y) n = rows[0];
    else if (y >= rows[rows.length - 1]._y) n = rows[rows.length - 1];
    else {
      let lo = 0;
      let hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid]._y < y) lo = mid + 1;
        else hi = mid;
      }
      const a = rows[lo - 1];
      const b = rows[lo];
      n = (y - a._y <= b._y - y) ? a : b;
    }
    /* 离行中心太远算空白（列表末尾的留白不该命中末行） */
    if (Math.abs(y - n._y) > hitH(n) / 2 + 6) return null;
    return n;
  }

  function svgYOf(e) {
    const rect = svgEl.getBoundingClientRect();
    /* SVG 无 viewBox，1 用户单位 = 1px，无需换算 */
    return e.clientY - rect.top;
  }

  /* ---------------- 移动端：DOM 行列表 ---------------- */

  function buildMobileRows(onDone) {
    listEl.textContent = "";
    const rows = state.nodes.filter(function (n) { return n.type !== "leaf"; });
    const total = rows.length;
    let i = 0;
    function chunk() {
      const end = Math.min(i + FRAME_CHUNK, total);
      for (; i < end; i++) createMobileRow(rows[i]);
      if (i < total) requestAnimationFrame(chunk);
      else {
        state.mobileBuilt = true;
        if (onDone) onDone();
      }
    }
    requestAnimationFrame(chunk);
  }

  function createMobileRow(n) {
    const isDisc = n.type === "discipline";
    const div = document.createElement("div");
    div.className = "tree-mrow " + (isDisc ? "tree-mrow--d" : "tree-mrow--f");
    div.setAttribute("role", "treeitem");
    div.id = "tree-m" + n.domId;
    div.setAttribute("aria-level", String(n.depth));
    div.setAttribute("aria-label", ariaLabelOf(n));
    div.setAttribute("aria-selected", state.selected === n.id ? "true" : "false");
    if (isDisc) div.setAttribute("aria-expanded", state.expanded.has(n.id) ? "true" : "false");

    const dot = document.createElement("span");
    dot.className = "tree-mdot";
    if (isDisc) dot.style.background = n.color;
    else dot.style.color = n.color;   /* 空心圆描边取 currentColor */
    div.appendChild(dot);

    const label = document.createElement("span");
    label.className = "tree-mlabel";
    label.textContent = ellipsize(n.title, isDisc ? 0 : 18);
    label.setAttribute("title", n.title);
    div.appendChild(label);

    if (isDisc) {
      const count = document.createElement("span");
      count.className = "tree-mcount";
      count.textContent = n.famCount + " 族 · " + n.n + " 篇";
      div.appendChild(count);

      const plus = document.createElement("span");
      plus.className = "tree-mplus";
      plus.setAttribute("aria-hidden", "true");
      plus.textContent = state.expanded.has(n.id) ? "" : "+";
      div.appendChild(plus);
      n.mPlusEl = plus;
      n.mCountEl = count;
    } else {
      /* 移动端没有叶层，n 篇徽标就是「下面还有东西」的唯一提示 */
      const badge = document.createElement("span");
      badge.className = "tree-mbadge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = n.n + " 篇";
      div.appendChild(badge);
    }

    n.mEl = div;
    listEl.appendChild(div);
  }

  function renderMobile() {
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (!n.mEl) continue;
      n.mEl.hidden = !n._vis;
      if (n.type === "family") {
        n.mEl.classList.toggle("is-match", !!(state.search.active && state.search.famHits && state.search.famHits.has(n.id)));
      } else {
        n.mEl.setAttribute("aria-expanded", state.expanded.has(n.id) ? "true" : "false");
        if (n.mPlusEl) n.mPlusEl.textContent = state.expanded.has(n.id) ? "" : "+";
      }
    }
    updateSelectionMarks();
    updateSearchMarks();
  }

  /* ---------------- 统一切换 ---------------- */

  function render(opts) {
    opts = opts || {};
    if (!state.nodes.length) return;

    const mobile = state.mode === "mobile";
    /* 注意：SVGElement 的 .hidden 不会反射成属性，必须显式写 attribute，
       否则移动端那块空 SVG 仍按默认 300×150 占位，撑出横向溢出。 */
    if (mobile) {
      svgEl.setAttribute("hidden", "");
      listEl.removeAttribute("hidden");
    } else {
      svgEl.removeAttribute("hidden");
      listEl.setAttribute("hidden", "");
    }

    computeVisibility();

    if (mobile) {
      if (!state.mobileBuilt) {
        buildMobileRows(function () { renderMobile(); });
        return;
      }
      renderMobile();
      return;
    }

    if (!state.svgBuilt) {
      buildSvgRows(function () { layoutSvg(opts); });
      return;
    }
    layoutSvg(opts);
  }

  /* ---------------- 详情卡 ---------------- */

  function closeInfo() {
    infoPanel.hidden = true;
    infoPanel.textContent = "";
    infoPanel.className = "graph-info tree-info";
  }

  /* 学科色圆点：与移动端族卡同一种表达（色相 + 学科名文字） */
  function discDot(color) {
    const s = document.createElement("span");
    s.className = "tree-disc-dot";
    s.setAttribute("aria-hidden", "true");
    s.style.background = color || UNCLASSIFIED_COLOR;
    return s;
  }

  function openInfo(n) {
    infoPanel.textContent = "";
    infoPanel.className = "graph-info tree-info";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "info-close";
    close.setAttribute("aria-label", "关闭详情");
    close.textContent = "×";
    close.addEventListener("click", function () {
      state.selected = null;
      closeInfo();
      updateSelectionMarks();
    });
    infoPanel.appendChild(close);

    if (state.mode === "mobile" && n.type === "family") {
      infoPanel.className = "graph-info tree-info tree-info--m";
      const head = document.createElement("div");
      head.className = "tree-info-head";
      const name = document.createElement("p");
      name.className = "tree-info-name";
      name.id = "tree-info-name";
      name.textContent = n.title;
      const sub = document.createElement("p");
      sub.className = "tree-info-sub";
      sub.appendChild(discDot(n.color));
      sub.appendChild(document.createTextNode(n.n + " 篇 · " + n.discipline));
      head.appendChild(name);
      head.appendChild(sub);
      infoPanel.appendChild(head);

      const ul = document.createElement("ul");
      ul.className = "tree-mlist info-list";
      ul.setAttribute("role", "list");
      ul.setAttribute("aria-labelledby", "tree-info-name");
      n.children.forEach(function (leaf) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = GITHUB_TREE + leaf.manuscriptId;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = leaf.title;
        li.appendChild(a);
        ul.appendChild(li);
      });
      infoPanel.appendChild(ul);
      infoPanel.hidden = false;
      return;
    }

    const type = document.createElement("p");
    type.className = "info-type";
    type.textContent = n.type === "leaf"
      ? "手稿 Manuscript"
      : (n.type === "family" ? "问题族 Family #" + n.fid : "学科 Discipline");
    infoPanel.appendChild(type);

    const title = document.createElement("p");
    title.className = "info-title";
    title.textContent = n.title;
    infoPanel.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "info-meta";
    const color = document.createElement("b");
    color.style.color = n.color;

    if (n.type === "leaf") {
      color.textContent = n.discipline;
      meta.appendChild(discDot(n.color));
      meta.appendChild(document.createTextNode("学科："));
      meta.appendChild(color);
      meta.appendChild(document.createTextNode(
        n.loose ? " · 族：未分组" : " · 族：" + (n.parent ? n.parent.title : "—")
      ));
    } else if (n.type === "family") {
      color.textContent = n.discipline;
      meta.appendChild(discDot(n.color));
      meta.appendChild(document.createTextNode("学科："));
      meta.appendChild(color);
      meta.appendChild(document.createTextNode(" · 含手稿 " + n.n + " 篇"));
    } else {
      meta.appendChild(document.createTextNode(n.n + " 篇手稿 · " + n.famCount + " 个问题族"));
      if (n.looseCount) meta.appendChild(document.createTextNode(" · " + n.looseCount + " 篇未分组"));
    }
    infoPanel.appendChild(meta);

    if (n.type === "leaf" || n.type === "family") {
      const p = document.createElement("p");
      const a = document.createElement("a");
      a.href = n.type === "leaf" ? GITHUB_TREE + n.manuscriptId : GITHUB_CONTENTS;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = n.type === "leaf" ? "在 GitHub 打开 ↗" : "在 CONTENTS.md 查看 ↗";
      p.appendChild(a);
      infoPanel.appendChild(p);
    }

    infoPanel.hidden = false;
  }

  /* ---------------- 交互 ---------------- */

  function setExpanded(n, want) {
    const was = state.expanded.has(n.id);
    if (want === undefined) want = !was;
    if (want === was) return;
    if (want) state.expanded.add(n.id);
    else state.expanded.delete(n.id);

    if (n.type === "discipline") {
      announce((want ? "已展开 " : "已收起 ") + n.title + (want ? "，" + n.famCount + " 个族" : ""));
      if (n.mPlusEl) n.mPlusEl.textContent = want ? "" : "+";
    } else if (n.type === "family") {
      announce((want ? "已展开 " : "已收起 ") + "问题族 #" + n.fid + (want ? "，" + n.children.length + " 篇手稿" : ""));
    }
    if (n.innerEl) n.innerEl.setAttribute("opacity", want ? "0" : "1");
    if (n.el && n.children.length) n.el.setAttribute("aria-expanded", want ? "true" : "false");
    if (n.mEl && n.children.length) n.mEl.setAttribute("aria-expanded", want ? "true" : "false");
    layoutSvgText(n);
    render({ animate: true });
  }

  function selectNode(n) {
    if (state.selected === n.id) {
      state.selected = null;
      closeInfo();
    } else {
      state.selected = n.id;
      openInfo(n);
    }
    updateSelectionMarks();
    announce("已选中 " + n.title);
  }

  function activate(n) {
    if (!n) return;
    if (n.children.length) setExpanded(n);
    selectNode(n);
    setFocus(n, false);
  }

  function setFocus(n, doScroll) {
    if (state.focusElPrev) {
      state.focusElPrev.classList.remove("is-focus");
      state.focusElPrev = null;
    }
    state.focusId = n ? n.id : null;

    if (!n) {
      focusEl.classList.remove("is-on");
      svgEl.removeAttribute("aria-activedescendant");
      listEl.removeAttribute("aria-activedescendant");
      return;
    }

    const el = state.mode === "mobile" ? n.mEl : n.el;
    if (el && !state.pointerFocus) {
      el.classList.add("is-focus");
      state.focusElPrev = el;
    }

    if (state.mode === "mobile") {
      listEl.setAttribute("aria-activedescendant", n.mEl ? "tree-m" + n.domId : "");
      svgEl.removeAttribute("aria-activedescendant");
    } else {
      svgEl.setAttribute("aria-activedescendant", n.domId);
      listEl.removeAttribute("aria-activedescendant");
      if (n._y != null && !state.pointerFocus) {
        /* h = 行高 - 2：2px 描边居中画在矩形边上，外缘正好落在行内，
           13px 叶行距下不会碰到相邻行（学科 30 / 族 20 / 叶 11）。 */
        const h = Math.max(9, rowH(n) - 2);
        focusEl.setAttribute("x", 44);
        focusEl.setAttribute("width", Math.max(0, state.width - 52));
        focusEl.setAttribute("height", h);
        focusEl.setAttribute("y", -h / 2);
        focusEl.style.transform = "translateY(" + n._y + "px)";
        focusEl.classList.add("is-on");
      } else {
        focusEl.classList.remove("is-on");
      }
    }

    if (doScroll !== false && el) {
      try { el.scrollIntoView({ block: "nearest", behavior: "auto" }); } catch (e) { /* 老浏览器 */ }
    }
  }

  function highlightChain(n, on) {
    const color = n.color || UNCLASSIFIED_COLOR;
    let cur = n;
    while (cur) {
      const p = cur.linkEl;
      if (p && cur.depth >= 2) {
        if (on) {
          p.style.stroke = color;
          p.style.strokeOpacity = "0.7";
          p.style.strokeWidth = "1.6px";
        } else {
          p.style.stroke = "";
          p.style.strokeOpacity = "";
          p.style.strokeWidth = "";
        }
      }
      cur = cur.parent;
    }
  }

  function visibleNodes() {
    const out = [];
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      if (n._vis) out.push(n);
    }
    return out;
  }

  function onKeyDown(e) {
    if (!state.ready) return;
    state.pointerFocus = false;
    const list = visibleNodes();
    if (!list.length) return;
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].id === state.focusId) { idx = i; break; }
    const cur = idx >= 0 ? list[idx] : null;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocus(list[Math.min(list.length - 1, idx + 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocus(list[idx <= 0 ? 0 : idx - 1]);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!cur) { setFocus(list[0]); break; }
        if (cur.children.length && !state.expanded.has(cur.id)) {
          setExpanded(cur, true);
          setFocus(cur, true);
        } else if (cur.children.length) {
          for (let i = 0; i < list.length; i++) {
            if (list[i].parent && list[i].parent.id === cur.id) { setFocus(list[i]); break; }
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (!cur) break;
        if (cur.children.length && state.expanded.has(cur.id)) setExpanded(cur, false);
        else if (cur.parent) setFocus(cur.parent);
        break;
      case "Home":
        e.preventDefault();
        setFocus(list[0]);
        break;
      case "End":
        e.preventDefault();
        setFocus(list[list.length - 1]);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur) activate(cur);
        break;
      case "Escape":
        if (state.selected) {
          e.preventDefault();
          state.selected = null;
          closeInfo();
          updateSelectionMarks();
        }
        break;
      default:
        break;
    }
  }

  /* ---- SVG 指针命中：最近行，不用 DOM 叠放 ---- */
  let lastMoveTime = 0;
  let lastMoveIdx = -1;

  svgEl.addEventListener("pointermove", function (e) {
    if (!state.svgBuilt) return;
    const y = svgYOf(e);
    const n = rowAtY(y);
    if (!n) return;
    let idx = state.hitRows.indexOf(n);
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    const dt = now - lastMoveTime;
    const jump = Math.abs(idx - lastMoveIdx);
    const instant = (dt < 100 && jump >= 5);   /* 快速划过切 0ms，避免 band 落在指针后面 */
    if (state.hoverId === n.id && !instant) return;
    if (state.hoverId && state.hoverId !== n.id) {
      const prev = state.byId.get(state.hoverId);
      if (prev) highlightChain(prev, false);
    }
    state.hoverId = n.id;
    highlightChain(n, true);
    moveBand(n, instant);
    lastMoveTime = now;
    lastMoveIdx = idx;
  });

  svgEl.addEventListener("pointerleave", function () {
    if (state.hoverId) {
      const prev = state.byId.get(state.hoverId);
      if (prev) highlightChain(prev, false);
    }
    state.hoverId = null;
    if (state.focusId) {
      const f = state.byId.get(state.focusId);
      if (f && f._vis) moveBand(f, true);
      else hideBand();
    } else {
      hideBand();
    }
  });

  svgEl.addEventListener("click", function (e) {
    if (!state.nodes.length) return;
    const n = rowAtY(svgYOf(e));
    if (!n) {
      /* 画布空白处：关浮层 */
      if (state.selected) {
        state.selected = null;
        closeInfo();
        updateSelectionMarks();
      }
      return;
    }
    state.pointerFocus = true;
    activate(n);
    try { svgEl.focus({ preventScroll: true }); } catch (err) { svgEl.focus(); }
  });

  listEl.addEventListener("click", function (e) {
    const row = e.target && e.target.closest ? e.target.closest(".tree-mrow") : null;
    if (!row) {
      if (state.selected) {
        state.selected = null;
        closeInfo();
        updateSelectionMarks();
      }
      return;
    }
    const id = row.id.replace(/^tree-m/, "");
    const n = state.nodes.filter(function (x) { return x.domId === id; })[0];
    if (!n) return;
    state.pointerFocus = true;
    if (n.type === "discipline") {
      setExpanded(n);
      setFocus(n, false);
    } else {
      state.selected = state.selected === n.id ? null : n.id;
      if (state.selected) openInfo(n); else closeInfo();
      updateSelectionMarks();
      state.pointerFocus = true;
      setFocus(n, false);
    }
  });

  svgEl.addEventListener("keydown", onKeyDown);
  listEl.addEventListener("keydown", onKeyDown);

  svgEl.addEventListener("focus", function () {
    if (!state.focusId) {
      const list = visibleNodes();
      if (list.length) setFocus(list[0], false);
    }
  });
  listEl.addEventListener("focus", function () {
    if (!state.focusId) {
      const list = visibleNodes();
      if (list.length) setFocus(list[0], false);
    }
  });

  /* 点空白关浮层：树区内部的空白由 svg / list 的 click 自己处理，
     这里只认容器外沿（含按钮、卡片、状态层以外的区域）。 */
  frame.addEventListener("click", function (e) {
    const t = e.target;
    if (t && t.closest && (t.closest(".tree-scroll") || t.closest(".graph-info") ||
      t.closest(".tree-status") || t.closest(".tree-collapse-btn"))) return;
    if (state.selected) {
      state.selected = null;
      closeInfo();
      updateSelectionMarks();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.selected) {
      state.selected = null;
      closeInfo();
      updateSelectionMarks();
    }
  });

  /* ---- 搜索：与顶部 #graph-search 双向同步 ---- */
  let syncLock = false;
  let searchTimer = null;

  function scheduleSearch(value) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTimer = null;
      if (state.ready) applySearch(value);
    }, 120);
  }

  function onSearchInput(e) {
    if (syncLock) return;
    const v = e.target.value;
    if (e.target === searchInput) {
      if (topSearch && topSearch.value !== v) {
        topSearch.value = v;
        syncLock = true;
        try { topSearch.dispatchEvent(new Event("input")); } catch (err) { /* ignore */ }
        syncLock = false;
      }
    } else if (searchInput && searchInput.value !== v) {
      syncLock = true;
      searchInput.value = v;
      syncLock = false;
    }
    scheduleSearch(v);
  }

  if (searchInput) searchInput.addEventListener("input", onSearchInput);
  if (topSearch) topSearch.addEventListener("input", onSearchInput);

  if (collapseBtn) {
    collapseBtn.addEventListener("click", function () {
      state.expanded.clear();
      state.snapshot = null;
      if (state.selected) { state.selected = null; closeInfo(); }
      for (let i = 0; i < state.nodes.length; i++) {
        const n = state.nodes[i];
        if (n.type === "discipline") {
          if (n.innerEl) n.innerEl.setAttribute("opacity", "1");
          if (n.mPlusEl) n.mPlusEl.textContent = "+";
          if (n.el) n.el.setAttribute("aria-expanded", "false");
          if (n.mEl) n.mEl.setAttribute("aria-expanded", "false");
        } else if (n.type === "family") {
          if (n.el) n.el.setAttribute("aria-expanded", "false");
          if (n.mEl) n.mEl.setAttribute("aria-expanded", "false");
        }
      }
      applyMetrics();
      refreshLabels();
      render({ animate: true });
      announce("已收起全部学科");
    });
  }

  /* ---- 尺寸变化：窗口断点 + 滚动条出现导致的宽度变化 ---- */
  function syncViewport() {
    const next = modeFor();
    if (next !== state.mode) {
      state.mode = next;
      if (state.selected) { state.selected = null; closeInfo(); }
      applyMetrics();
      if (state.mode === "mobile") buildMobileRows(function () { render(); });
      else buildSvgRows(function () { refreshLabels(); render(); });
      return;
    }
    applyMetrics();
    refreshLabels();
    render({ animate: false });
  }

  let resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (!state.ready) return;
      syncViewport();
    }, 150);
  });

  if (typeof ResizeObserver !== "undefined") {
    let roTimer = null;
    const ro = new ResizeObserver(function () {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(function () {
        roTimer = null;
        if (!state.ready) return;
        const w = contentWidth();
        if (Math.abs(w - state.width) > 1 || modeFor() !== state.mode) syncViewport();
      }, 120);
    });
    ro.observe(scroller);
  }

  /* ---------------- 启动 ---------------- */

  function load() {
    showStatus("正在载入 18 个学科 / 751 篇手稿…");
    fetch("data/graph.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.manuscripts) || !data.manuscripts.length) {
          showStatus("结构数据未载入", "重试", load);
          return;
        }
        buildModel(data);
        if (!state.nodes.length) {
          showStatus("结构数据未载入", "重试", load);
          return;
        }
        state.expanded = new Set(defaultExpanded());
        state.mode = modeFor();
        applyMetrics();

        function start() {
          state.ready = true;
          hideStatus();
          refreshLabels();
          render();
        }
        if (state.mode === "mobile") buildMobileRows(start);
        else buildSvgRows(start);
      })
      .catch(function () {
        showStatus("结构数据未载入", "重试", load);
      });
  }

  applyMetrics();
  state.mode = modeFor();
  applyMetrics();
  load();
})();
