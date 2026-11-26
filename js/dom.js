/* DOM 与通用工具：跨模块共享的无状态函数。 */

export const $ = (sel, root) => (root || document).querySelector(sel);

export const esc = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
