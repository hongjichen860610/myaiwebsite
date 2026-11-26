/* CONFIG：本地检索 + 可选 AI 改写；无 Key 时纯本地运行。 */
export const CONFIG = {
  llm: {
    // OpenAI 兼容地址；部署模式下由 server.js 的 MOONSHOT_API_URL 覆盖
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "kimi-k3.1-pro",
    // kimi-k3 系列强制 temperature=1；其他模型可改 0.25
    temperature: 1.0,
    // kimi-k3 是推理模型，需要显式 reasoning_effort；low 省 token、改写一句话足够
    reasoningEffort: "low",
    maxTokens: 800,
    // 本地 Ollama 推理较慢（8b 模型单次约 20s），超时给足避免被前端提前中断
    timeoutMs: 60000,
    historyLimit: 6,          // LLM 模式携带最近 6 条对话
    proxyPath: "/api/chat"    // server.js 提供的中转接口
  },
  storageKey: "chenhongji_ai_settings_v1",
  // 公网部署时禁用浏览器直连：Key 只能走同源中转（server.js），
  // 防止访问者绕过代理直接打上游或把 Key 暴露给脚本。
  // 只有在本地 `file://` / 静态演示时才改为 true。
  allowDirect: false
};
