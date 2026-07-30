# InfiniSynapse Vibe Coding 参赛项目 · 对话续接包

> 用途：当对话上下文将满或已新开对话时，把本文件贴给 WorkBuddy（或让它读本文件），即可无缝续做「小红书种草翻车检测」项目。
> **最后更新：2026-07-30 11:15**。所有产出均在 `C:\Users\kkqkk\WorkBuddy\2026-07-28-16-06-24\` 下。
> ⚠️ 本文件比 7/29 版重大更正：真实 API 是 **SSE 异步**（不是 /v1/query 同步），后端已重写为 `server.js`。

---

## 一、项目一句话

做一个**能上线、真人能用、后台真调 InfiniSynapse 自带 agent 做分析**的小应用：用户**粘贴小红书笔记正文** → 后端用 SSE 异步驱动 IS agent（挂自建评分知识库）→ 返回「软广风险分析报告（Markdown）」。参赛平台：InfiniSynapse × CSDN，截止 **2026-07-31 23:59**，评审期到 **8/11**。

---

## 二、当前进度（执行清单 S0–S3）

| 步骤 | 状态 | 在哪 | 说明 |
|------|------|------|------|
| S0.1 开账号拿 API Key | ✅ 已完成 | IS | **用户已持有 Key**（sk- 开头，不写入本文件，部署时填环境变量 `IS_API_KEY`） |
| S0.2 官方接口核查 | ✅ 已完成（**已实测更正**） | WB | **真实 API 是 SSE 异步**，不是大赛示例的 /v1/query（实测 404）。正确端点见第三节 |
| S0.3 评分维度权重定稿 | ✅ 已完成 | WB | 7 维权重定稿，见第五节 |
| S1.1 建评分知识库 | ✅ 已完成 | IS | 知识库 `Ad_risk_scoring_dimensions` + 数据源 `xhs_kb_file`，已启用、双向绑定。知识库 ID=`bbdcaa3b-7881-4470-a4e2-8c75af6dcb95`（enabled=1） |
| S1.2 写后端转发层 | ✅ 已完成 | WB | `server.js`（agentic SSE 异步流程，纯 Node 零依赖）。已删旧版 `api/analyze.js`、`dev-server.js` |
| S1.3 写前端页 | ✅ 已完成（7/30） | WB | `public/index.html`：粘贴框 + 调 `/api/analyze` + marked.js 渲染；首屏显示「## 摘要」、点"查看评分依据"折叠「## 评分依据」7 维明细。后端 prompt 已改三段式（## 摘要/## 评分依据/## 给普通用户的提醒）供前端按锚点拆分 |
| S1.4 联调验证 | ⏳ 合并到 S1.6 后执行 | WB→IS | **跳过本地 PowerShell 测试**（中文编码坑+502），改为部署后真浏览器 fetch 验证 |
| S1.5 端到端跑通 1 篇 | ⏳ 合并到 S1.6 后执行 | WB | 部署后在真浏览器粘贴首篇笔记，验证 agent 是否真检索知识库、是否按三段式输出 |
| S1.6 部署拿公网 URL | ⬜ 下一步 | OnRender | 常驻 Node 服务（start=node server.js），环境变量 `IS_API_KEY`。**不用 Vercel**（短超时扛不住分钟级 SSE 任务）。部署完成后同时完成 S1.4 和 S1.5 的验证 |
| S2.1 维度渲染+合规措辞 | ⬜ 待做 | WB | 结果首屏给摘要，点"查看评分依据"展开 7 维；一律"疑似"，附免责条 |
| S2.2 分享卡片 | ⬜ 待做 | WB | |
| S2.3 隐私/关于弹层 | ⬜ 待做 | WB | 法务硬约束 |
| S2.4 预置 demo 笔记 | ⬜ 待做 | WB | 自写 3 篇脱敏 |
| S2.5 申请 SSO 凭证（可选） | ⬜ 待做 | IS | 拉新计分开关，有余力再接 |
| S2.6 SSO 回调处理（可选） | ⬜ 待做 | WB | |
| S3.1 UI 打磨 | ⬜ 待做 | WB | |
| S3.2 写 API 集成说明 | ⬜ 待做 | WB | 提交硬门槛材料 |
| S3.3 比赛提交 | ⬜ 待做 | IS | |
| S3.4 运营拉新到 8/11 | ⬜ 待做 | WB+IS | 提交非终点 |

**下一步建议**：做 **S1.6 部署**（把 `server.js` + `public/` 一起部署到 OnRender，start=node server.js，环境变量配 `IS_API_KEY`），部署后用真浏览器访问 OnRender 提供的 URL，粘贴一篇笔记测一次端到端（自动 UTF-8，验证 agent 是否真检索知识库 + 是否按三段式输出 + 首屏摘要/折叠明细是否正常）。

---

## 三、关键 API 事实（实测确证，最重要）

### ⚠️ 大赛示例的 `POST api.infinisynapse.cn/v1/query` 是错的/已废弃（实测 404）

**真实 API 是 SSE 异步模式，Base = `https://app.infinisynapse.cn`，前缀 `/api`：**

| 用途 | 方法 + 路径 | 说明 |
|------|------------|------|
| 开事件流（收结果） | `GET /api/ai/events?connId=<随机串>` | SSE 长连接，`Accept: text/event-stream`，Header 带 `Authorization: Bearer <Key>` |
| 发任务 | `POST /api/ai/message` | body `{"type":"newTask","text":"...","connId":"<同上>"}`，返回 201 success |
| 轮询任务列表 | `GET /api/ai_task/list?page=1&pageSize=5` | 拿历史任务 |
| 知识库启用 | `POST /api/ai_rag_sdk/enabled` | 启用后 agent 才会检索知识库 |
| 列知识库 | `GET /api/ai_rag_sdk/all` | 拿知识库 enabled 状态 |

**完整流程（server.js 已实现）**：开 SSE 连接 → POST newTask → 从 SSE 流收 `taskId` + 最终结果 → 等任务 `status=completed` → 提取 agent 产出文本返回前端。任务跑 30s~2min 不等。

### 知识库挂载
- 知识库 `Ad_risk_scoring_dimensions` 已在控制台「启用」（开关=开=enabled=1），与数据源 `xhs_kb_file` 双向绑定。
- **newTask 没有 data_source 字段**——靠 prompt 引导 agent 去检索知识库（server.js 的 buildPrompt 已写"请检索知识库"）。
- 知识库 ID：`bbdcaa3b-7881-4470-a4e2-8c75af6dcb95`

---

## 四、关键决策与更正（已写入报告，复盘用）

1. **输入方式**：只做「粘贴正文」，砍掉链接直采（浏览器端撞 CORS + 小红书反爬）。
2. **API 选型（重大更正）**：**真实是 SSE 异步**，非同步 /v1/query。大赛示例端点已失效，必须走 `/api/ai/message` + `/api/ai/events`。
3. **用 IS 自带 agent 的 agentic 模式（方向 A）**：用户确认"用它的 agent 最符合命题要求"。不强求 JSON 输出，后端收完 agent 流，把最终 Markdown 报告透传前端渲染。部署平台不能用 Vercel 短超时，改用 OnRender 常驻 Node。
4. **知识库策略**：自建 RAG 知识库（广告法禁用词 + 软广话术 + 7 维权重）作为 agent 检索源，解决"无用户库"问题。已建好并启用。
5. **计分命门**：评分 60% = 注册用户 30% + 活跃使用 30%，**以 InfiniSynapse 平台后台为准，自己埋点不算**；拉新需接 SSO（申请 clientId/secret）。
6. **提交非终点**：评审 8/1–8/11 仍采集数据，提交后须运营拉新到 8/11。
7. **合规硬约束（法务）**：结果页用"疑似营销话术"而非定性"软广"；必须含"AI 生成、仅供参考、非官方认定"免责条 + 隐私弹层。

---

## 五、红线（必须遵守）

- 🔴 **API Key 不进聊天明文、不硬编码、不进前端**。归宿 = 部署平台环境变量（如 `IS_API_KEY`），`server.js` 读 `process.env.IS_API_KEY`。本文件也不写 Key 值。
- 🔴 **WorkBuddy 帮你调 InfiniSynapse 只是调试流量，不计比赛分**。真实分数 = 真实用户通过公网应用触发分析。
- 🔴 **联调建议用户本地或部署后真浏览器测**，Key 只在用户侧/部署平台出现。

---

## 六、评分维度权重定稿（7 维，和=1.00）

| 维度 | 权重 | 严重度（轻/中/重） | 主要出处 |
|------|------|------------------|---------|
| ① 商业标识缺失（有链接无"广告"标识） | **0.22** | 0.5/1/1.5 | 《互联网广告管理办法》§9(3) |
| ② 利益未披露（暗示合作/收赠品） | **0.18** | 0.5/1/1.5 | 办法§9 |
| ③ 绝对化用语（最/第一/100%） | **0.16** | 0.5/1/1.5 | 广告法禁用词 |
| ④ 隐性营销意图（场景软植/情感绑架） | **0.14** | 0.5/1/1.5 | ELM 边缘路径 |
| ⑤ 功效夸张（承诺见效/变相疗效） | **0.12** | 0.5/1/1.5 | 办法§8 |
| ⑥ 信息可信度/证据密度 | **0.10** | 0.5/1/1.5 | 沈娇娇2024 |
| ⑦ 情绪裹挟（焦虑/煽动） | **0.08** | 0.5/1/1.5 | 办法§11 |

> 增强维度（单篇不计分，仅辅助）：⑧ 内容同质化 ⑨ 发布者行为。前端"查看评分依据"展开时可用。

---

## 七、文件清单（工作目录 `C:\Users\kkqkk\WorkBuddy\2026-07-28-16-06-24\`）

| 文件 | 用途 | 状态 |
|------|------|------|
| **`server.js`** | **后端核心**：SSE 异步驱动 IS agent，持有 Key，转发 /api/analyze，零依赖纯 Node；新增同源静态托管 `public/index.html` | ✅ **最新，S1.2 产物，7/30 改 prompt 三段式+托管前端** |
| **`public/index.html`** | **前端页（S1.3 产物）**：粘贴框 + 调 `/api/analyze` + marked.js 渲染；首屏摘要、点"查看评分依据"折叠 7 维明细；免责条固定 | ✅ **最新** |
| **`package.json`** | scripts.start=node server.js，标记 Node>=18 | ✅ |
| **`.env.example`** | 环境变量示例（IS_API_KEY / FRONTEND_ORIGIN），注释含知识库 ID | ✅ |
| `infinisynapse_xiaohongshu_fanche_report.html` | 主报告（Part A–F） | ✅ 参考 |
| `infinisynapse_exec_plan_cn.html` / `.txt` | 中文执行清单 19 步 | ✅ 参考 |
| `infinisynapse_api_check_s02.html` | S0.2 接口核查（注意：内含旧 /v1/query 假设，已被实测推翻，看时以本 HANDOFF 第三节为准） | ⚠️ 部分过时 |
| `infinisynapse_scoring_dimensions_s03.html` | S0.3 权重定稿 | ✅ |
| `is_server_api_ref.html` | 官方 Server API Reference 抓本（异步 SSE 真实文档源） | ✅ 权威 |
| `infinisynapse_kb_content.md` | RAG 知识库上传素材（禁用词表/办法原文/7维权重+证据句/prompt/合规约束/增强维度） | ✅ 已上传 |
| ~~`api/analyze.js`~~ / ~~`dev-server.js`~~ | **已删除**（基于错误 /v1/query 假设） | ❌ 废弃 |

---

## 八、新对话如何接手（三选一）

**方式 A（推荐，最省事）**：新对话第一句贴——
> 读 `C:\Users\kkqkk\WorkBuddy\2026-07-28-16-06-24\PROJECT_HANDOFF.md`，继续做「小红书种草翻车检测」参赛项目，现在做 **S1.6 部署**（把 `server.js` + `public/` 部署到 OnRender，start=node server.js，环境变量配 `IS_API_KEY`），后端和前端页均已就绪。

**方式 B**：直接把本文件全文贴进新对话（内容更长但更完整）。

**方式 C**：开新对话说「继续 InfiniSynapse 种草翻车项目」+ 提一下关键事实（真实 API 是 SSE 异步、后端是 server.js、下一步 S1.3），WorkBuddy 可用 conversation_search 检索本对话历史。

> 注意：新对话的 AI 自动拥有**同一工作目录**的读权限，无需你手动传文件或"授权访问"。只要它知道去读哪个文件（如本 HANDOFF），就能看到全部进度和文件。

---

## 九、待补 / 风险

- ⚠️ **/v1/query 同步端点不存在**：任何基于它的旧代码/报告都已失效，以本 HANDOFF 第三节 SSE 流程为准。
- ⚠️ **agent 可能自由发挥**：实测曾见 agent 自启 SQL/评分引擎。server.js 的 prompt 已约束"只输出分析报告、不建系统"，但需前端+部署后真测验证它听话。
- ⚠️ **知识库是否在 agent 产出中真正被检索**：靠 prompt 引导，未 100% 验证。若结果未体现禁用词判断，需再调 prompt 或确认 RAG 挂载。
- ⚠️ **时间紧**：截止 7/31 仅约 1.5 天（当前 7/30 凌晨），优先 S1.3→S1.6 跑通上线，S2/S3 有余力再做。

---

*本续接包由 WorkBuddy 在 7/30 上下文将满时更新，覆盖 7/29 版所有过时假设（v1/query 同步 → SSE 异步）。项目所有产出均已落盘，不会因对话结束而丢失。*
