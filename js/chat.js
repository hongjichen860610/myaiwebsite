/* 对话面板：消息渲染、发送、移动端抽屉。 */
import { $, esc } from "./dom.js";
import { ID, getInitial } from "./profile.js";
import { chatHistory, resetHistory } from "./state.js";
import { search, fallbackAnswer } from "./knowledge.js";
import { generateAnswer } from "./llm.js";

const chatBody = $("#chatBody");
const chatInput = $("#chatInput");
const chatForm = $("#chatForm");
const chatSend = $("#chatSend");
const chatPanel = $("#chatPanel");
const chatBackdrop = $("#chatBackdrop");
let chatting = false;
let typingEl = null;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function formatAnswer(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function scrollChatToBottom() {
  chatBody.scrollTop = chatBody.scrollHeight;
}

function addMessage(role, text) {
  const message = document.createElement("div");
  message.className = "msg " + role;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "assistant" ? getInitial() : "HR";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = formatAnswer(text);

  message.appendChild(avatar);
  message.appendChild(bubble);
  chatBody.appendChild(message);
  scrollChatToBottom();
  return message;
}

function showTyping() {
  hideTyping();
  typingEl = document.createElement("div");
  typingEl.className = "msg assistant typing";
  typingEl.innerHTML = '<div class="msg-avatar">' + esc(getInitial()) + '</div>' +
    '<div class="bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
  chatBody.appendChild(typingEl);
  scrollChatToBottom();
}

function hideTyping() {
  if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
  typingEl = null;
}

function greetingText() {
  return "你好，我是" + ID.name + "的 AI 版简历助手。\n关于我的经历、项目、技术栈和求职意向，都可以直接问我；简历里没有的信息，我会如实说明，不会编造。";
}

function resetConversation() {
  chatBody.innerHTML = "";
  resetHistory();
  const greeting = greetingText();
  addMessage("assistant", greeting);
  chatHistory.push({ role: "assistant", content: greeting });
}

function resizeInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 104) + "px";
}

function updateSendState() {
  chatSend.disabled = chatting || !chatInput.value.trim();
}

async function sendMessage(raw) {
  const question = String(raw || "").trim();
  if (!question || chatting) return;

  chatting = true;
  addMessage("user", question);
  chatHistory.push({ role: "user", content: question });
  chatInput.value = "";
  resizeInput();
  updateSendState();
  showTyping();

  let answer = "";
  try {
    const result = await generateAnswer(question);
    answer = result.text;
  } catch (error) {
    console.warn("[AI 简历助手] 生成失败，已回退到本地知识库：", error);
    const hits = search(question);
    answer = hits.length ? hits[0].answer : fallbackAnswer();
  }

  hideTyping();
  addMessage("assistant", answer);
  chatHistory.push({ role: "assistant", content: answer });
  chatting = false;
  updateSendState();
}

/* ---------- 移动端抽屉 ---------- */
const mobileQuery = window.matchMedia("(max-width: 980px)");

function isMobile() {
  return mobileQuery.matches;
}

function syncChatA11y() {
  if (isMobile()) {
    chatPanel.setAttribute("aria-hidden", document.body.classList.contains("chat-open") ? "false" : "true");
  } else {
    chatPanel.removeAttribute("aria-hidden");
  }
}

function openChat() {
  if (!isMobile()) {
    chatInput.focus({ preventScroll: true });
    return;
  }
  document.body.classList.add("chat-open");
  syncChatA11y();
  setTimeout(scrollChatToBottom, 360);
}

function closeChat() {
  if (!isMobile()) return;
  document.body.classList.remove("chat-open");
  syncChatA11y();
}

function handleViewportChange() {
  if (!isMobile()) document.body.classList.remove("chat-open");
  syncChatA11y();
}

export {
  resetConversation, sendMessage, syncChatA11y, openChat, closeChat,
  handleViewportChange, resizeInput, updateSendState, isMobile,
  chatBody, chatInput, chatForm, chatSend, chatBackdrop, mobileQuery
};
