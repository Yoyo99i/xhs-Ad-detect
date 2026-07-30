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
    "- 一句话结论：……（用「疑似营销话术浓度」表述，不下定性结论）",
    "判断风险等级时，除了命中维度的数量和程度，还要看「营销话术密度」——即笔记中活动促销信息、品牌标签、营销话术等商业内容占整篇笔记的比重。如果笔记虽短但几乎句句都是营销话术（例如活动日期/价格/加购规则写得比正常分享更具体、标签中品牌相关标签占比过半等），即使命中的维度不多，也应上调风险等级。",
    "",
    "## 评分依据",
    "只列出实际命中的维度。每条格式：'③ 绝对化用语（程度：中）：\"修护界扛把子\"'。不要出现 0.16 这类权重数字，用户看不懂。未命中的维度不要提。",
    "",
    "## 小贴士",
    "面向看到这份报告的普通读者。这只是 AI 的风险提示，不下定性的广告结论，语气要委婉、留有余地，像朋友善意提醒，不要用'拆穿''罪证''违规'这类定性词。",
    "要求：",
    "1. 先从笔记里挑 1-2 句最像营销的话，用引号引出，然后用你自己的话、结合这篇笔记的具体内容表达'这个说法值得多想想'的意思。每篇笔记的写法应不同，禁止使用'读到这里可以多想一下'等固定模板句式，也不要用'这类话术听听就好''这种效果承诺无科学依据'等生硬定性句子；",
    "2. 如果命中多个维度，用加粗短词分点（例如**贬低竞品**、**效果说得太满**、**文末催囤货**），每个加粗词后面必须紧跟着一句带引号的具体证据原文，例如'**贬低竞品**：\"某某牌子就是表面功夫\"'，'**效果说得太满**：\"红直接退了一大半\"'，'**文末催囤货**：\"618直接囤它几盒\"'。不能只写概括词不给证据；",
    "3. 品类科普（必须）：如果正文涉及护肤/美妆/化妆品/医护/医美/保健品等，必须给一句与该品类相关的常识提醒——例如护肤类写'护肤品效果因人而异，敏感肌先局部试用'、晒后/皮肤问题写'严重时建议就医，别只靠护肤品'、内服/保健类写'保健食品不能替代药物，有不适请咨询医生'。具体内容根据正文实际涉及的品类来写，不要生搬硬套；",
    "4. 结尾给 1-2 条温和建议，必须针对这篇笔记的具体情况来写（推什么产品/什么活动/什么品类就围绕它给建议），不要每次写一样的通用句子。不要用'勿冲动囤货''依法举报'这类强硬措辞；",
    "5. 总字数 150-320 字，可以用'多想一下''未必''也可能'等留有余地的词；",
    "6. 禁止写'本结果由AI生成'等免责声明（页面底部已有）。",
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

  return json(res, 404, { error: "Not found", code: "NOT_FOUND" });
});

server.listen(PORT, () => {
  console.log(`xhs-fanche server on :${PORT}`);
  console.log(`IS_API_KEY set? ${process.env.IS_API_KEY ? "yes" : "NO — set it first"}`);
});
