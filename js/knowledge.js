/* 本地知识库检索：事实锁定层。
   检索算法原样保留，仅把 KNOWLEDGE_INDEX 从全局隐式变量改为模块内部状态。
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
      answer: entry.answer,
      keywords: entry.keywords
        .map(normalizeText)
        .filter(Boolean)
        .sort(function (a, b) { return b.length - a.length; })
    };
  });
}

export function search(question) {
  const q = normalizeText(question);
  if (!q) return null;
  let best = null;
  let bestScore = 0;

  index.forEach(function (entry) {
    let score = 0;
    const matched = [];
    entry.keywords.forEach(function (term) {
      if (q.indexOf(term) === -1) return;
      if (matched.some(function (longer) { return longer.indexOf(term) !== -1; })) return;
      matched.push(term);
      score += term.length;
    });
    if (score > bestScore) {
      bestScore = score;
      best = entry.answer;
    }
  });

  return bestScore >= 2 ? best : null;
}

export function fallbackAnswer() {
  return "这个我不确定，你可以直接联系我：电话 **" + ID.phone + "**，邮箱 **" + ID.email + "**。\n也可以换个问法，比如问我「做过什么项目」「技术栈熟练度」「期望薪资」。";
}

/* 首屏兜底数据立即建索引；异步加载 data.json 后由 main.js 调用 rebuild() 覆盖。 */
import { PROFILE } from "./profile.js";
rebuild(PROFILE.knowledge);
