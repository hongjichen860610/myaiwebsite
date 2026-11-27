/* 本地知识库检索：事实锁定层。
   检索打分算法原样保留（关键词长度累加），只把「返回一条」改为「返回按分数排序的前三条」。
   search() 返回 [{ id, category, answer, score }]，空数组表示没找到。
   对外暴露 rebuild() / search() / fallbackAnswer()，便于后续升级检索层。 */
import { ID } from "./profile.js";

let index = [];

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s,，。？！?!、；;：:（）()\[\]【】"'“”‘’·.\-—…~～]/g, "");
}

export function rebuild(knowledge) {
  index = (knowledge || []).map(function (entry) {
    return {
      id: entry.id || "",
      category: entry.category || "",
      answer: entry.answer,
      keywords: (entry.keywords || [])
        .map(normalizeText)
        .filter(Boolean)
        .sort(function (a, b) { return b.length - a.length; })
    };
  });
}

/* 返回命中列表：分数降序，最多 top 条。阈值 2 与打分规则都不变。 */
export function search(question, top) {
  const q = normalizeText(question);
  if (!q) return [];
  const limit = Number(top) > 0 ? Number(top) : 3;
  const hits = [];

  index.forEach(function (entry) {
    let score = 0;
    const matched = [];
    entry.keywords.forEach(function (term) {
      if (q.indexOf(term) === -1) return;
      if (matched.some(function (longer) { return longer.indexOf(term) !== -1; })) return;
      matched.push(term);
      score += term.length;
    });
    if (score >= 2) {
      hits.push({ id: entry.id, category: entry.category, answer: entry.answer, score: score });
    }
  });

  hits.sort(function (a, b) { return b.score - a.score; });
  return hits.slice(0, limit);
}

export function fallbackAnswer() {
  return "这个我不确定，你可以直接联系我：电话 **" + ID.phone + "**，邮箱 **" + ID.email + "**。\n也可以换个问法，比如问我「做过什么项目」「技术栈熟练度」「期望薪资」。";
}

/* 首屏兜底数据立即建索引；异步加载 data.json 后由 main.js 调用 rebuild() 覆盖。 */
import { PROFILE } from "./profile.js";
rebuild(PROFILE.knowledge);
