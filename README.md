# 简历 AI 小程序

个人简历主页 + AI 对话助手：默认纯本地检索（零依赖、不联网），可选接入本地 Ollama 或 Moonshot/Kimi 做自然语言改写。附带一个后台页面，用于维护 `data.json` 中的简历内容。

## 本地运行

```bash
node server.js
```

打开 http://localhost:8787/ 查看主页，http://localhost:8787/admin 进入后台。

如需启用 AI 改写，复制 `.env.example` 为 `.env` 并填入自己的配置。`.env` 已被忽略，不会进入仓库。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.html` | 主页：静态骨架、样式、页面渲染、本地检索、对话面板 |
| `admin.html` | 后台：编辑简历内容与知识库 |
| `server.js` | Node 服务：静态托管、`/api/data` 读写、AI 中转 |
| `data.json` | 简历内容与问答知识库（站点运行数据） |
| `.env.example` | 环境变量示例，复制为 `.env` 后使用 |

部署到 GitHub Pages 等纯静态环境时，页面会回退到 `data.json` 和内联兜底数据，对话仍可用本地检索模式。

## 隐私说明

原始简历 PDF、`.env`（含 API Key 与后台密码）、截图等产物均不纳入版本控制。仓库只保留源码与站点运行所需的内容数据。
