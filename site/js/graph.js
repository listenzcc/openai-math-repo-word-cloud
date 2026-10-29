/* 手稿关系图 — D3 force 力导向布局 */
"use strict";

(function () {
  const PALETTE = [
    "#a63d2f", "#2f5d8a", "#3f6f4f", "#8a6d2f", "#6b4f8a",
    "#2f7d8a", "#a34a6b", "#5a7d2f", "#b05a2f", "#4646b0",
    "#2f7a6b", "#7d5a2f", "#54427a"
  ];
  const UNCLASSIFIED_COLOR = "#a49d8d";

  const svg = d3.select("#family-graph");
  const frame = svg.node().parentElement;
  const infoPanel = document.getElementById("graph-info");

  const W = () => frame.clientWidth;
  const H = () => 640;

  svg.attr("viewBox", [0, 0, W(), H()]);

  const g = svg.append("g"); // zoom 容器
  const gLinks = g.append("g");
  const gNodes = g.append("g");
  const gLabels = g.append("g");

  svg.call(d3.zoom().scaleExtent([0.3, 6]).on("zoom", (e) => {
    g.attr("transform", e.transform);
  }));

  let allNodes = [], allLinks = [];
  let nodeSel, linkSel, labelSel;
  let sim;

  const colorMap = {};
  function assignColors(disciplines) {
    const sorted = [...disciplines].sort();
    sorted.forEach((d, i) => {
      colorMap[d] = d === "Unclassified" ? UNCLASSIFIED_COLOR : PALETTE[i % PALETTE.length];
    });
  }
  const colorOf = (d) => colorMap[d.discipline] || UNCLASSIFIED_COLOR;

  function showInfo(d) {
    const isFamily = d.type === "family";
    const gh = isFamily
      ? "https://github.com/openai/math/blob/main/CONTENTS.md"
      : `https://github.com/openai/math/tree/main/preprints/${d.id}`;
    infoPanel.hidden = false;
    infoPanel.innerHTML =
      `<button class="info-close" aria-label="关闭">×</button>` +
      `<p class="info-type">${isFamily ? "问题族 Family #" + d.id : "手稿 Manuscript"}</p>` +
      `<p class="info-title">${d.title || d.id}</p>` +
      `<p class="info-meta">学科：<b style="color:${colorOf(d)}">${d.discipline}</b>` +
      (isFamily ? ` · 含手稿 ${d.n} 篇` : "") +
      `</p>` +
      `<p><a href="${gh}" target="_blank" rel="noopener">在 GitHub 打开 ↗</a></p>`;
    infoPanel.querySelector(".info-close").onclick = () => { infoPanel.hidden = true; };
  }

  function applyFilter() {
    const disc = document.getElementById("graph-discipline").value;
    const q = document.getElementById("graph-search").value.trim().toLowerCase();
    const anyFilter = !!disc || !!q;

    const visible = new Set();
    allNodes.forEach(n => {
      const okDisc = !disc || n.discipline === disc;
      const okQ = !q || (n.title && n.title.toLowerCase().includes(q));
      if (okDisc && okQ) visible.add(n.id);
    });

    nodeSel.attr("opacity", n => visible.has(n.id) ? 1 : 0.06);
    linkSel.attr("opacity", l =>
      visible.has(l.source.id) && visible.has(l.target.id) ? 0.35 : 0.02);
    labelSel.attr("opacity", n =>
      visible.has(n.id) && n.type === "family" ? 0.9 : 0);
  }

  function build(data) {
    const famNodes = data.families.map(f => ({ ...f, type: "family", r: 7 }));
    const msNodes = data.manuscripts.map(m => ({ ...m, type: "ms", r: 3.5 }));
    allNodes = [...famNodes, ...msNodes];

    // 组内连边：同学科的族节点串成链，让每个学科聚成一团
    const byDisc = {};
    famNodes.forEach(n => {
      (byDisc[n.discipline] = byDisc[n.discipline] || []).push(n);
    });
    const groupLinks = [];
    Object.values(byDisc).forEach(list => {
      for (let i = 1; i < list.length; i++) {
        groupLinks.push({ source: list[i - 1].id, target: list[i].id, group: true });
      }
    });
    allLinks = [...groupLinks, ...data.links];

    assignColors([...new Set(allNodes.map(n => n.discipline))]);

    // 学科下拉
    const sel = document.getElementById("graph-discipline");
    [...new Set(allNodes.map(n => n.discipline))].sort().forEach(d => {
      const o = document.createElement("option");
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    });

    // 位置初始化：族在中心，手稿围绕
    allNodes.forEach(n => {
      n.x = W() / 2 + (Math.random() - 0.5) * 400;
      n.y = H() / 2 + (Math.random() - 0.5) * 400;
    });

    linkSel = gLinks.selectAll("line")
      .data(allLinks).join("line")
      .attr("stroke", d => d.group ? "#e6e0d2" : "#d0c9ba")
      .attr("stroke-width", d => d.group ? 1.2 : 0.6);

    nodeSel = gNodes.selectAll("circle")
      .data(allNodes, d => d.type + d.id).join("circle")
      .attr("r", d => d.r)
      .attr("fill", colorOf)
      .attr("stroke", d => d.type === "family" ? "#ffffff" : "none")
      .attr("stroke-width", d => d.type === "family" ? 1.2 : 0)
      .attr("cursor", "pointer")
      .on("click", (e, d) => { e.stopPropagation(); showInfo(d); });

    labelSel = gLabels.selectAll("text")
      .data(allNodes.filter(n => n.type === "family"), d => d.id)
      .join("text")
      .text(d => d.title.length > 34 ? d.title.slice(0, 32) + "…" : d.title)
      .attr("font-size", 9)
      .attr("fill", "#26221c")
      .attr("font-family", 'Georgia, "STZhongsong", "SimSun", serif')
      .attr("paint-order", "stroke")
      .attr("stroke", "rgba(255,253,248,.85)")
      .attr("stroke-width", 2.5)
      .attr("pointer-events", "none");

    sim = d3.forceSimulation(allNodes)
      .force("link", d3.forceLink(allLinks).id(d => d.id)
        .distance(d => d.group ? 42 : 24).strength(d => d.group ? 0.25 : 0.6))
      .force("charge", d3.forceManyBody().strength(-20))
      .force("collide", d3.forceCollide().radius(d => d.r + 2))
      .force("center", d3.forceCenter(W() / 2, H() / 2))
      .alphaDecay(0.03)
      .on("tick", ticked);

    nodeSel.call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

    svg.on("click", () => { infoPanel.hidden = true; });

    document.getElementById("graph-count").textContent =
      `${allNodes.length} 个节点（${famNodes.length} 族 + ${msNodes.length} 篇手稿）、${data.links.length} 条族归属边（另有组内连边 ${groupLinks.length} 条用于聚团）`;

    applyFilter();
  }

  function ticked() {
    linkSel
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeSel
      .attr("cx", d => d.x).attr("cy", d => d.y);
    labelSel
      .attr("x", d => d.x + 9).attr("y", d => d.y + 3);
  }

  document.getElementById("graph-search").addEventListener("input", applyFilter);
  document.getElementById("graph-discipline").addEventListener("change", applyFilter);
  document.getElementById("graph-reheat").addEventListener("click", () => {
    if (sim) { sim.alpha(1).restart(); }
  });

  fetch("data/graph.json")
    .then(r => r.json())
    .then(build)
    .catch(err => {
      document.getElementById("graph-count").textContent = "graph.json 加载失败：" + err;
    });
})();
