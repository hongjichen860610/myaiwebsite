/* 编排入口：只负责初始化顺序、数据加载与事件绑定，不放业务逻辑。 */
import { $ } from "./dom.js";
import { PROFILE, applyRemoteData } from "./profile.js";
import { rebuild } from "./knowledge.js";
import { renderProfile } from "./render.js";
import { updateModeUI, detectProxy } from "./llm.js";
import {
  resetConversation, sendMessage, syncChatA11y, openChat, closeChat,
  handleViewportChange, resizeInput, updateSendState, chatInput, chatForm, chatSend,
  chatBackdrop, mobileQuery
} from "./chat.js";
import { openSettings, closeSettings } from "./settings-ui.js";

/* ---------- 初始化顺序：渲染 → 对话 → A11y → 模式 → 代理探测 ---------- */
renderProfile();
resetConversation();
syncChatA11y();
updateModeUI();
detectProxy();

/* ---------- 数据层：/api/data → /data.json → 内联 PROFILE ---------- */
(async function bootstrap() {
  async function tryFetch(url) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j) return null;
      // server.js /api/data 返回 { ok:true, data:{profile,knowledge} }
      // Pages 上 /data.json 直接返回 { _schema, profile, knowledge }
      if (j.data && j.data.profile && Array.isArray(j.data.knowledge)) return j.data;
      if (j.profile && Array.isArray(j.knowledge)) return j;
      return null;
    } catch (e) { return null; }
  }

  let loaded = await tryFetch("/api/data");
  if (!loaded) loaded = await tryFetch("/data.json");
  if (!loaded) return; // 保持内联 PROFILE

  applyRemoteData(loaded);
  rebuild(PROFILE.knowledge);
  // 欢迎语依赖姓名，异步覆盖后必须重渲染 + 重置对话
  renderProfile();
  resetConversation();
})();

/* ---------- 对话事件 ---------- */
Array.prototype.forEach.call(document.querySelectorAll("[data-open-chat]"), function (button) {
  button.addEventListener("click", openChat);
});
$("#chatFab").addEventListener("click", openChat);
$("#chatClose").addEventListener("click", closeChat);
chatBackdrop.addEventListener("click", closeChat);
$("#chatReset").addEventListener("click", function () {
  resetConversation();
  chatInput.focus({ preventScroll: true });
});

$("#chatChips").addEventListener("click", function (event) {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  sendMessage(chip.getAttribute("data-q") || chip.textContent);
});

chatInput.addEventListener("input", function () {
  resizeInput();
  updateSendState();
});

chatInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!chatSend.disabled) sendMessage(chatInput.value);
  }
});

chatForm.addEventListener("submit", function (event) {
  event.preventDefault();
  sendMessage(chatInput.value);
});

/* ---------- 全局 Escape：先关设置，再关对话抽屉 ---------- */
document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  if (!$("#settingsPanel").hidden) {
    closeSettings();
    return;
  }
  closeChat();
});

if (mobileQuery.addEventListener) {
  mobileQuery.addEventListener("change", handleViewportChange);
} else if (mobileQuery.addListener) {
  mobileQuery.addListener(handleViewportChange);
}
