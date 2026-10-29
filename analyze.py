# -*- coding: utf-8 -*-
"""
analyze.py — 对 openai/math 仓库做词频分析，产出 site/data/words.json

语料口径（与 workspace readme.md 一致）：
  1. preprints/ 下每篇手稿的目录名（kebab-case 拆词）
  2. 每篇手稿 README.md 的标题行（# [Title](xxx.pdf)）

学科分类来源：overview.tex
  \cataloguesection{学科名}{序号}  → 当前学科
  \resultentry{族号}{标题}{描述}{链接} → 链接中的 preprints/<dir>/ 归入当前学科
"""
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

MATH_REPO = Path("D:/math")
OUT_JSON = Path(__file__).parent / "site" / "data" / "words.json"

TEX_PATH = MATH_REPO / "overview.tex"
PREPRINTS = MATH_REPO / "preprints"

# ---------- 停用词 ----------
STOPWORDS = set("""
a an the and or of in on for to with from by is are was were be been being
this that these those it its their his her our your my we they he she
as at into onto under over about against between among through during
can could may might will would shall should must do does did done
not no nor so than then too very just also only some such own same
other another each any all both few more most much many
new using use used uses via prove proves proved proving
non pre post per ie eg etc
 september october november december january february march april may june july august
""".split())

# README/BibTeX 模板词与仓库结构词
BOILERPLATE = set("""
openai math release preprint github com main preprints pdf article paper
readme citation bibtex misc author title howpublished year https http
href arxiv doi doc docs main tex build www
""".split())

# overview.tex 里的 LaTeX 命令残留词
TEX_JUNK = set("""
href enspace textperiodcentered mathbb mathrm mathcal mathit mathbf
q overline mathfrak textsf left right begin end item
""".split())

STOP = STOPWORDS | BOILERPLATE | TEX_JUNK

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z\-']+")


def tokenize(text: str):
    """小写化、抽词、去停用词。返回 token 列表。"""
    tokens = []
    for raw in TOKEN_RE.findall(text):
        if "-" in raw:
            parts = [p for p in raw.lower().split("-") if p and p not in STOP]
            tokens.extend(parts)
            continue
        w = raw.lower().strip("-'")
        if not w or w in STOP:
            continue
        if len(w) < 2 or (len(w) <= 2 and w not in ("pi", "mu")):
            continue
        tokens.append(w)
    return tokens


def merge_plurals(counts: Counter) -> Counter:
    """极简单复数归并：words+word 同时存在且单数词频更高时并入。"""
    merged = Counter(counts)
    for w in list(counts.keys()):
        if w.endswith("s") and len(w) > 3:
            sing = w[:-1]
            if sing in counts and counts[sing] >= counts[w]:
                merged[sing] += counts[w]
                del merged[w]
            elif w.endswith("es") and w[:-2] in counts:
                sing = w[:-2]
                if counts[sing] >= counts[w]:
                    merged[sing] += counts[w]
                    del merged[w]
    return merged


# ---------- 解析 overview.tex ----------
def parse_tex(tex_path: Path):
    """返回 (dirname -> discipline) 映射, families 列表。"""
    text = tex_path.read_text(encoding="utf-8", errors="ignore")

    def match_braces(s, i):
        """s[i] == '{'，返回 (内容, 闭括号后一位索引)。"""
        depth, j = 0, i
        while j < len(s):
            if s[j] == "{":
                depth += 1
            elif s[j] == "}":
                depth -= 1
                if depth == 0:
                    return s[i + 1 : j], j + 1
            j += 1
        raise ValueError("unbalanced braces")

    dir_to_discipline = {}
    families = []  # {num, title, discipline, dirs}
    disciplines = []
    current_disc = "Unknown"
    pos = 0
    pat = re.compile(r"\\(cataloguesection|resultentry)\b")
    while True:
        m = pat.search(text, pos)
        if not m:
            break
        if m.start() > 0 and text[m.start() - 1] == "{":
            # \newcommand{\resultentry} 定义处，跳过
            pos = m.end()
            continue
        cmd = m.group(1)
        args = []
        i = m.end()
        try:
            for _ in range(4):
                while i < len(text) and text[i] in " \t\r\n%":
                    i += 1
                if i < len(text) and text[i] == "{":
                    arg, i = match_braces(text, i)
                    args.append(arg)
                else:
                    break
        except ValueError:
            pos = m.end()
            continue
        pos = i

        if cmd == "cataloguesection":
            current_disc = args[0]
            disciplines.append(current_disc)
        elif cmd == "resultentry":
            links = args[3] if len(args) > 3 else ""
            dirs = list(dict.fromkeys(
                dm.group(1) for dm in re.finditer(r"/preprints/([^/\)]+)/", links)
            ))
            families.append({
                "num": args[0] if args else "",
                "title": args[1] if len(args) > 1 else "",
                "discipline": current_disc,
                "dirs": dirs,
            })
            for d in dirs:
                dir_to_discipline[d] = current_disc
    return dir_to_discipline, families


# ---------- README 标题 ----------
TITLE_RE = re.compile(r"^#\s+(?:\[(.*?)\]\(.*?\)|(.*))$", re.MULTILINE)


def read_title(readme_path: Path) -> str:
    try:
        head = readme_path.read_text(encoding="utf-8", errors="ignore")[:4000]
    except OSError:
        return ""
    m = TITLE_RE.search(head)
    if not m:
        return ""
    t = m.group(1) or m.group(2) or ""
    t = re.sub(r"\$[^$]*\$", " ", t)   # 去行内公式
    t = re.sub(r"\\[A-Za-z]+", " ", t)  # 去 LaTeX 命令
    return t


def clean_title(t: str) -> str:
    """README 标题清理：去 LaTeX 残留、压空白。"""
    t = re.sub(r"\\[A-Za-z]+\*?(\[[^\]]*\])?(\{[^}]*\})?", " ", t)
    t = re.sub(r"\$[^$]*\$", " ", t)
    t = re.sub(r"[{}\\^_~]", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -.:")
    return t


def dir_to_label(dirname: str) -> str:
    """目录名兜底标题：kebab-case -> words。"""
    stem = re.sub(r"-(January|February|March|April|May|June|July|August|September|October|November|December)-\d{1,2}-\d{4}$", "", dirname)
    return stem.replace("-", " ")


def main():
    if not PREPRINTS.exists():
        sys.exit(f"preprints 目录不存在: {PREPRINTS}")

    dir_to_discipline, families = parse_tex(TEX_PATH)
    print(f"[tex] families={len(families)}, mapped dirs={len(dir_to_discipline)}")

    # 手稿 -> family 映射（用于关系图）
    dir_to_family = {}
    for fam in families:
        for d in fam["dirs"]:
            dir_to_family.setdefault(d, fam["num"])

    overall = Counter()
    per_discipline = defaultdict(Counter)
    n_dirs = 0
    n_unmapped = 0

    # 关系图数据
    g_nodes = []  # family 节点
    m_nodes = []  # 手稿节点
    g_links = []  # family -> 手稿

    for d in sorted(PREPRINTS.iterdir()):
        if not d.is_dir():
            continue
        n_dirs += 1
        name = d.name
        # 去掉目录名尾部的日期 -Month-D-YYYY
        stem = re.sub(r"-(January|February|March|April|May|June|July|August|September|October|November|December)-\d{1,2}-\d{4}$", "", name)
        corpus = " ".join(stem.split("-"))

        readme = d / "README.md"
        title = read_title(readme) if readme.exists() else ""
        if title:
            corpus += " " + title

        disc = dir_to_discipline.get(name, "Unclassified")
        if name not in dir_to_discipline:
            n_unmapped += 1

        toks = tokenize(corpus)
        overall.update(toks)
        per_discipline[disc].update(toks)

        # 关系图节点
        fam_num = dir_to_family.get(name)
        m_nodes.append({
            "id": name,
            "title": clean_title(title) or dir_to_label(name),
            "family": fam_num,
            "discipline": disc,
        })

    for fam in families:
        g_nodes.append({
            "id": fam["num"],
            "title": clean_title(fam["title"]),
            "discipline": fam["discipline"],
            "n": len(fam["dirs"]),
        })
        for d in fam["dirs"]:
            g_links.append({"source": fam["num"], "target": d})

    overall = merge_plurals(overall)
    for k in per_discipline:
        per_discipline[k] = merge_plurals(per_discipline[k])

    # 词 -> 主导学科（该词词频最高的学科），供全库词云着色
    def top_cat(word, c):
        best, bestn = None, 0
        for disc, ctr in per_discipline.items():
            n = ctr.get(word, 0)
            if n > bestn:
                best, bestn = disc, n
        return best

    OVERALL_N = 250
    PER_DISC_N = 60
    overall_list = [
        {"word": w, "count": c, "cat": top_cat(w, c)}
        for w, c in overall.most_common(OVERALL_N)
    ]
    by_discipline = {
        disc: [{"word": w, "count": c} for w, c in ctr.most_common(PER_DISC_N)]
        for disc, ctr in sorted(per_discipline.items())
    }

    disc_sizes = {disc: sum(ctr.values()) for disc, ctr in per_discipline.items()}
    data = {
        "generated_at": date.today().isoformat(),
        "stats": {
            "manuscripts": n_dirs,
            "families": len(families),
            "terms": len(overall),
            "unmapped_dirs": n_unmapped,
            "snapshot": date.today().isoformat(),
            "discipline_sizes": disc_sizes,
        },
        "overall": overall_list,
        "by_discipline": by_discipline,
        "top_terms": [{"word": w, "count": c} for w, c in overall.most_common(30)],
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    graph = {
        "families": g_nodes,
        "manuscripts": m_nodes,
        "links": g_links,
    }
    GRAPH_JSON = OUT_JSON.parent / "graph.json"
    GRAPH_JSON.write_text(json.dumps(graph, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[dirs] {n_dirs}, unmapped={n_unmapped}")
    print(f"[vocab] {len(overall)} terms")
    print("[top20]", overall.most_common(20))
    print("[disciplines]", json.dumps(disc_sizes, ensure_ascii=False, indent=1))
    print(f"[out] {OUT_JSON}")
    print(f"[out] {GRAPH_JSON} nodes={len(g_nodes)+len(m_nodes)} links={len(g_links)}")


if __name__ == "__main__":
    main()
