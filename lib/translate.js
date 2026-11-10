/**
 * The translation desk.
 *
 * The pill lives in the native helper and is clicked outside DSH, so this module is the
 * other half: it answers "what does this word/sentence mean here" with a streamed model
 * call, keeps every answer in its own store (findable afterwards, never injected into the
 * conversation list), and serves the browser overlay that `hud-page.js` paints.
 *
 * Deliberately self-contained: it never creates a DSH session and never writes a surface
 * event. A failed LLM call leaves the record with an empty answer instead of a broken
 * conversation.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

const MAX_TEXT = 4000
const MAX_SHOT_BYTES = 12 * 1024 * 1024
const MAX_HISTORY = 200

/** Ask for a translation: the text first, the screen only when the user asks for it. */
const TRANSLATION_PROMPT = [
  '你是划词翻译/解读助手。用户选择了下面这段文字，请直接给出结果。',
  '',
  '若文字里有英文：',
  '## 翻译',
  '- 以中文为主、只夹杂英文片段时，只挑出英文部分解释：单词给出「词头 + 音标」，下面缩进两格列词性与义项；词组或整句写成 `- **原英文**：中文意思`。',
  '- 整段/整句英文时，单独给出这一段的中文译文。',
  '',
  '若文字全是中文（常见于代码、界面文案、术语）：',
  '## 解读',
  '- 用一两句话说明它在这段上下文里是什么意思；不要逐字翻译，不要罗列义项。',
  '',
  '两种情形最后都加一行：',
  '> 在本句中：<这块内容在这段上下文里到底是什么意思>',
  '',
  '不要客套，不要写「翻译：」这类标签，不要用代码块包裹结果。',
].join('\n')

/** Second pass: the same question with the frozen screen around the selection. */
const CONTEXT_PROMPT = [
  '你是屏幕内容解读助手。用户先前只发了选中的文字；现在附上一张当时的屏幕截图，',
  '截图里用坐标标注了选中内容的位置。请结合画面判断它到底指什么。',
  '',
  '规则：',
  '- 先说明这块内容出现在什么界面/文档里（应用类型、上下文在干什么）。',
  '- 再解释它在这个语境里的含义；如果它是按钮、报错、变量名或缩写，说明它在这里的作用。',
  '- 截图里的其他文字只作为背景，不要逐条翻译。',
  '- 最后一行固定写：`> 在本句中：<结合画面得出的结论>`',
  '',
  '不要客套，不要复述截图里的所有文字。',
].join('\n')

function nowIso() {
  return new Date().toISOString()
}

function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/** One-line label for the history list; the full text stays in the record. */
function titleOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat
}

export function setupTranslate(ctx, opts) {
  const route = opts.route
  const sendJson = opts.sendJson
  const readJson = opts.readJson
  const log = opts.log ?? (() => {})
  const root = opts.dir
  const shots = join(root, 'shots')
  const historyPath = join(root, 'history.json')

  try {
    mkdirSync(shots, { recursive: true })
  } catch {
    // A read-only profile is not fatal: records stay in memory for this run.
  }

  /** Newest first. Read lazily so a damaged file cannot keep the plugin from loading. */
  function loadHistory() {
    try {
      const parsed = JSON.parse(readFileSync(historyPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function saveHistory(items) {
    try {
      mkdirSync(root, { recursive: true })
      const tmp = `${historyPath}.tmp`
      writeFileSync(tmp, JSON.stringify(items.slice(0, MAX_HISTORY), null, 2), 'utf8')
      renameSync(tmp, historyPath)
    } catch (error) {
      log(`translate history save failed: ${error.message}`)
    }
  }

  function remember(entry) {
    const items = loadHistory()
    const at = items.findIndex((item) => item.id === entry.id)
    if (at >= 0) items[at] = entry
    else items.unshift(entry)
    saveHistory(items)
  }

  /** data:image/png;base64,… → file next to the history, served back by `/shot`. */
  function storeShot(id, dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
    if (!match) return null
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0 || bytes.length > MAX_SHOT_BYTES) return null
    const ext = match[1] === 'image/png' ? 'png' : match[1] === 'image/webp' ? 'webp' : 'jpg'
    const file = `${id}.${ext}`
    try {
      mkdirSync(shots, { recursive: true })
      writeFileSync(join(shots, file), bytes)
      return { file, mediaType: match[1], bytes: bytes.length }
    } catch (error) {
      log(`translate shot save failed: ${error.message}`)
      return null
    }
  }

  // ------------------------------------------------------------------ model

  /**
   * `@deepseek-ai/dsh-llm` is only resolvable through the host's own loader. It is not a
   * dependency of this package, so the import may fail on another build: fall back to
   * plain message objects, which the same API also accepts.
   */
  let llmModules
  async function loadLlmModules() {
    if (llmModules !== undefined) return llmModules
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      llmModules = {
        createSystemMessage: typeof mod.createSystemMessage === 'function' ? mod.createSystemMessage : null,
        createUserMessage: typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null,
        ReasoningEffortId: typeof mod.ReasoningEffortId === 'function' ? mod.ReasoningEffortId : null,
      }
      log('translate llm modules: host')
    } catch (error) {
      llmModules = { createSystemMessage: null, createUserMessage: null, ReasoningEffortId: null }
      log(`translate llm modules: fallback (${error.code ?? error.message})`)
    }
    return llmModules
  }

  function systemMessage(text, mods) {
    if (mods.createSystemMessage) {
      try { return mods.createSystemMessage(text) } catch { /* older signature wants a plugin */ }
      try { return mods.createSystemMessage(text, 'dsh-mini') } catch { /* fall through */ }
    }
    return { role: 'system', content: [{ type: 'text', text }] }
  }

  function userMessage(blocks, mods) {
    if (mods.createUserMessage) {
      try { return mods.createUserMessage({ source: { kind: 'user' }, content: blocks }) } catch { /* fall through */ }
    }
    return { role: 'user', content: blocks }
  }

  /** Same priority chain as the reference plugin: override → default selection → first model. */
  function pickRoute() {
    const llm = ctx.get('llm')
    try {
      const current = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (current && current.provider && current.model) return { provider: current.provider, model: current.model }
    } catch { /* the service may not be up early in boot */ }
    try {
      const providers = llm?.listProviders?.() ?? []
      for (const provider of providers) {
        const model = provider?.models?.[0]
        const modelId = typeof model === 'string' ? model : model?.id
        if (modelId) return { provider: provider.id, model: modelId }
      }
    } catch { /* nothing to pick from */ }
    return null
  }

  // ------------------------------------------------------------------ streaming

  function openStream(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    return {
      send(event, data) {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* client gone */ }
      },
      end() {
        try { res.end() } catch { /* client gone */ }
      },
    }
  }

  /**
   * Answer one request. Returns the assembled answer; the caller decides what to record.
   * `signal` is aborted when the overlay closes, which is how tokens stop being spent.
   */
  async function answer({ id, text, mode, shot, selection, screen }, signal, sse) {
    const mods = await loadLlmModules()
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有启用 llm 服务（ctx.llm 不可用）')
    const choice = pickRoute()
    if (!choice) throw new Error('找不到可用的模型')

    const blocks = []
    if (mode === 'context' && shot && shot.ref) {
      blocks.push({ type: 'image', attachment: shot.ref })
      const box = selection && selection.w > 0
        ? `截图尺寸 ${screen?.w ?? shot.width ?? 0}x${screen?.h ?? shot.height ?? 0}，选中内容在截图中的像素范围：x=${selection.x} y=${selection.y} w=${selection.w} h=${selection.h}（红框就画在这里）。`
        : `截图尺寸 ${screen?.w ?? shot.width ?? 0}x${screen?.h ?? shot.height ?? 0}。`
      blocks.push({ type: 'text', text: `${box}\n\n选中的文字：\n${text}` })
    } else {
      blocks.push({ type: 'text', text: `选中的文字：\n${text}` })
    }

    const messages = [
      systemMessage(mode === 'context' ? CONTEXT_PROMPT : TRANSLATION_PROMPT, mods),
      userMessage(blocks, mods),
    ]

    sse?.send('start', { provider: choice.provider, model: choice.model, mode })
    let answerText = ''
    // OpenCode-derived providers refuse requests without a routing header
    // (`MissingSessionID`); any stable per-request id satisfies it and keeps
    // this helper's calls out of the user's real conversations.
    const stream = llm.stream({
      provider: choice.provider,
      model: choice.model,
      sessionId: `hud-desk-${id ?? shortId()}`,
      messages,
      signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        answerText += chunk.text
        sse?.send('delta', { text: chunk.text })
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind !== 'stop') {
          const detail = chunk.reason?.failure?.message ?? chunk.reason?.failure?.code ?? kind ?? 'unknown'
          if (!answerText) throw new Error(`模型没有返回内容：${detail}`)
          sse?.send('warn', { message: String(detail) })
        }
      }
    }
    return answerText
  }

  // ------------------------------------------------------------------ routes

  /**
   * The click the helper handled: it parks one JSON file (`translate.json`) next to its
   * log; the HUD reads it and sends it to the overlay. This route lets the overlay ask for
   * that payload itself, which keeps retries and reloads cheap.
   */
  route('/translate/describe', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    let body
    try { body = await readJson(req) } catch (error) { sendJson(res, 400, { error: error.message }); return }

    const text = String(body.text ?? '').trim()
    if (text.length === 0) { sendJson(res, 400, { error: '没有选中文字' }); return }
    if (text.length > MAX_TEXT) { sendJson(res, 400, { error: '选中文字太长' }); return }
    const mode = body.mode === 'context' ? 'context' : 'translate'
    const id = typeof body.id === 'string' && /^[0-9a-f]{8,32}$/i.test(body.id) ? body.id : shortId()

    let shot = null
    if (mode === 'context') {
      // The helper saves the frozen screen itself now (`shots/<id>.png`), so the page
      // never has to carry a multi-megabyte data URL around; an explicit `body.shot`
      // still wins for older callers.
      const saved = body.shot ? storeShot(id, body.shot) : {
        file: `${id}.png`,
        mediaType: 'image/png',
        bytes: existsSync(join(shots, `${id}.png`)) ? 1 : 0,
      }
      if (saved && saved.bytes > 0) {
        const file = join(shots, saved.file)
        shot = { ref: null, file: saved.file, width: body.shotWidth, height: body.shotHeight }
        try {
          const store = ctx.get('attachments')
          if (store && typeof store.saveImages === 'function') {
            const refs = await store.saveImages([{
              data: readFileSync(file),
              mediaType: saved.mediaType,
              name: `selection-${id}.${saved.file.split('.').pop()}`,
            }])
            if (Array.isArray(refs) && refs[0]) shot.ref = refs[0]
          }
        } catch (error) {
          log(`translate attachment store failed: ${error.message}`)
        }
      }
    }

    const existing = loadHistory().find((item) => item.id === id)
    const entry = {
      id,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      title: titleOf(text),
      text,
      mode: existing?.mode === 'context' ? 'context' : mode,
      shot: shot?.file ?? existing?.shot ?? null,
      shotWidth: shot?.width ?? existing?.shotWidth ?? 0,
      shotHeight: shot?.height ?? existing?.shotHeight ?? 0,
      selection: body.selection ?? existing?.selection ?? null,
      screen: body.screen ?? existing?.screen ?? null,
      answer: existing?.answer ?? '',
      contextAnswer: existing?.contextAnswer ?? '',
      error: null,
    }

    const sse = openStream(res)
    const controller = new AbortController()
    req.on('close', () => { try { controller.abort() } catch { /* ignore */ } })
    sse.send('record', { id: entry.id, mode: entry.mode })

    try {
      const answerText = await answer({
        id: entry.id,
        text,
        mode,
        shot,
        selection: entry.selection,
        screen: entry.screen,
      }, controller.signal, sse)
      if (mode === 'context') entry.contextAnswer = answerText
      else entry.answer = answerText
      sse.send('done', { chars: answerText.length, id: entry.id })
    } catch (error) {
      const message = error.name === 'AbortError' ? '已取消' : String(error.message ?? error)
      entry.error = message
      sse.send('error', { message })
    } finally {
      remember(entry)
      sse.end()
    }
  })

  route('/translate/history', (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    const items = loadHistory().map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      title: item.title,
      mode: item.mode,
      hasShot: Boolean(item.shot),
      hasContext: Boolean(item.contextAnswer),
      chars: (item.answer ?? '').length,
    }))
    sendJson(res, 200, { ok: true, items })
  })

  route('/translate/record', (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? ''
    const item = loadHistory().find((entry) => entry.id === id)
    if (!item) { sendJson(res, 404, { error: 'not found' }); return }
    sendJson(res, 200, { ok: true, item })
  })

  route('/translate/shot', (req, res) => {
    const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? ''
    if (!/^[0-9a-f]{8,32}$/i.test(id)) { sendJson(res, 400, { error: 'bad id' }); return }
    const item = loadHistory().find((entry) => entry.id === id)
    if (!item?.shot) { sendJson(res, 404, { error: 'not found' }); return }
    const file = join(shots, item.shot)
    try {
      if (!existsSync(file)) { sendJson(res, 404, { error: 'not found' }); return }
      const bytes = readFileSync(file)
      const type = item.shot.endsWith('.png') ? 'image/png' : item.shot.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' })
      res.end(bytes)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
  })

  /** The standalone desk page. The shell opens this in its own window. */
  route('/translate/ui', (req, res) => {
    const candidates = [
      new URL('../app/translate-page.html', import.meta.url),
      new URL('./translate-page.html', import.meta.url),
    ]
    for (const file of candidates) {
      try {
        const html = readFileSync(file, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      } catch {
        // try the next layout (built tree vs. source checkout)
      }
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('translate-page.html missing')
  })

  /** Human-readable history, the thing the user can actually browse afterwards. */
  route('/translate', (req, res) => {
    const items = loadHistory()
    const rows = items.map((item) => {
      const when = String(item.createdAt ?? '').replace('T', ' ').slice(0, 16)
      const body = (item.contextAnswer || item.answer || item.error || '(没有结果)')
      return `<article><header><b>${escapeHtml(item.title)}</b><span>${escapeHtml(when)} · ${escapeHtml(item.mode === 'context' ? '结合上下文' : '翻译')}</span></header>
<pre>${escapeHtml(body)}</pre></article>`
    }).join('\n')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>翻译记录 · dsh-mini</title>
<style>
body{margin:0;padding:24px;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;background:#f7f7f8;color:#18181b}
h1{font-size:18px;margin:0 0 16px}
article{background:#fff;border:1px solid #e4e5e9;border-radius:12px;padding:14px 16px;margin:0 0 12px}
header{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:#71717a}
header b{color:#18181b;font-size:14px}
pre{margin:10px 0 0;white-space:pre-wrap;word-break:break-word;font:13px/1.7 ui-monospace,Consolas,monospace;color:#3f3f46}
.empty{color:#71717a}
</style>
<h1>翻译记录 · ${items.length} 条</h1>
${rows || '<p class="empty">还没有记录。</p>'}`)
  })

  // ------------------------------------------------------------------ housekeeping

  /**
   * The helper writes one file per click and waits for a reader. Nobody reads it if the
   * window is closed, so keep at most one stale request instead of growing forever.
   */
  /**
   * What the shell last captured. The helper writes `pending.json` (text + rectangle,
   * no pixels) and the desk window polls this route; `seq` lets it ignore repeats.
   */
  route('/translate/pending', (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    let payload = {}
    try {
      payload = JSON.parse(readFileSync(join(root, 'pending.json'), 'utf8'))
    } catch {
      // No selection yet (or mid-rename): an empty payload is the honest answer.
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload ?? {}))
  })

  log(`translate desk ready at ${root}`)
  return {
    dir: root,
    historyPath,
    recordCount: () => loadHistory().length,
    /** Exposed for diagnostics: whether the host's llm plumbing is visible to this plugin. */
    probe: () => ({ llm: Boolean(ctx.get('llm')), route: pickRoute() }),
    hashOf: (value) => createHash('sha1').update(String(value)).digest('hex'),
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
