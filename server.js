#!/usr/bin/env node
/*
 * 零依赖全栈服务：
 *   - GET  / /index.html          主页面（带 X-AI-Proxy: 1）
 *   - GET  /admin /admin.html     后台管理页
 *   - GET  /data.json             数据文件静态访问（兜底）
 *   - GET  /api/data              读 data.json
 *   - POST /api/data              写 data.json（需同源 + 简单密码）
 *   - POST /api/admin/login       后台登录
 *   - GET  /api/admin/logout      登出
 *   - GET  /api/chat              代理 Moonshot / Kimi（OpenAI 兼容）
 *   - POST /api/chat              转发对话
 *
 * 只用 Node 原生 http / fs / fetch，不装包。
 *
 * 运行：
 *   1) 把 API Key 写进同目录 .env（推荐，已被 .gitignore 忽略）
 *   2) 或临时用环境变量：MOONSHOT_API_KEY=sk-xxx node server.js
 * 可选环境变量（.env 或命令行均可，命令行优先）：
 *   MOONSHOT_API_KEY        Moonshot / Kimi API Key
 *   PORT                    默认 8787
 *   HOST                    默认 0.0.0.0
 *   MOONSHOT_API_URL        默认 https://api.moonshot.cn/v1/chat/completions
 *   MOONSHOT_MODEL          默认 kimi-k3.1-pro
 *   RATE_LIMIT_PER_MIN      每 IP 每分钟 /api/chat 次数，默认 20
 *   ALLOWED_ORIGIN          额外允许的 Origin
 *   UPSTREAM_TIMEOUT_MS     上游超时，默认 35000
 *   ADMIN_PASSWORD          后台密码（默认空字符串 → 空密码，生产环境务必设置）
 *   AI_PRIMARY              首选通道 ollama（默认）| moonshot，失败自动切另一个
 *   OLLAMA_ENABLED          是否启用本地 Ollama，默认 1；设为 0 则只走外部 API
 *   OLLAMA_BASE             默认 http://127.0.0.1:11434
 *   OLLAMA_URL              默认 {OLLAMA_BASE}/v1/chat/completions
 *   OLLAMA_MODEL            指定本地模型；留空则自动取 /api/tags 里第一个
 *   OLLAMA_TIMEOUT_MS       本地模型超时，默认 120000（本地推理较慢）
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");

// ---------- .env 加载（零依赖，须在任何环境变量读取之前执行） ----------
// 真实环境变量优先：已存在的值不会被 .env 覆盖
(function loadDotEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); }
  catch (e) { return; } // 没有 .env 就静默跳过
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq <= 0) continue;
    const key = text.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = text.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const API_URL = process.env.MOONSHOT_API_URL || "https://api.moonshot.cn/v1/chat/completions";
const API_KEY = String(process.env.MOONSHOT_API_KEY || "").trim();
const DEFAULT_MODEL = process.env.MOONSHOT_MODEL || "kimi-k3.1-pro";
const RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN || 20));
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "").trim();
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Number(process.env.UPSTREAM_TIMEOUT_MS || 35000));
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

// ---------- 本地 Ollama（OpenAI 兼容接口） ----------
const OLLAMA_ENABLED = String(process.env.OLLAMA_ENABLED || "1") !== "0";
const OLLAMA_BASE = String(process.env.OLLAMA_BASE || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_URL = process.env.OLLAMA_URL || (OLLAMA_BASE + "/v1/chat/completions");
const OLLAMA_MODEL_ENV = String(process.env.OLLAMA_MODEL || "").trim();
const OLLAMA_TIMEOUT_MS = Math.max(1000, Number(process.env.OLLAMA_TIMEOUT_MS || 120000));
// 本地小模型沿用 Kimi 的 temperature=1.0 会过于发散，默认压低；token 下限给足，避免思维链吃光后截断
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE || 0.4);
const OLLAMA_MIN_TOKENS = Math.max(1, Number(process.env.OLLAMA_MIN_TOKENS || 1600));
// 首选通道：ollama（默认）或 moonshot；任一路由失败都会自动切到另一路
const AI_PRIMARY = String(process.env.AI_PRIMARY || "ollama").toLowerCase() === "moonshot" ? "moonshot" : "ollama";

const BODY_LIMIT = 64 * 1024;      // /api/data 更大，因为整个 PROFILE+knowledge
const CHAT_BODY_LIMIT = 32 * 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;

// 项目分析相关限制
const ZIP_BODY_LIMIT = 60 * 1024 * 1024;   // 上传 zip 最大 60MB
const GITHUB_DOWNLOAD_LIMIT = 80 * 1024 * 1024;
const MAX_FILE_COUNT = 3000;                // 解压后最多文件数
const MAX_TEXT_BYTES_PER_FILE = 256 * 1024; // 单文件分析最多读 256KB
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode", "__MACOSX"]);

const INDEX_PATH = path.join(__dirname, "index.html");
const ADMIN_PATH = path.join(__dirname, "admin.html");
const DATA_PATH = path.join(__dirname, "data.json");

const ROLES = ["system", "user", "assistant"];

// ---------- 会话（简单 Cookie-based） ----------
// sessionId → { expires }
const sessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const SESSION_COOKIE = "admin_session";
// 进程级文件锁（单进程足够）
let writeLock = null;

// ---------- 工具 ----------
function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }, extraHeaders || {}));
  res.end(body);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + 60000 });
    return { ok: true, remaining: RATE_LIMIT_PER_MIN - 1 };
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { ok: true, remaining: RATE_LIMIT_PER_MIN - bucket.count };
}
const buckets = new Map();

function cleanupBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(ip);
  }
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// 二进制读取（用于 zip 上传，不能走 utf8 toString）
function readBinaryBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("上传文件过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function readCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach(function (pair) {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    out[key] = value;
  });
  return out;
}

function isAdminAuthed(req) {
  // 如果没设 ADMIN_PASSWORD，则本地开发时默认放行（方便）
  if (!ADMIN_PASSWORD) return true;
  const cookies = readCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return false;
  const s = sessions.get(sid);
  if (!s) return false;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function newSession() {
  let sid;
  do { sid = crypto.randomBytes(16).toString("hex"); } while (sessions.has(sid));
  sessions.set(sid, { expires: Date.now() + SESSION_TTL_MS });
  return sid;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expires < now) sessions.delete(sid);
  }
}

// ---------- data.json 读写（带进程级锁 + 原子写） ----------
function readDataFile() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

function validateData(obj) {
  if (!obj || typeof obj !== "object") return "data 必须是对象";
  if (!obj.profile || typeof obj.profile !== "object") return "缺少 profile";
  if (!obj.profile.identity || typeof obj.profile.identity !== "object") return "缺少 profile.identity";
  if (!Array.isArray(obj.knowledge)) return "knowledge 必须是数组";
  if (obj.knowledge.length > 2000) return "knowledge 条目过多";
  for (let i = 0; i < obj.knowledge.length; i += 1) {
    const k = obj.knowledge[i];
    if (!k || !Array.isArray(k.keywords) || typeof k.answer !== "string") {
      return "knowledge[" + i + "] 非法：需要 keywords 数组和 answer 字符串";
    }
    if (k.answer.length > 1600) return "knowledge[" + i + "].answer 过长";
  }
  return "";
}

async function writeDataFile(obj) {
  // 进程级锁，防止并发 POST 覆盖
  if (writeLock) {
    await writeLock; // 等待上一次写完
  }
  let resolveLock;
  writeLock = new Promise(function (resolve) { resolveLock = resolve; });
  try {
    obj.updatedAt = new Date().toISOString();
    if (!obj._schema) obj._schema = 1;
    const tmp = DATA_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, DATA_PATH); // 原子替换
  } finally {
    writeLock = null;
    resolveLock();
  }
}

// ---------- 静态文件托管 ----------
function serveFile(res, filePath, contentType, headers) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (error) {
    sendJson(res, 404, { ok: false, error: "文件不存在" });
    return;
  }
  res.writeHead(200, Object.assign({
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }, headers || {}));
  res.end(content);
}

function serveIndex(req, res) {
  serveFile(res, INDEX_PATH, "text/html; charset=utf-8", {
    "X-AI-Proxy": "1"
  });
}

const ASSET_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
const CSS_TYPES = {
  ".css": "text/css; charset=utf-8"
};
const JS_TYPES = {
  ".js": "text/javascript; charset=utf-8"
};

function serveStatic(req, res, pathname, prefix, dir, types) {
  const rel = decodeURIComponent(pathname.slice(prefix.length));
  const filePath = path.resolve(__dirname, dir, rel);
  const root = path.resolve(__dirname, dir) + path.sep;
  if (!filePath.startsWith(root)) {
    sendJson(res, 403, { ok: false, error: "禁止访问" });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!types[ext]) {
    sendJson(res, 404, { ok: false, error: "不支持的资源类型" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "仅支持 GET / HEAD" }, { Allow: "GET, HEAD" });
    return;
  }
  serveFile(res, filePath, types[ext]);
}

function serveAdmin(req, res) {
  if (!fs.existsSync(ADMIN_PATH)) {
    sendJson(res, 404, { ok: false, error: "admin.html 不存在" });
    return;
  }
  // admin.html 绝对禁止缓存（每次修改都要立刻生效）
  serveFile(res, ADMIN_PATH, "text/html; charset=utf-8", {
    "Cache-Control": "no-cache, no-store, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0",
    "Vary": "Accept-Encoding"
  });
}

function serveDataStatic(req, res) {
  if (!fs.existsSync(DATA_PATH)) {
    sendJson(res, 404, { ok: false, error: "data.json 不存在" });
    return;
  }
  serveFile(res, DATA_PATH, "application/json; charset=utf-8", {
    "X-AI-Proxy": "1"
  });
}

// ---------- /api/data ----------
function handleDataGet(req, res) {
  try {
    const obj = readDataFile();
    sendJson(res, 200, { ok: true, data: obj });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "data.json 读取失败" });
  }
}

async function handleDataPost(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "仅允许同源请求" });
    return;
  }
  if (!isAdminAuthed(req)) {
    sendJson(res, 401, { ok: false, error: "未登录" });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req, BODY_LIMIT);
    payload = JSON.parse(raw || "null");
  } catch (error) {
    sendJson(res, error.statusCode || 400, { ok: false, error: error.statusCode ? error.message : "请求体不是合法 JSON" });
    return;
  }

  const problem = validateData(payload);
  if (problem) {
    sendJson(res, 400, { ok: false, error: problem });
    return;
  }

  try {
    await writeDataFile(payload);
    sendJson(res, 200, { ok: true, updatedAt: payload.updatedAt });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "写入 data.json 失败" });
  }
}

// ---------- /api/admin/login/logout ----------
async function handleLogin(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "仅允许同源请求" });
    return;
  }
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const isJson = ct.includes("application/json");
  const isForm = ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data");

  let pw = "";
  try {
    const raw = await readBody(req, 4096);
    if (isJson) {
      const obj = JSON.parse(raw || "{}");
      pw = String(obj.password || "");
    } else if (isForm) {
      const pairs = new URLSearchParams(raw);
      pw = pairs.get("password") || "";
    } else {
      pw = raw.toString().trim();
      // 也尝试作为 form-data 里的 password
      if (!pw && raw.includes("password=")) {
        const idx = raw.indexOf("password=");
        pw = raw.slice(idx + 9).split("&")[0];
        pw = decodeURIComponent(pw.replace(/\+/g, " "));
      }
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "请求体解析失败" });
    return;
  }

  if (ADMIN_PASSWORD && pw !== ADMIN_PASSWORD) {
    if (isForm) {
      // form POST 失败 → 返回一个简单的错误页，带返回按钮
      const errHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录失败</title><style>body{font-family:-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f3ef}.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center}.msg{color:#d33;font-size:16px;margin:0 0 20px}.btn{display:inline-block;padding:10px 24px;background:#2b48d8;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}</style></head><body><div class="card"><p class="msg">密码错误，请重新输入</p><a class="btn" href="/admin">返回登录页</a></div></body></html>`;
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(errHtml);
    } else {
      sendJson(res, 401, { ok: false, error: "密码错误" });
    }
    return;
  }

  const sid = newSession();
  const cookie = SESSION_COOKIE + "=" + sid + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000);

  if (isForm) {
    // form POST 成功 → 返回带自动跳转的 HTML
    // 不能用 303，Safari 保存密码弹窗会阻塞重定向执行
    const okHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录成功</title>
<meta http-equiv="refresh" content="0; url=/admin">
<style>body{font-family:-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f3ef;color:#16171b}.box{text-align:center}.box h1{font-size:18px;margin:0 0 8px}.box p{color:#757a82;margin:0 0 16px}.box a{color:#2b48d8;font-weight:600}</style></head>
<body><div class="box"><h1>✓ 登录成功</h1><p>即将进入后台…</p><p>如果没有自动跳转，<a href="/admin">点这里</a></p></div>
<script>setTimeout(function(){try{location.replace("/admin");}catch(e){location.href="/admin";}},50);</script></body></html>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": cookie,
      "Cache-Control": "no-store"
    });
    res.end(okHtml);
  } else {
    // fetch JSON 方式 → 返回 JSON
    sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
  }
}

function handleLogout(req, res) {
  const cookies = readCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  sendJson(res, 200, { ok: true }, {
    "Set-Cookie": SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  });
}

// ---------- /api/chat ----------
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages 必须是非空数组";
  if (messages.length > MAX_MESSAGES) return "messages 条数超过上限";
  for (const item of messages) {
    if (!item || typeof item !== "object") return "messages 中存在非法条目";
    if (ROLES.indexOf(item.role) === -1) return "messages 中存在非法 role";
    if (typeof item.content !== "string" || item.content.length > MAX_MESSAGE_CHARS) {
      return "messages 中存在非法 content";
    }
  }
  return "";
}

// 探测本地 Ollama 是否可用（带缓存，避免每次状态查询都打一次）
let ollamaModelCache = { value: "", at: 0 };

async function probeOllama(timeoutMs) {
  if (!OLLAMA_ENABLED) return { available: false, model: "", count: 0, reason: "已禁用" };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 1200);
  try {
    const upstream = await fetch(OLLAMA_BASE + "/api/tags", { signal: controller.signal });
    if (!upstream.ok) return { available: false, model: "", count: 0, reason: "HTTP " + upstream.status };
    const data = await upstream.json();
    const models = (data && data.models) || [];
    const name = OLLAMA_MODEL_ENV || (models[0] && models[0].name) || "";
    if (name) ollamaModelCache = { value: name, at: Date.now() };
    return {
      available: Boolean(models.length || OLLAMA_MODEL_ENV),
      model: name,
      count: models.length,
      reason: models.length || OLLAMA_MODEL_ENV ? "" : "未拉取任何模型"
    };
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return { available: false, model: "", count: 0, reason: aborted ? "连接超时" : "无法连接 Ollama" };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveOllamaModel() {
  if (OLLAMA_MODEL_ENV) return OLLAMA_MODEL_ENV;
  if (ollamaModelCache.value && Date.now() - ollamaModelCache.at < 60000) return ollamaModelCache.value;
  const probe = await probeOllama(3000);
  return probe.model;
}

// 统一的上游调用：返回 { ok, status, text, error }
async function callUpstream(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      // 上游错误统一成字符串，避免前端拿到 {error:{message}} 对象后显示 [object Object]
      let msg = "";
      try {
        const j = JSON.parse(text);
        msg = (j && j.error && (j.error.message || j.error)) || (j && j.message) || "";
      } catch (e) { msg = ""; }
      if (!msg) msg = text;
      return { ok: false, status: upstream.status, text: text, error: String(msg).slice(0, 300) };
    }
    return { ok: true, status: upstream.status, text: text, error: "" };
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      text: "",
      error: aborted ? "请求超时" : ("请求失败 " + (error && error.message ? error.message : ""))
    };
  } finally {
    clearTimeout(timer);
  }
}

// 提取 OpenAI 兼容响应里的正文，用于判断是否“空回复”
function extractContent(text) {
  try {
    const j = JSON.parse(text);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    return msg && typeof msg.content === "string" ? msg.content.trim() : "";
  } catch (e) {
    return "";
  }
}

async function handleChatStatus(req, res) {
  const o = await probeOllama(1500);
  sendJson(res, 200, {
    ok: true,
    proxy: true,
    primary: AI_PRIMARY,
    model: DEFAULT_MODEL,
    keyConfigured: Boolean(API_KEY),
    ollama: {
      enabled: OLLAMA_ENABLED,
      available: o.available,
      model: o.model,
      count: o.count,
      reason: o.reason
    },
    // 本地模型可用时，即使没有外部 Key 也能用 AI 功能
    aiAvailable: o.available || Boolean(API_KEY)
  });
}

function buildOllamaBody(payload, messages, model) {
  const maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : 800;
  return {
    model: model,
    messages: messages,
    temperature: Number.isFinite(OLLAMA_TEMPERATURE) ? OLLAMA_TEMPERATURE : 0.4,
    max_tokens: Math.max(maxTokens, OLLAMA_MIN_TOKENS),
    stream: false
  };
}

function buildMoonshotBody(payload, messages, model) {
  const isKimiK3 = /^kimi-k3/i.test(model);
  let maxTokens = typeof payload.max_tokens === "number" ? payload.max_tokens : 800;
  let temperature;
  if (isKimiK3) {
    // kimi-k3 系列只接受 temperature=1，前端传任何其它值都会被上游 400 拒绝
    // 思维链也占用 max_tokens，给太小会返回空内容，这里给一个下限
    temperature = 1.0;
    maxTokens = Math.max(maxTokens, 4000);
  } else {
    temperature = typeof payload.temperature === "number" ? payload.temperature : 0.25;
  }
  const body = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
    stream: false
  };
  if (isKimiK3) {
    body.reasoning_effort = String(payload.reasoning_effort || "low");
  }
  return body;
}

async function handleChat(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: "仅允许同源请求" });
    return;
  }
  if (!OLLAMA_ENABLED && !API_KEY) {
    sendJson(res, 503, { ok: false, error: "本地 Ollama 已禁用，且未配置 MOONSHOT_API_KEY" });
    return;
  }

  const rate = checkRateLimit(clientIp(req));
  if (!rate.ok) {
    sendJson(res, 429, { ok: false, error: "请求过于频繁，请稍后再试" }, { "Retry-After": String(rate.retryAfter) });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req, CHAT_BODY_LIMIT);
    payload = JSON.parse(raw || "{}");
  } catch (error) {
    sendJson(res, error.statusCode || 400, { ok: false, error: error.statusCode ? error.message : "请求体不是合法 JSON" });
    return;
  }

  const problem = validateMessages(payload.messages);
  if (problem) {
    sendJson(res, 400, { ok: false, error: problem });
    return;
  }

  const messages = payload.messages.map(function (item) {
    return { role: item.role, content: item.content };
  });
  const requestedModel = payload.model ? String(payload.model) : DEFAULT_MODEL;

  // 通道顺序：首选通道失败后自动切到另一个
  const order = AI_PRIMARY === "moonshot" ? ["moonshot", "ollama"] : ["ollama", "moonshot"];
  const failures = [];
  let answered = null;

  for (const provider of order) {
    if (provider === "ollama") {
      if (!OLLAMA_ENABLED) { failures.push("ollama: 已禁用"); continue; }
      const model = await resolveOllamaModel();
      if (!model) { failures.push("ollama: 未检测到本地模型"); continue; }
      const result = await callUpstream(
        OLLAMA_URL,
        { "Content-Type": "application/json" },
        buildOllamaBody(payload, messages, model),
        OLLAMA_TIMEOUT_MS
      );
      if (result.ok && extractContent(result.text)) {
        answered = { text: result.text, provider: "ollama", model: model };
        break;
      }
      failures.push("ollama(" + model + "): " + (result.ok ? "返回空内容" : result.error));
    } else {
      if (!API_KEY) { failures.push("moonshot: 未配置 MOONSHOT_API_KEY"); continue; }
      const result = await callUpstream(
        API_URL,
        { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY },
        buildMoonshotBody(payload, messages, requestedModel),
        UPSTREAM_TIMEOUT_MS
      );
      if (result.ok && extractContent(result.text)) {
        answered = { text: result.text, provider: "moonshot", model: requestedModel };
        break;
      }
      failures.push("moonshot(" + requestedModel + "): " + (result.ok ? "返回空内容" : result.error));
    }
  }

  if (!answered) {
    sendJson(res, 502, { ok: false, error: "所有 AI 通道均不可用 → " + failures.join("；") });
    return;
  }

  console.log("[chat] " + answered.provider + " / " + answered.model + " 应答成功");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-AI-Provider": answered.provider
  });
  res.end(answered.text);
}

// ============================================================
//  项目分析：zip / tar.gz 解压 + GitHub 下载 + 静态代码分析
//  全部纯 Node 原生，不依赖第三方包
// ============================================================

// ---------- ZIP 解压 ----------
function extractZip(buf) {
  const out = new Map();
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;

  // 找 EOCD (0x06054b50)，从末尾往前搜最多 64KB+22
  const searchLen = Math.min(buf.length, 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - searchLen; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return out;

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0 || cdOffset >= buf.length) return out;

  let p = cdOffset;
  for (let n = 0; n < totalEntries && p < buf.length - 46; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith("/")) continue;
    if (out.size >= MAX_FILE_COUNT) break;

    // 读 local header 找到数据起始
    if (localOff + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;
    const comp = buf.slice(dataStart, dataStart + compSize);

    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else continue; // 不支持其它压缩方式
    } catch (e) { continue; }
    if (data.length !== uncompSize) { /* 容忍 */ }
    out.set(name, data);
  }
  return out;
}

// ---------- tar.gz 解压 ----------
function extractTarGz(buf) {
  const out = new Map();
  let tar;
  try { tar = zlib.gunzipSync(buf); } catch (e) { return out; }
  let off = 0;
  while (off + 512 <= tar.length) {
    if (tar[off] === 0) break; // 结束标记（全零块）
    const name = tar.toString("utf8", off, off + 100).replace(/\0/g, "");
    const sizeStr = tar.toString("utf8", off + 124, off + 136).replace(/\0/g, "").trim();
    const typeflag = String.fromCharCode(tar[off + 156]);
    const size = parseInt(sizeStr, 8) || 0;
    const next = off + 512 + Math.ceil(size / 512) * 512;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
      if (out.size < MAX_FILE_COUNT && name && !name.endsWith("/")) {
        out.set(name, tar.slice(off + 512, off + 512 + size));
      }
    }
    off = next;
  }
  return out;
}

// ---------- GitHub 仓库下载 ----------
function parseGithubUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    let repo = parts[1].replace(/\.git$/, "");
    return { owner: owner, repo: repo };
  } catch (e) { return null; }
}

// 取仓库默认分支（public repo 无需鉴权，API 限流 60 次/小时足够）
function getGithubDefaultBranch(owner, repo) {
  return new Promise(function (resolve, reject) {
    const url = "https://api.github.com/repos/" + owner + "/" + repo;
    const req = https.get(url, { headers: { "User-Agent": "resume-analyzer", "Accept": "application/vnd.github+json" } }, function (res) {
      if (res.statusCode !== 200) {
        reject(new Error("获取仓库信息失败：HTTP " + res.statusCode));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", function () {
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(info.default_branch || "main");
        } catch (e) { reject(new Error("解析仓库信息失败")); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, function () { req.destroy(); reject(new Error("获取仓库信息超时")); });
  });
}

function downloadGithubTarball(owner, repo, branch) {
  return new Promise(function (resolve, reject) {
    const url = "https://codeload.github.com/" + owner + "/" + repo + "/tar.gz/refs/heads/" + encodeURIComponent(branch);
    const req = https.get(url, { headers: { "User-Agent": "resume-analyzer" } }, function (res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        reject(new Error("下载重定向"));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error("GitHub 下载失败：HTTP " + res.statusCode));
        res.resume();
        return;
      }
      const chunks = []; let total = 0;
      res.on("data", function (c) {
        total += c.length;
        if (total > GITHUB_DOWNLOAD_LIMIT) { req.destroy(); reject(new Error("仓库过大")); return; }
        chunks.push(c);
      });
      res.on("end", function () { resolve(Buffer.concat(chunks)); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, function () { req.destroy(); reject(new Error("下载超时")); });
  });
}

// ---------- 语言分类 ----------
const EXT_LANG = {
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript",
  json: "JSON",
  py: "Python", pyw: "Python",
  java: "Java", kt: "Kotlin",
  go: "Go",
  rs: "Rust",
  c: "C", h: "C",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  scala: "Scala",
  dart: "Dart",
  vue: "Vue",
  html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", less: "Less",
  sh: "Shell", bash: "Shell",
  yml: "YAML", yaml: "YAML",
  xml: "XML",
  sql: "SQL",
  md: "Markdown",
  toml: "TOML",
  ini: "INI", cfg: "INI",
  dockerfile: "Dockerfile"
};

function langOf(name) {
  const base = path.basename(name).toLowerCase();
  if (base === "dockerfile") return "Dockerfile";
  const ext = name.split(".").pop().toLowerCase();
  return EXT_LANG[ext] || (ext ? ext.toUpperCase() : "其它");
}

function isTextFile(name) {
  const base = path.basename(name).toLowerCase();
  if (base === "dockerfile") return true;
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ["js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "py", "pyw", "java", "kt",
    "go", "rs", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "rb", "php", "swift",
    "scala", "dart", "vue", "html", "htm", "css", "scss", "less", "sh", "bash",
    "yml", "yaml", "xml", "sql", "md", "toml", "ini", "cfg", "txt", "env", "gitignore"].includes(ext);
}

function isCodeFile(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "java", "kt", "go", "rs",
    "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "rb", "php", "swift", "scala",
    "dart", "vue", "css", "scss", "less", "html"].includes(ext);
}

function shouldSkip(name) {
  const parts = name.split("/");
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  if (name.startsWith("__MACOSX/")) return true;
  return false;
}

// ---------- 静态分析 ----------
function analyzeFiles(fileMap, meta) {
  const langStats = {}; // lang -> {files, lines}
  let totalFiles = 0, totalLines = 0, commentLines = 0;
  const styleCounts = { tab: 0, sp2: 0, sp4: 0, spOther: 0, single: 0, double: 0, semi: 0, noSemi: 0, trailingComma: 0, camel: 0, snake: 0 };
  const stacks = new Set();
  const tooling = { tests: false, ci: false, lint: false, docker: false, types: false };
  const entryCandidates = [];
  let readme = null;
  let pkg = null;

  for (const [name, data] of fileMap) {
    if (shouldSkip(name)) continue;
    totalFiles += 1;
    const lang = langOf(name);
    if (!langStats[lang]) langStats[lang] = { files: 0, lines: 0 };
    langStats[lang].files += 1;

    if (!isTextFile(name)) {
      langStats[lang].lines += 0;
      continue;
    }

    // 检测文件名层面的特征
    const lower = name.toLowerCase();
    if (/(^|\/)(test|spec|tests|__tests__)/.test(lower) || /\.test\./.test(lower) || /\.spec\./.test(lower)) tooling.tests = true;
    if (lower.startsWith(".github/workflows/") || lower.includes(".gitlab-ci") || lower.includes("jenkinsfile") || lower.includes(".circleci")) tooling.ci = true;
    if (lower.includes(".eslintrc") || lower.includes(".prettierrc") || lower.includes("ruff") || lower.includes(".golangci") || lower.includes(".clang-format") || lower.includes("pylintrc") || lower.includes("flake8")) tooling.lint = true;
    if (lower === "dockerfile" || lower.endsWith("/dockerfile") || lower.includes("docker-compose") || lower.includes("containerfile")) tooling.docker = true;
    if (lower === "tsconfig.json" || lower.endsWith("/tsconfig.json")) tooling.types = true;
    if (/^readme(\.|$)/i.test(path.basename(name)) && !readme) {
      readme = data.toString("utf8", 0, Math.min(data.length, 2500));
    }
    if (path.basename(name) === "package.json" && !pkg) {
      try { pkg = JSON.parse(data.toString("utf8", 0, Math.min(data.length, 200000))); } catch (e) {}
    }

    const text = data.slice(0, MAX_TEXT_BYTES_PER_FILE).toString("utf8", 0, Math.min(data.length, MAX_TEXT_BYTES_PER_FILE));
    const lines = text.split(/\r?\n/);
    langStats[lang].lines += lines.length;
    totalLines += lines.length;

    if (isCodeFile(name)) {
      analyzeStyle(lines, styleCounts, name);
    }
  }

  // 入口候选
  for (const name of fileMap.keys()) {
    if (shouldSkip(name)) continue;
    const base = path.basename(name);
    if (/^index\.(js|ts|jsx|tsx)$/.test(base)) entryCandidates.push(name);
    else if (/^main\.(js|ts|go|rs|py|cpp|c|java)$/.test(base)) entryCandidates.push(name);
    else if (/^app\.(js|ts|py)$/.test(base)) entryCandidates.push(name);
    else if (/^server\.(js|ts)$/.test(base)) entryCandidates.push(name);
    else if (name.startsWith("src/main.") || name.startsWith("src/index.") || name.startsWith("cmd/")) entryCandidates.push(name);
  }

  // 技术栈识别
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    const keys = Object.keys(deps);
    for (const k of keys) {
      if (/react/.test(k)) stacks.add("React");
      if (/^vue$/.test(k) || /^vue@/.test(k)) stacks.add("Vue");
      if (/^next/.test(k)) stacks.add("Next.js");
      if (/^nuxt/.test(k)) stacks.add("Nuxt");
      if (/^svelte/.test(k)) stacks.add("Svelte");
      if (/^angular|^@angular/.test(k)) stacks.add("Angular");
      if (/^express$/.test(k)) stacks.add("Express");
      if (/^koa/.test(k)) stacks.add("Koa");
      if (/^@nestjs/.test(k)) stacks.add("NestJS");
      if (/^fastify/.test(k)) stacks.add("Fastify");
      if (/^vite/.test(k)) stacks.add("Vite");
      if (/^webpack/.test(k)) stacks.add("Webpack");
      if (/^tailwind/.test(k)) stacks.add("Tailwind CSS");
      if (/^typescript$/.test(k)) { tooling.types = true; stacks.add("TypeScript"); }
      if (/^eslint/.test(k)) tooling.lint = true;
      if (/^jest|^vitest|^mocha|^@testing-library/.test(k)) tooling.tests = true;
      if (/^axios/.test(k)) stacks.add("Axios");
      if (/^lodash/.test(k)) stacks.add("Lodash");
      if (/^moment|^dayjs/.test(k)) stacks.add(k.startsWith("day") ? "Day.js" : "Moment.js");
      if (/^electron/.test(k)) stacks.add("Electron");
      if (/^@types\//.test(k)) tooling.types = true;
    }
    if (pkg.type === "module") stacks.add("ESM");
  }
  // 其它语言栈
  for (const name of fileMap.keys()) {
    if (shouldSkip(name)) continue;
    const b = path.basename(name);
    if (b === "requirements.txt" || b === "Pipfile" || b === "pyproject.toml") stacks.add("Python");
    if (b === "pyproject.toml") {
      const t = fileMap.get(name).toString("utf8", 0, 4000);
      if (/django/.test(t)) stacks.add("Django");
      if (/flask/.test(t)) stacks.add("Flask");
      if (/fastapi/.test(t)) stacks.add("FastAPI");
      if (/pytest/.test(t)) tooling.tests = true;
    }
    if (b === "go.mod") {
      stacks.add("Go");
      const t = fileMap.get(name).toString("utf8", 0, 4000);
      if (/gin-gonic/.test(t)) stacks.add("Gin");
      if (/echo\.labstack/.test(t)) stacks.add("Echo");
    }
    if (b === "Cargo.toml") { stacks.add("Rust"); }
    if (b === "pom.xml") { stacks.add("Java/Maven"); }
    if (b === "build.gradle" || b.endsWith(".gradle")) { stacks.add("Java/Gradle"); }
    if (b === "composer.json") { stacks.add("PHP"); }
    if (b === "Gemfile") { stacks.add("Ruby"); }
    if (b === "tsconfig.json") tooling.types = true;
  }
  // 语言驱动的栈补充
  for (const lang of Object.keys(langStats)) {
    if (lang === "Python") stacks.add("Python");
    if (lang === "Java") stacks.add("Java");
    if (lang === "Go") stacks.add("Go");
    if (lang === "Rust") stacks.add("Rust");
    if (lang === "PHP") stacks.add("PHP");
    if (lang === "Vue") stacks.add("Vue");
  }

  const languages = Object.entries(langStats)
    .map(([lang, s]) => ({ lang: lang, files: s.files, lines: s.lines }))
    .sort((a, b) => b.lines - a.lines);

  const style = summarizeStyle(styleCounts, totalLines);
  const commentRatio = totalLines > 0 ? +(commentLines / totalLines).toFixed(2) : 0;

  return {
    source: meta.source,
    repoUrl: meta.repoUrl || "",
    name: meta.name || guessProjectName(meta, fileMap, pkg),
    languages: languages,
    totalFiles: totalFiles,
    totalLines: totalLines,
    commentRatio: commentRatio,
    style: style,
    stack: Array.from(stacks),
    tooling: tooling,
    entryPoints: entryCandidates.slice(0, 8),
    tree: buildTree(fileMap),
    readme: readme
  };
}

function analyzeStyle(lines, c, name) {
  for (const line of lines) {
    if (!line.trim()) continue;
    // 缩进
    const lead = line.match(/^([\t ]*)/)[1];
    if (lead.length > 0) {
      if (lead[0] === "\t") c.tab++;
      else if (lead.length % 4 === 0) c.sp4++;
      else if (lead.length % 2 === 0) c.sp2++;
      else c.spOther++;
    }
    // 注释行
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("--")) continue;
    // 引号
    let sc = (line.match(/'/g) || []).length;
    let dc = (line.match(/"/g) || []).length;
    c.single += sc; c.double += dc;
    // 分号
    if (/;\s*$/.test(line)) c.semi++; else c.noSemi++;
    // 尾逗号
    if (/,\s*[}\]]/.test(line)) c.trailingComma++;
    // 命名采样
    const idents = line.match(/\b(?:function|const|let|var|def|func|fn|val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g);
    if (idents) {
      for (const m of idents) {
        const id = m.split(/\s+/).pop();
        if (/^[a-z]/.test(id) && /[A-Z]/.test(id)) c.camel++;
        else if (id.includes("_")) c.snake++;
      }
    }
  }
}

function summarizeStyle(c, totalLines) {
  const indentSum = c.tab + c.sp2 + c.sp4 + c.spOther;
  let indent = "unknown";
  if (indentSum > 0) {
    const p = (x) => x / indentSum;
    if (p(c.tab) > 0.5) indent = "tab";
    else if (p(c.sp4) > 0.4) indent = "4 spaces";
    else if (p(c.sp2) > 0.4) indent = "2 spaces";
    else indent = "mixed";
  }
  const quoteSum = c.single + c.double;
  let quotes = "mixed";
  if (quoteSum > 0) {
    if (c.single / quoteSum > 0.7) quotes = "single";
    else if (c.double / quoteSum > 0.7) quotes = "double";
  }
  const semiSum = c.semi + c.noSemi;
  let semicolons = "mixed";
  if (semiSum > 0) {
    if (c.semi / semiSum > 0.7) semicolons = "always";
    else if (c.noSemi / semiSum > 0.8) semicolons = "rare";
  }
  const nameSum = c.camel + c.snake;
  let naming = "mixed";
  if (nameSum > 0) {
    if (c.camel / nameSum > 0.7) naming = "camelCase";
    else if (c.snake / nameSum > 0.7) naming = "snake_case";
  }
  return {
    indent: indent,
    quotes: quotes,
    semicolons: semicolons,
    trailingComma: c.trailingComma > 20,
    naming: naming
  };
}

function guessProjectName(meta, fileMap, pkg) {
  if (pkg && pkg.name) return pkg.name;
  if (meta.repoUrl) {
    const parts = meta.repoUrl.replace(/\.git$/, "").split("/");
    return parts[parts.length - 1] || "project";
  }
  return "project";
}

function buildTree(fileMap) {
  const top = {};
  for (const name of fileMap.keys()) {
    if (shouldSkip(name)) continue;
    const parts = name.split("/");
    const t = parts[0];
    if (!top[t]) top[t] = { dirs: new Set(), files: 0 };
    if (parts.length === 1) top[t].files++;
    else {
      const sub = parts[1];
      if (parts.length > 2) top[t].dirs.add(sub + "/");
      else top[t].files++;
    }
  }
  const entries = Object.entries(top).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [];
  for (const [t, info] of entries) {
    const subCount = info.dirs.size;
    const suffix = subCount ? `+${subCount} 子目录` : `${info.files} 文件`;
    lines.push(`├─ ${t}/  (${suffix})`);
  }
  return lines.join("\n");
}

// ---------- 分析接口处理函数 ----------
async function handleAnalyzeZip(req, res) {
  if (!isSameOrigin(req)) { sendJson(res, 403, { ok: false, error: "仅允许同源请求" }); return; }
  if (!isAdminAuthed(req)) { sendJson(res, 401, { ok: false, error: "未登录" }); return; }
  let buf;
  try { buf = await readBinaryBody(req, ZIP_BODY_LIMIT); }
  catch (e) { sendJson(res, e.statusCode || 400, { ok: false, error: e.message }); return; }
  if (!buf.length) { sendJson(res, 400, { ok: false, error: "上传文件为空" }); return; }

  let fileMap;
  try { fileMap = extractZip(buf); }
  catch (e) { sendJson(res, 400, { ok: false, error: "zip 解压失败：" + e.message }); return; }
  if (fileMap.size === 0) { sendJson(res, 400, { ok: false, error: "zip 内没有可分析的文件" }); return; }

  try {
    const analysis = analyzeFiles(fileMap, { source: "zip", name: "" });
    sendJson(res, 200, { ok: true, analysis: analysis });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "分析失败：" + e.message });
  }
}

async function handleAnalyzeGithub(req, res) {
  if (!isSameOrigin(req)) { sendJson(res, 403, { ok: false, error: "仅允许同源请求" }); return; }
  if (!isAdminAuthed(req)) { sendJson(res, 401, { ok: false, error: "未登录" }); return; }
  let payload;
  try {
    const raw = await readBody(req, 8192);
    payload = JSON.parse(raw || "{}");
  } catch (e) { sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); return; }

  const url = String(payload.url || "").trim();
  const parsed = parseGithubUrl(url);
  if (!parsed) { sendJson(res, 400, { ok: false, error: "不是合法的 GitHub 仓库地址（支持 https://github.com/owner/repo）" }); return; }

  let branch, tar;
  try {
    branch = await getGithubDefaultBranch(parsed.owner, parsed.repo);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: "获取仓库信息失败（仓库不存在或为私有？）：" + e.message });
    return;
  }
  try { tar = await downloadGithubTarball(parsed.owner, parsed.repo, branch); }
  catch (e) { sendJson(res, 502, { ok: false, error: "下载仓库失败：" + e.message }); return; }

  let fileMap;
  try { fileMap = extractTarGz(tar); }
  catch (e) { sendJson(res, 400, { ok: false, error: "tar.gz 解压失败：" + e.message }); return; }
  if (fileMap.size === 0) { sendJson(res, 400, { ok: false, error: "仓库为空或解析失败" }); return; }

  try {
    const analysis = analyzeFiles(fileMap, { source: "github", repoUrl: url, name: parsed.repo });
    sendJson(res, 200, { ok: true, analysis: analysis });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: "分析失败：" + e.message });
  }
}

// ---------- 路由 ----------
const server = http.createServer(function (req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, "http://" + (req.headers.host || "localhost")).pathname;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "非法请求路径" });
    return;
  }
  // 规范化：去掉末尾斜杠
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  if (req.method === "OPTIONS") {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "仅允许同源请求" });
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    });
    res.end();
    return;
  }

  // /api/data
  if (pathname === "/api/data") {
    if (req.method === "GET") { handleDataGet(req, res); return; }
    if (req.method === "POST") { handleDataPost(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET / POST" }, { Allow: "GET, POST" });
    return;
  }

  // /api/admin/session —— 返回当前 session 状态（admin.html 用它决定是否显示登录表单）
  if (pathname === "/api/admin/session") {
    if (req.method === "GET") {
      if (!isSameOrigin(req)) { sendJson(res, 403, { ok: false, error: "仅允许同源请求" }); return; }
      sendJson(res, 200, { ok: true, authed: isAdminAuthed(req), passwordConfigured: Boolean(ADMIN_PASSWORD) });
      return;
    }
    sendJson(res, 405, { ok: false, error: "仅支持 GET" }, { Allow: "GET" });
    return;
  }
  // /api/admin/login / logout
  if (pathname === "/api/admin/login") {
    if (req.method === "POST") { handleLogin(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 POST" }, { Allow: "POST" });
    return;
  }
  if (pathname === "/api/admin/logout") {
    if (req.method === "GET") { handleLogout(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET" }, { Allow: "GET" });
    return;
  }

  // /api/chat
  if (pathname === "/api/chat") {
    if (req.method === "GET") { handleChatStatus(req, res); return; }
    if (req.method === "POST") { handleChat(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET / POST" }, { Allow: "GET, POST" });
    return;
  }

  // /api/admin/analyze/zip —— 上传 zip 分析
  if (pathname === "/api/admin/analyze/zip") {
    if (req.method === "POST") { handleAnalyzeZip(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 POST" }, { Allow: "POST" });
    return;
  }
  // /api/admin/analyze/github —— GitHub 公开仓库分析
  if (pathname === "/api/admin/analyze/github") {
    if (req.method === "POST") { handleAnalyzeGithub(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 POST" }, { Allow: "POST" });
    return;
  }

  // 静态页面
  if (pathname === "/" || pathname === "/index.html") {
    if (req.method === "GET" || req.method === "HEAD") { serveIndex(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET / HEAD" });
    return;
  }
  if (pathname === "/admin" || pathname === "/admin.html") {
    if (req.method === "GET" || req.method === "HEAD") { serveAdmin(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET / HEAD" });
    return;
  }
  if (pathname === "/data.json") {
    if (req.method === "GET" || req.method === "HEAD") { serveDataStatic(req, res); return; }
    sendJson(res, 405, { ok: false, error: "仅支持 GET / HEAD" });
    return;
  }
  if (pathname.startsWith("/assets/")) {
    serveStatic(req, res, pathname, "/assets/", "assets", ASSET_TYPES);
    return;
  }
  if (pathname.startsWith("/css/")) {
    serveStatic(req, res, pathname, "/css/", "css", CSS_TYPES);
    return;
  }
  if (pathname.startsWith("/js/")) {
    serveStatic(req, res, pathname, "/js/", "js", JS_TYPES);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not Found" });
});

if (!API_KEY) {
  console.warn("[server] 未设置 MOONSHOT_API_KEY：Ollama 不可用将没有外部兜底。");
}
if (!ADMIN_PASSWORD) {
  console.warn("[server] 未设置 ADMIN_PASSWORD，后台 /api/data POST 将不需要密码（本地开发方便，生产环境务必设置）。");
}

setInterval(cleanupBuckets, 60000).unref();
setInterval(cleanupSessions, 60000).unref();

server.listen(PORT, HOST, function () {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log("[server] 主页面  http://" + shown + ":" + PORT + "/");
  console.log("[server] 后台    http://" + shown + ":" + PORT + "/admin");
  console.log("[server] 数据    GET  /api/data   POST /api/data");
  console.log("[server] AI 改写 POST /api/chat");
  console.log("[server]   ├ 首选    " + (AI_PRIMARY === "ollama" ? "Ollama " + OLLAMA_BASE : "Moonshot " + DEFAULT_MODEL));
  console.log("[server]   └ 兜底    " + (AI_PRIMARY === "ollama" ? "Moonshot " + DEFAULT_MODEL : "Ollama " + OLLAMA_BASE));
  if (OLLAMA_ENABLED) {
    probeOllama(1200).then(function (o) {
      console.log("[server] Ollama 状态：" + (o.available ? "可用（" + o.model + "，共 " + o.count + " 个模型）" : "不可用（" + o.reason + "）"));
    });
  } else {
    console.log("[server] Ollama 状态：已禁用（OLLAMA_ENABLED=0）");
  }
  console.log("[server] 项目分析 POST /api/admin/analyze/zip | /api/admin/analyze/github");
});
