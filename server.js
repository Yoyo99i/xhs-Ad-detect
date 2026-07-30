/**
 * 小红书种草翻车检测 — 后端转发服务（方向 A：用 InfiniSynapse 自带 agent）
 * 零依赖（纯 Node http，Node>=18 原生 fetch），方便部署到 OnRender
 *
 * 架构：前端 POST /api/analyze → 立即返回 taskId（不等待）→ 后台异步跑 agent
 *       前端轮询 GET /api/status?taskId= → 拿到结果
 * 这样绕开 OnRender 免费版约 50s 的单次请求超时，用户不用干等。
 *
 * 红线：API Key 只在本服务进程环境变量，绝不进前端/仓库/聊天
 *
 * 本地测试：
 *   $env:IS_API_KEY="你的key"   (PowerShell)
 *   node server.js
 *   另开窗口：curl -X POST http://localhost:3000/api/analyze -H "Content-Type: application/json" -d "{\"note_text\":\"测试\"}"
 *             → 拿到 taskId，再 curl http://localhost:3000/api/status?taskId=xxx
 *
 * 部署 OnRender：start command = node server.js，环境变量配 IS_API_KEY 与 PORT=3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const IS_BASE = "https://app.infinisynapse.cn";
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 180000; // agentic 任务可能 1-3 分钟，给 180s 上限

// 内存任务表：taskId -> {status:'running'|'done'|'error', result, error}
const taskStore = new Map();

function buildPrompt(noteText) {
  return [
    "你是一个小红书种草内容审核助手。请检索知识库「Ad_risk_scoring_dimensions」中的广告法禁用词与评分维度，对以下笔记做软广/违规风险分析。",
    "",
    "严格按以下 Markdown 结构输出，总字数不超过 400 字，不要输出结构之外的内容：",
    "",
    "## 摘要",
    "- 风险等级：低 / 中 / 高",
    "- 一句话结论：……（用「疑似营销话术浓度」表述，不下定性结论）",
    "",
    "## 评分依据",
    "逐条列出命中的维度（引用知识库维度名与权重）、严重度（轻/中/重）、证据原文句；未命中的维度也简要说明未触发。",
    "",
    "## 给普通用户的提醒",
    "……",
    "",
    "重要约束：不要创建文件、不要执行 SQL、不要调用任何工具、不要建评分系统、不要写代码。只需阅读笔记并直接输出上述结构报告。",
    "",
    "笔记原文：",
    noteText
  ].join("\n");
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 后台异步跑 agent，结果写进 taskStore（不占用 HTTP 连接）
async function runAnalyze(taskId, noteText, apiKey) {
  const store = taskStore.get(taskId);
  const connId = "wb-" + taskId;
  const prompt = buildPrompt(noteText);
  const startedAt = Date.now();

  try {
    // 1. 开 SSE 长连接
    const sseRes = await fetch(`${IS_BASE}/api/ai/events?connId=${connId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" }
    });
    if (!sseRes.ok || !sseRes.body) {
      store.status = "error"; store.error = "SSE_FAIL"; return;
    }
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let taskIdIS = null;
    let texts = [];
    let done = false;
    let lastEventAt = Date.now();

    // 2. 发 newTask
    const tRes = await fetch(`${IS_BASE}/api/ai/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "newTask", text: prompt, connId })
    });
    const tJson = await tRes.json().catch(() => ({}));
    if (!tJson?.data?.success) {
      try { reader.cancel(); } catch {}
      store.status = "error"; store.error = "NEWTASK_FAIL"; return;
    }

    // 3. 后台轮询任务状态
    const poll = (async () => {
      while (!done && Date.now() - startedAt < TIMEOUT_MS) {
        await sleep(4000);
        if (!taskIdIS) continue;
        try {
          const r = await fetch(`${IS_BASE}/api/ai_task/tasks?taskId=${taskIdIS}`, {
            headers: { Authorization: `Bearer ${apiKey}` }
          });
          const j = await r.json();
          const t = j?.data;
          if (t && t.isRunning === false) {
            const msgs = t.messages || [];
            const tm = msgs.filter(m => m.say === "text" && m.text);
            if (tm.length) texts = tm.map(m => m.text);
            done = true; return;
          }
        } catch {}
      }
    })();

    // 4. 读 SSE 流（拿 taskId + 实时文本 + idle 兜底）
    while (!done && Date.now() - startedAt < TIMEOUT_MS) {
      let r;
      try {
        r = await Promise.race([
          reader.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("idle10s")), 10000))
        ]);
      } catch {
        if (Date.now() - lastEventAt > 30000) { done = true; break; }
        continue;
      }
      if (r.done) break;
      if (r.value) {
        buf += dec.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw2 = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = raw2.split("\n");
          let evt = "", data = "";
          for (const l of lines) {
            if (l.startsWith("event:")) evt = l.slice(6).trim();
            else if (l.startsWith("data:")) data += l.slice(5).trim();
          }
          if (evt && evt !== "heartbeat") lastEventAt = Date.now();
          if (evt === "message.add" || evt === "message.update") {
            try {
              const d = JSON.parse(data);
              if (d.taskId && !taskIdIS) taskIdIS = d.taskId;
              if (d.message?.say === "text" && d.message.text && !d.message.partial) texts = [d.message.text];
            } catch {}
          }
        }
      }
    }
    done = true;
    try { reader.cancel(); } catch {}
    try { await poll; } catch {}

    const result = texts.length ? texts[texts.length - 1] : null;
    const elapsed = Date.now() - startedAt;
    if (!result) {
      store.status = "error"; store.error = "NO_RESULT"; return;
    }
    store.status = "done"; store.result = result;
    console.log(`[analyze] ok taskId=${taskId} isTask=${taskIdIS} ${elapsed}ms len=${result.length}`);
  } catch (e) {
    store.status = "error"; store.error = String(e && e.message || e);
    console.log(`[analyze] error taskId=${taskId} ${e && e.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = process.env.FRONTEND_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // 静态前端（同源托管，避免 CORS）：GET / 或 /index.html
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    } catch (e) {
      return json(res, 500, { error: "frontend missing", code: "NO_INDEX" });
    }
  }

  // 轮询状态
  if (req.method === "GET" && req.url.startsWith("/api/status")) {
    const u = new URL(req.url, "http://localhost");
    const taskId = u.searchParams.get("taskId");
    const s = taskId && taskStore.get(taskId);
    if (!s) return json(res, 404, { error: "unknown task", code: "NO_TASK" });
    if (s.status === "done") return json(res, 200, { ok: true, status: "done", result: s.result });
    if (s.status === "error") return json(res, 200, { ok: false, status: "error", error: s.error });
    return json(res, 200, { ok: true, status: "running" });
  }

  // 提交分析（立即返回 taskId，不等待）
  if (req.url === "/api/analyze" && req.method === "POST") {
    let raw = "";
    for await (const c of req) raw += c;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "Invalid JSON", code: "BAD_BODY" }); }

    const noteText = (body.note_text || "").toString().trim();
    const apiKey = process.env.IS_API_KEY;
    if (!apiKey) return json(res, 500, { error: "Server missing IS_API_KEY", code: "NO_API_KEY" });
    if (!noteText) return json(res, 400, { error: "note_text is required", code: "MISSING_NOTE" });
    if (noteText.length > 5000) return json(res, 400, { error: "note_text too long (max 5000)", code: "NOTE_TOO_LONG" });

    const taskId = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    taskStore.set(taskId, { status: "running" });
    runAnalyze(taskId, noteText, apiKey); // 后台跑，HTTP 立即返回
    return json(res, 200, { ok: true, taskId, status: "running" });
  }

  return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
});

server.listen(PORT, () => {
  console.log(`xhs-fanche server on :${PORT}`);
  console.log(`IS_API_KEY set? ${process.env.IS_API_KEY ? "yes" : "NO — set it first"}`);
});
