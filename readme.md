# OpenAI 的数学 Repo 的词云分析

repo url: <https://github.com/openai/math>

OpenAI 在 2026 年 10 月 6 日公开了内部模型产出的数学手稿仓库，按 Apache-2.0 协议开源。本项目的做法很克制：不逐篇读证明，只从 `/preprints` 的目录名和每篇的 README.md 提取语料做词频分析，看这批手稿的词汇分布能说明什么。

本机 clone 的离线仓库：<D://math>。其中的 overview.tex 也很有用——学科分类和族归属关系全在它的 `\cataloguesection` / `\resultentry` 标记里。

---

## 仓库底账

- **751** 篇手稿（`preprints/` 下 751 个目录，每个目录含 README.md、PDF 和构建说明）
- **373** 个问题族（family），族内是同一结果的主证明、伴生论证、推论或另证
- **17** 个数学学科分类，来源是 `overview.tex` 里的 `\cataloguesection` 标记
- 720 个目录能从 `overview.tex` 的 `\resultentry` 链接映射到族和学科，剩下 31 个没登记，标 `Unclassified`
- 词表去重后共 **1496** 个术语

## 领域及数学名词归类

学科标签直接取自 `overview.tex`，共 17 个：

Number theory、Algebra、Algebraic and complex geometry、Real and complex analysis、Convex and metric geometry、Theoretical computer science、Dynamical systems and ergodic theory、Combinatorics、Probability and statistical mechanics、Mathematical logic、Group theory、Mathematical physics、Operator algebras、Topology、Functional analysis、Differential geometry、Partial differential equations

按词频 token 量看，占大头的是 Probability and statistical mechanics、Algebraic and complex geometry、Theoretical computer science、Mathematical physics 这几个。（注意这是 token 量，每篇手稿标题长短不一，只能当量级参考。）

全库高频词前十名：

| 词 | 频次 | | 词 | 频次 |
|---|---|---|---|---|
| conjecture | 163 | | uniform | 64 |
| dimension | 96 | | model | 64 |
| bound | 92 | | group | 57 |
| finite | 84 | | one | 54 |
| counterexample | 76 | | critical | 53 |

`conjecture` 一骑绝尘，`counterexample` 排到第五。悬案被破了相当一批，也被证伪了一批，两类结果都进了仓库。这个分布和仓库定位（对开放研究问题做模型评估）是对得上的。

## 词云

站点在 `site/`，纯静态、零构建，挂 GitHub Pages 就能用。页面结构：

1. **手稿关系图** — D3 force 力导向图。小节点是手稿，大节点是问题族，边是族归属关系；同学科的族之间另有浅色连边，让每个学科抱成一团。支持拖拽、缩放、按学科筛选、按标题搜索，点节点出详情卡。
2. **全库词云** — top 250 词，字号跟词频走，颜色按词的主导学科上。
3. **分学科词云** — 18 个学科 tab（17 个学科 + Unclassified），每个学科取 top 60 词。
4. **高频术语 Top 30 直条图**。
5. **方法说明** — 语料口径、分析边界。

数据是离线生成的两个 JSON：`site/data/words.json`（词频）和 `site/data/graph.json`（关系图），前端只负责渲染。

## 分析及制图方法

### 分析方法

分析脚本 `analyze.py`，跑一次产出两个 JSON：

```bash
python analyze.py
```

流程：

1. **解析 overview.tex**。`\cataloguesection{学科}{序号}` 给出当前学科，`\resultentry{族号}{标题}{描述}{链接}` 的第 4 个参数里挖出 `preprints/<目录名>/`，得到手稿 → 族 → 学科的映射。参数用大括号配对读取，要跳过文件头部的 `\newcommand` 定义，否则定义体会被当成第一条记录。
2. **组语料**。每个手稿目录取两段文本：目录名（去掉尾部日期，按连字符拆词）+ README.md 的标题行（README 正文很薄，主要是标题和 BibTeX）。语料口径就到这两层为止，PDF 正文没有读。
3. **分词与清洗**。小写化，正则抽英文词，过滤停用词（语法词、数字、月份、OpenAI/BibTeX 模板词、LaTeX 命令残留），连字符词拆开处理，再做一轮简单的单复数归并（`words` 并入 `word` 这类）。
4. **计数**。全局 Counter + 按学科分组的 Counter，每个词记一个主导学科（该词出现最多的学科），供全库词云着色。

### 制图方法

- **词云**：[wordcloud2.js](https://github.com/timdream/wordcloud2.js)，字重做开方映射，长尾词也能读，字号按画布尺寸自适应。
- **关系图**：[D3 v7](https://d3js.org) force 布局，两层节点。族归属边 distance 24 / strength 0.6，学科内连边 distance 42 / strength 0.25，斥力 -20。
- **配色**：纸面手稿主题（`css/style-paper.css`），暖纸底、印章红 + 墨蓝、衬线标题。v1 的冷灰蓝样式保留在 `style.css`，换回 `<link>` 即可回滚。
- wordcloud2.js 和 d3.min.js 都本地化在 `js/`，无 CDN 依赖，离线也能开。

### 本地预览

```bash
cd site
python -m http.server 8741
# 访问 http://localhost:8741
```

### 部署到 GitHub Pages

`site/` 里的内容（index.html、css/、js/、data/）放进仓库根目录，推送后在 Settings → Pages 选 main 分支 + `/ (root)` 即可。

## 边界

- 语料只有目录名和 README 标题，没读正文 PDF，反映的是命名习惯层面的分布
- 仓库收录不等于结果经过同行评审，部分结果尚未 Lean 形式化，OpenAI 自己也提示未形式化的结果可能有错
- 数据截至 2026-10-29 的仓库快照，上游更新后重跑 `analyze.py` 即可
- 单复数归并是启发式的，个别词可能没合并干净
