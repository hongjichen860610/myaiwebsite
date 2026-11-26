/* 会话可变状态：由 llm 与 chat 模块共享，避免两者互相 import 形成循环依赖。
   初始化顺序由 main.js 统一编排。 */

export const chatHistory = [];

export function resetHistory() {
  chatHistory.length = 0;
}
