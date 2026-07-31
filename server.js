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

// 反馈存储文件（追加 JSONL，零依赖）
const FEEDBACK_FILE = path.join(__dirname, "feedback.jsonl");

function buildPrompt(noteText) {
  return [
    "请直接对【笔记正文】做软广/违规风险分析，只输出最终报告，不要解释、不要复述。",
    "",
    "规则：",
    "1. 不要复述本指令，不要复述知识库内容，不要复述笔记原文；",
    "2. 不要输出'以上信息均提取自'、'如需对具体笔记进行评分'等套话；",
    "3. 总字数不超过 400 字；",
    "4. 先单独输出一行 ---BEGIN---，然后严格按下面三段输出 Markdown 报告，不要额外内容。",
    "",
    "## 摘要",
    "- 风险等级：低 / 中 / 高",
    "- 一句话结论：……（用「疑似营销话术浓度」表述，不下定性结论）。注意：若风险等级为「中」，结论里必须同时保留「也可能只是普通分享/真实体验」的余地，避免只强调营销嫌疑造成误伤；若风险等级为「高」，可指出营销结构明显但仍用「疑似」；若风险等级为「低」，直接肯定更像真实分享。",
    "风险等级判定规则（必须遵守，提升可信度）：",
    "1. 仅命中 1 个维度且该维度程度为「轻」或「中」，同时整篇笔记的营销话术密度不高（商业信息占比低、没有密集出现促销/价格/加购/限时/品牌标签过半等），应判为「低」风险。",
    "2. 命中 1 个维度但程度为「重」，或笔记虽短但营销话术密度极高，才可上调至「中」风险。",
    "3. 命中 2 个及以上维度，或存在「重」度维度，或营销话术密度很高，才判为「中」或「高」风险。",
    "4. 高风险需要多个维度命中且包含「重」度，或全文几乎句句营销、结构非常明显。",
    "",
    "## 评分依据（这是给前端解析用的核心段落，绝对不能省略）",
    "必须列出所有实际命中的维度，即使只命中 1 个也要写。每条严格使用格式：'③ 绝对化用语（程度：中）：\"修护界扛把子\"｜贡献：12%'。",
    "说明：",
    "1. '程度'只能是轻/中/重三者之一，后面必须紧跟带引号的具体证据原文。",
    "2. '｜贡献：XX%' 是必填项，表示这个维度对整体风险的加权贡献百分比，计算方式：先按程度取系数（轻=0.33、中=0.66、重=1.0），乘以该维度权重（推广未标明0.22、利益未披露0.18、绝对化用语0.16、隐性营销意图0.14、功效夸张0.12、信息可信度0.10、情绪裹挟0.08），所得小数乘以 100 四舍五入取整，写成整数百分比。例：绝对化用语程度=中 → 0.66×0.16=0.1056 → 贡献约 11%（写 11%）。",
    "3. 不要出现 0.16 这种原始权重小数在除贡献字段外的位置；未命中的维度不要提。",
    "4. 各命中维度的贡献百分比之和不必等于 100%，它们只是各自维度的独立权重贡献。",
    "",
    "## 小贴士",
    "面向看到这份报告的普通读者。这是 AI 的风险提示，不下定性的广告结论，语气要像朋友善意提醒，留有余地。",
    "格式要求（必须严格遵守，输出为三段，段落之间用空行分隔）：",
    "第一段：先挑出笔记里 1-2 句最值得多想想的话，用引号引出，并用自己的话、结合这篇笔记的具体内容解释“这个说法为什么值得留意”。这一段不要出现加粗的维度标签。",
    "第二段：空一行后，用加粗短词分点列出实际命中的维度（每个加粗词必须对应“评分依据”里列出的某个维度名），每个点后紧跟带引号的具体证据原文，说明它在这篇笔记里如何体现。如果只有一个命中维度，也单独成段。",
    "第三段：再空一行，先给一句与正文实际品类相关的常识提醒，然后附 1-2 条温和、具体的建议。建议必须针对这篇笔记的具体情况写，不要每次一样，也不要用“勿冲动囤货”“依法举报”等强硬措辞。",
    "通用约束：",
    "- 禁止出现“任务已完成”“以上”“综上所述”“本结果”“本次分析”“总而言之”等 AI 套话；",
    "- 多用“多想一下”“未必”“也可能”“说不定”等留有余地的词；",
    "- 总字数 120-260 字；",
    "- 禁止写“本结果由AI生成”等免责声明（页面底部已有）。",
    "",
    "【笔记正文】",
    noteText
  ].join("\n");
}

// 清洗：AI 有时会复述 prompt/知识库/笔记原文，找真正的报告起点
function cleanResult(text) {
  if (!text) return text;
  text = text.trim();
  // 优先找 AI 按指令输出的 ---BEGIN---（取最后一个，避免 prompt echo 的假标记）
  const beginMarker = "---BEGIN---";
  let idx = text.lastIndexOf(beginMarker);
  if (idx >= 0) return text.slice(idx + beginMarker.length).trim();
  // 兜底：找最后一个 "## 摘要" 或 "摘要"
  idx = text.lastIndexOf("## 摘要");
  if (idx > 0) return text.slice(idx).trim();
  idx = text.lastIndexOf("摘要");
  if (idx > 0 && idx > text.length - 200) return text.slice(idx).trim();
  return text;
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
            console.log(`[poll] taskIdIS=${taskIdIS} msgs=${msgs.length} textMsgs=${tm.length}`);
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
              if (d.message?.say === "text" && d.message.text && !d.message.partial) { texts.push(d.message.text); console.log(`[sse] text len=${d.message.text.length}`); }
            } catch {}
          }
        }
      }
    }
    done = true;
    try { reader.cancel(); } catch {}
    try { await poll; } catch {}

    let result = texts.length ? texts.join("\n\n") : null;
    result = cleanResult(result);
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

  // 意见反馈：POST /api/feedback  → 追加写入 feedback.jsonl（零依赖，国内可达）
  // 方案 A：不再在线上直连 SMTP（OnRender 免费版出站 SMTP 465 被 ETIMEDOUT 拦截），
  // 反馈先可靠落盘，后续由 agently-mail 定时读取 feedback.jsonl 转发到 QQ 邮箱。
  if (req.url === "/api/feedback" && req.method === "POST") {
    let raw = "";
    for await (const c of req) raw += c;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "Invalid JSON", code: "BAD_BODY" }); }
    const message = (body.message || "").toString().trim();
    if (!message) return json(res, 400, { error: "message is required", code: "MISSING_MSG" });
    const rec = {
      ts: new Date().toISOString(),
      name: (body.name || "").toString().slice(0, 60),
      email: (body.email || "").toString().slice(0, 120),
      message: message.slice(0, 2000),
      ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0]
    };
    try {
      fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + "\n", "utf-8");
      console.log(`[feedback] saved: ${rec.name || "(匿名)"} ${rec.message.length}字`);
    } catch (e) {
      return json(res, 500, { error: "write failed", code: "WRITE_FAIL" });
    }
    return json(res, 200, { ok: true });
  }

  // 反馈导出：GET /api/feedback/export  → 返回全部反馈 JSON 数组（供 agently-mail 等读取）
  if (req.url === "/api/feedback/export" && req.method === "GET") {
    try {
      if (!fs.existsSync(FEEDBACK_FILE)) return json(res, 200, { ok: true, count: 0, items: [] });
      const lines = fs.readFileSync(FEEDBACK_FILE, "utf-8").split("\n").filter(Boolean);
      const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return json(res, 200, { ok: true, count: items.length, items });
    } catch (e) {
      return json(res, 500, { error: "read failed", code: "READ_FAIL" });
    }
  }

  return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
});

server.listen(PORT, () => {
  console.log(`xhs-fanche server on :${PORT}`);
  console.log(`IS_API_KEY set? ${process.env.IS_API_KEY ? "yes" : "NO — set it first"}`);
});
