/* 设置面板：Key 只存 localStorage；事件绑定集中在本模块。 */
import { $ } from "./dom.js";
import { CONFIG } from "./config.js";
import { loadSettings, persistSettings, updateModeUI, isProxyAvailable } from "./llm.js";

const settingsBackdrop = $("#settingsBackdrop");
const settingsPanel = $("#settingsPanel");
const settingsMessage = $("#settingsMessage");
const settingsKey = $("#settingsKey");

function setSettingsMessage(text, kind) {
  settingsMessage.textContent = text || "";
  settingsMessage.className = "settings-message" + (kind ? " is-" + kind : "");
}

function openSettings() {
  const settings = loadSettings();
  $("#settingsEndpoint").value = settings.endpoint;
  $("#settingsModel").value = settings.model;
  settingsKey.value = "";
  settingsKey.placeholder = settings.apiKey
    ? "已保存 Key（留空则保持不变）"
    : "粘贴 Key（只保存在本机浏览器）";
  setSettingsMessage("");
  updateModeUI();
  settingsBackdrop.hidden = false;
  settingsPanel.hidden = false;
  document.body.classList.add("settings-open");
  setTimeout(function () { $("#settingsEndpoint").focus({ preventScroll: true }); }, 30);
}

function closeSettings() {
  settingsBackdrop.hidden = true;
  settingsPanel.hidden = true;
  document.body.classList.remove("settings-open");
}

$("#settingsBtn").addEventListener("click", openSettings);
$("#settingsClose").addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

$("#settingsSave").addEventListener("click", function () {
  const current = loadSettings();
  const endpoint = $("#settingsEndpoint").value.trim() || CONFIG.llm.endpoint;
  const model = $("#settingsModel").value.trim() || CONFIG.llm.model;

  if (!/^(https?:\/\/|\/)/.test(endpoint)) {
    setSettingsMessage("Endpoint 需要以 http(s):// 或 / 开头。", "error");
    return;
  }

  const apiKey = settingsKey.value.trim() || current.apiKey;
  if (!persistSettings({ endpoint: endpoint, model: model, apiKey: apiKey })) {
    setSettingsMessage("浏览器拒绝了本地存储，设置未能保存。", "error");
    return;
  }

  settingsKey.value = "";
  settingsKey.placeholder = apiKey
    ? "已保存 Key（留空则保持不变）"
    : "粘贴 Key（只保存在本机浏览器）";
  updateModeUI();

  if (isProxyAvailable()) {
    setSettingsMessage("已保存。当前走同源中转，请求由服务端携带 Key。", "ok");
  } else if (apiKey) {
    setSettingsMessage("Key 已保存到本机，但本页禁用直连，不会直接发出。请启动 server.js 同源中转后生效。", "ok");
  } else {
    setSettingsMessage("已保存。未填 Key，继续使用本地检索回答。", "ok");
  }
});

$("#settingsClear").addEventListener("click", function () {
  const current = loadSettings();
  persistSettings({ endpoint: current.endpoint, model: current.model, apiKey: "" });
  settingsKey.value = "";
  settingsKey.placeholder = "粘贴 Key（只保存在本机浏览器）";
  updateModeUI();
  setSettingsMessage("已清除本机保存的 Key，当前回到本地检索模式。", "ok");
});

document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  if (!settingsPanel.hidden) {
    closeSettings();
    return;
  }
  closeChat();
});

export { openSettings, closeSettings };
