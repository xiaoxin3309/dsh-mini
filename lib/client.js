/**
 * dsh-mini — browser half.
 *
 * Two buttons and one small window mode:
 *
 *  - main window: an "pop out" button in the session header that asks the host to
 *    spawn an Edge/Chrome --app window on the same URL plus `dshHud=1`.
 *  - HUD window: the page carries `dshHud=1`, so it titles itself
 *    "DSH 小窗 · <session>" (the host finds the native window by that prefix),
 *    and grows a screenshot key plus pin/close controls.
 *
 * The screenshot key captures the *screen* with the HUD hidden again, then pastes
 * the result into the composer — so "look at what is on my desktop and explain it"
 * is one click inside the small window.
 */

/**
 * The id this bundle is being loaded under.
 *
 * The host serves an entry's client bundle only under the entry id it composed
 * at scan time. After this plugin was renamed from `dsh-hud-window` to
 * `dsh-mini`, a host that was already running kept its old row, so the boot
 * payload still asked for `dsh-hud-window/client.js` and the loader rejected the
 * file because it registered a different id ("loaded without registering
 * ..."), which fails the whole client boot. Reading the id back from the
 * executing script keeps that stale row harmless: it registers under its own
 * expected id and does nothing (see `apply`), until the next host restart drops
 * the old row for good.
 */
const SCRIPT_ID = (() => {
  try {
    const src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || ''
    const parts = src.split('/client.js')
    // A multi-entry combo names its members after `??`; only a single-member
    // combo unambiguously identifies this bundle.
    const combo = src.match(/\/plugins\/\?\?([^,&]+)\/client\.js/)
    if (combo && src.split('/client.js').length === 2) return decodeURIComponent(combo[1])
    const single = src.match(/\/plugins\/([^/]+)\/client\.js/)
    return single ? decodeURIComponent(single[1]) : ''
  } catch {
    return ''
  }
})()

/** Legacy ids this bundle may still be requested under by an older host row. */
const LEGACY_IDS = ['dsh-hud-window']
const MODULE_ID = SCRIPT_ID === 'dsh-mini' || LEGACY_IDS.includes(SCRIPT_ID) ? SCRIPT_ID : 'dsh-mini'

window.__ModuleLoader__.load({
  id: MODULE_ID,
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')

    /** Must match PREFIX in lib/index.js and the repo route table. */
    const PREFIX = '/dsh-mini'
    const HUD_FLAG = 'dshHud'
    /** Must start with `titlePrefix` in cordis.patch.yml. */
    const TITLE_PREFIX = 'DSH 小窗'
    const STYLE_ID = 'dsh-mini-style'

    /** @param {string} key @returns {string} */
    function queryFlag(key) {
      try { return new URLSearchParams(window.location.search).get(key) ?? '' } catch { return '' }
    }

    /**
     * @param {string} name
     * @returns {string}
     *
     * The GUI logs a fresh profile in by redirecting to a cleaned URL, which drops
     * our query flags; the native shell mirrors them into cookies that survive it.
     */
    function cookieValue(name) {
      try {
        const parts = String(document.cookie ?? '').split(';')
        for (let index = 0; index < parts.length; index += 1) {
          const raw = parts[index].trim()
          const equals = raw.indexOf('=')
          if (equals <= 0) continue
          if (raw.slice(0, equals) === name) {
            const value = raw.slice(equals + 1)
            try { return decodeURIComponent(value) } catch { return value }
          }
        }
      } catch {
        // No cookie access: fall through.
      }
      return ''
    }

    const isHud = queryFlag(HUD_FLAG) === '1' || cookieValue('dsh_hud') === '1'

    /**
     * True inside the native WebView2 shell (app/HudWindow.cs). That shell draws
     * its own title bar with the pin / back / shot / close keys, so the page must
     * not add a second set of buttons there — it only renders the compact layout.
     */
    const inNativeShell = (() => {
      try { return Boolean(window.chrome && window.chrome.webview && window.chrome.webview.postMessage) } catch { return false }
    })()

    // ---------------------------------------------------------------- styles

    const CSS = [
      '.dsh-hud-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'border-radius:8px;border:none;background:transparent;color:inherit;cursor:pointer;padding:0;',
      'opacity:.68;transition:background .15s ease,opacity .15s ease;flex:0 0 auto}',
      '.dsh-hud-btn:hover{background:rgba(127,127,127,.16);opacity:1}',
      '.dsh-hud-btn:active{transform:scale(.94)}',
      '.dsh-hud-btn[disabled]{opacity:.35;cursor:default}',
      '.dsh-hud-btn svg{width:16px;height:16px;display:block}',
      '.dsh-hud-toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:99999;',
      'padding:8px 14px;border-radius:10px;font-size:12.5px;line-height:1.45;color:#fff;',
      'background:rgba(28,28,30,.92);box-shadow:0 10px 28px rgba(0,0,0,.28);max-width:78vw;',
      'pointer-events:none;animation:dsh-hud-in .16s ease-out}',
      '.dsh-hud-toast[data-kind="error"]{background:rgba(190,48,48,.95)}',
      '@keyframes dsh-hud-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}',
    ].join('')

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------- toast

    let toastTimer = null

    /** @param {string} message @param {'info'|'error'} [kind] */
    function toast(message, kind = 'info') {
      const node = document.createElement('div')
      node.className = 'dsh-hud-toast'
      node.dataset.kind = kind
      node.textContent = message
      document.body.appendChild(node)
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { node.remove(); toastTimer = null }, 2600)
    }

    /**
     * Breadcrumb for diagnosing button wiring. The page has no console channel we
     * can read from outside, so a one-pixel image request lands in the host's
     * `trace.log` instead.
     *
     * @param {string} step
     * @param {unknown} [detail]
     */
    function trace(step, detail) {
      try {
        const image = new window.Image()
        image.src = `${PREFIX}/trace?step=${encodeURIComponent(step)}&detail=${encodeURIComponent(String(detail ?? ''))}&t=${String(Date.now())}`
      } catch {
        // Diagnostics must never break the click path.
      }
    }

    /** `location.href` only when the page is really served over http(s). */
    function webHref() {
      try {
        const raw = String(window.location.href ?? '')
        return /^https?:/i.test(raw) ? raw : ''
      } catch {
        return ''
      }
    }

    function safeProtocol() {
      try {
        return String(window.location.protocol ?? '?')
      } catch {
        return '?'
      }
    }

    // ---------------------------------------------------------------- host api

    async function postJson(path, body) {
      const response = await fetch(`${PREFIX}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const text = await response.text()
      let data = {}
      try { data = text === '' ? {} : JSON.parse(text) } catch { data = { error: text } }
      if (!response.ok || (data && data.error)) {
        throw new Error(String(data?.error ?? `HTTP ${String(response.status)}`))
      }
      return data
    }

    // ---------------------------------------------------------------- composer

    /**
     * Paste an image into the conversation composer.
     *
     * The composer is a Lexical editor that accepts image files through its paste
     * command; a synthetic ClipboardEvent with a DataTransfer carrying the File is
     * enough, even though `isTrusted` is false.
     *
     * @param {string} dataUrl a `data:image/png;base64,...` string
     * @returns {boolean} whether a composer was found
     */
    function insertIntoComposer(dataUrl) {
      const editors = Array.from(document.querySelectorAll('[data-lexical-editor="true"]'))
      const editor =
        editors.find((node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }) ?? editors[0]
      if (editor === undefined) return false

      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const file = new window.File([bytes], `screenshot-${String(Date.now())}.png`, { type: 'image/png' })

      const transfer = new window.DataTransfer()
      transfer.items.add(file)

      editor.focus()
      let event
      try {
        event = new window.ClipboardEvent('paste', {
          dataTransfer: transfer,
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      } catch {
        event = new window.ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true })
      }
      if (event.clipboardData === null || event.clipboardData === undefined) {
        Object.defineProperty(event, 'clipboardData', { value: transfer })
      }
      editor.dispatchEvent(event)
      return true
    }

    // ---------------------------------------------------------------- icons

    function icon(children) {
      return react.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        children,
      )
    }

    const POPOUT_ICON = icon([
      react.createElement('path', { key: 'a', d: 'M6.6 3.6H4.9c-.7 0-1.3.6-1.3 1.3v6.2c0 .7.6 1.3 1.3 1.3h6.2c.7 0 1.3-.6 1.3-1.3V9.4' }),
      react.createElement('path', { key: 'b', d: 'M9.4 2.6h4v4' }),
      react.createElement('path', { key: 'c', d: 'M13.1 2.9 7.7 8.3' }),
    ])

    const CAMERA_ICON = icon([
      react.createElement('path', { key: 'a', d: 'M2.7 5.9h1.9l1-1.7h2.8l1 1.7h1.9c.5 0 .9.4.9.9v4.4c0 .5-.4.9-.9.9H2.7a.9.9 0 0 1-.9-.9V6.8c0-.5.4-.9.9-.9Z' }),
      react.createElement('circle', { key: 'b', cx: 8, cy: 9.3, r: 1.9 }),
    ])

    const PIN_ICON = icon([
      react.createElement('path', { key: 'a', d: 'M6.1 2.6h3.8l-.6 3.1 2 2H4.7l2-2-.6-3.1Z' }),
      react.createElement('path', { key: 'b', d: 'M8 7.9v5.5' }),
    ])

    const CLOSE_ICON = icon([
      react.createElement('path', { key: 'a', d: 'M4.2 4.2 11.8 11.8' }),
      react.createElement('path', { key: 'b', d: 'M11.8 4.2 4.2 11.8' }),
    ])

    // Drawn in its own 24-unit box: the classic paperclip needs the extra room, and
    // squeezing it into the 16-unit grid clipped its lower hook.
    const FILES_ICON = react.createElement(
      'svg',
      {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      react.createElement('path', {
        key: 'a',
        d: 'M20.6 11.2 11.9 19.9a5.7 5.7 0 0 1-8.1-8.1l8.2-8.2a3.8 3.8 0 1 1 5.4 5.4l-8.2 8.2a1.9 1.9 0 0 1-2.7-2.7l7.9-7.9',
      }),
    )

    // ---------------------------------------------------------------- buttons

    /**
     * Header button in the main window: pop the current conversation out.
     *
     * The slot is session scoped, so `props.sessionId` names the conversation the
     * header belongs to; the HUD window is a fresh document and can only learn it
     * from this hand-off.
     */
    function PopoutButton(props) {
      const [busy, setBusy] = react.useState(false)

      async function onClick() {
        trace('click', webHref() === '' ? `no-http:${safeProtocol()}` : 'http')
        if (busy) return
        setBusy(true)
        try {
          const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
          // The desktop renderer runs on a custom scheme, so `location.href` is not
          // something the host can open. Send it only when it really is http(s);
          // otherwise the host supplies the advertised address itself.
          const data = await postJson('/open', { href: webHref(), sessionId })
          trace('opened', `${String(data && data.pid)}|${sessionId}`)
          toast(data.reused === true ? '小窗已在运行，已切到这个会话' : '已弹出小窗（置顶）')
        } catch (error) {
          trace('open-failed', String(error?.message ?? error))
          toast(`弹出失败：${String(error?.message ?? error)}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      if (isHud) return null
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-hud-btn',
          title: '弹出此窗口',
          'aria-label': '弹出此窗口',
          disabled: busy,
          onClick,
        },
        POPOUT_ICON,
      )
    }

    /** HUD header button: keep the popout on top / close it. */
    function PinButton() {
      const [busy, setBusy] = react.useState(false)

      async function onClick() {
        if (busy) return
        setBusy(true)
        try {
          await postJson('/focus', {})
          toast('已重新置顶')
        } catch (error) {
          toast(`置顶失败：${String(error?.message ?? error)}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      if (!isHud) return null
      return react.createElement(
        'button',
        { type: 'button', className: 'dsh-hud-btn', title: '重新置顶', 'aria-label': '重新置顶', disabled: busy, onClick },
        PIN_ICON,
      )
    }

    function CloseButton() {
      const [busy, setBusy] = react.useState(false)

      async function onClick() {
        if (busy) return
        setBusy(true)
        try {
          await postJson('/close', {})
        } catch {
          // The window may already be gone; closing locally is still correct.
        }
        window.close()
      }

      if (!isHud) return null
      return react.createElement(
        'button',
        { type: 'button', className: 'dsh-hud-btn', title: '关闭小窗', 'aria-label': '关闭小窗', disabled: busy, onClick },
        CLOSE_ICON,
      )
    }

    /** HUD composer key: screenshot the desktop (HUD excluded) and paste it in. */
    function ShotButton() {
      const [busy, setBusy] = react.useState(false)

      async function onClick() {
        if (busy) return
        setBusy(true)
        try {
          const data = await postJson('/shot', {})
          if (typeof data.png !== 'string' || data.png === '') throw new Error('没有拿到图片')
          if (!insertIntoComposer(data.png)) throw new Error('没找到输入框')
          toast('截图已插入输入框')
        } catch (error) {
          toast(`截图失败：${String(error?.message ?? error)}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      if (!isHud) return null
      return react.createElement(
        'button',
        { type: 'button', className: 'dsh-hud-btn', title: '截图（不含本窗口）', 'aria-label': '截图', disabled: busy, onClick },
        CAMERA_ICON,
      )
    }

    // ---------------------------------------------------------------- import files

    /**
     * The composer already owns a hidden `<input type="file">` — it is what the
     * plus menu's 文件 entry drives. Reusing it means our button opens the very
     * same OS picker and the app's own attach/upload path takes the result, so
     * nothing about files has to be re-implemented here.
     */
    function fileInputOfComposer() {
      const editor =
        document.querySelector('[data-lexical-editor="true"]') ??
        document.querySelector('[contenteditable="true"]')
      let node = editor
      for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
        if (typeof node.querySelector === 'function') {
          const found = node.querySelector('input[type="file"]')
          if (found !== null) return found
        }
        node = node.parentElement
      }
      // Fallback: any composer file input that is not another plugin's.
      const any = Array.from(document.querySelectorAll('input[type="file"]')).find(
        (el) => el.closest('.dsh-sel-panel') === null,
      )
      return any ?? null
    }

    function openFilePicker() {
      try {
        const input = fileInputOfComposer()
        if (input === null) {
          trace('files:missing')
          toast('没找到文件导入入口', 'error')
          return
        }
        trace('files:open')
        // Clear first so picking the same file twice still fires `change`.
        input.value = ''
        input.click()
      } catch (error) {
        trace('files:failed', error && error.message)
        toast(`打开资源管理器失败：${String(error?.message ?? error)}`, 'error')
      }
    }

    function FilesButton() {
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-hud-btn',
          title: '导入文件（打开资源管理器）',
          'aria-label': '导入文件',
          onClick: openFilePicker,
        },
        FILES_ICON,
      )
    }

    // ---------------------------------------------------------------- hud title

    /**
     * Keep the window title starting with TITLE_PREFIX while still showing the
     * session name, which is what the host's window lookup keys on.
     */
    function startTitleKeeper() {
      if (!isHud) return
      let sessionTitle = ''
      const compose = () => (sessionTitle === '' ? TITLE_PREFIX : `${TITLE_PREFIX} · ${sessionTitle}`)
      const apply = () => {
        const current = document.title ?? ''
        if (current.startsWith(TITLE_PREFIX)) {
          // Already ours: harvest the session part if it was updated.
          const tail = current.slice(TITLE_PREFIX.length).replace(/^\s*·\s*/, '')
          if (tail !== '' && tail !== sessionTitle) sessionTitle = tail
          return
        }
        if (current !== '') sessionTitle = current
        document.title = compose()
      }
      apply()
      const timer = setInterval(apply, 900)
      window.addEventListener('pagehide', () => { clearInterval(timer) }, { once: true })
    }

    // ---------------------------------------------------------------- hand-off

    /**
     * In the small window, open the conversation the main window handed over.
     *
     * The HUD is a separate document with no shared client state, so the popout
     * URL carries `session=<id>` and this selects that conversation as soon as the
     * workspace service is reachable.
     */
    function followHandedSession(ctx) {
      if (!isHud) return
      const sessionId = queryFlag('session') || cookieValue('dsh_hud_session')
      if (sessionId === '') return
      let tries = 0
      const step = () => {
        tries += 1
        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
            return
          }
        } catch {
          // Service not created yet: keep waiting.
        }
        if (tries < 40) setTimeout(step, 250)
      }
      setTimeout(step, 60)
    }

    /**
     * Main window: follow the small window's "back to main" arrow.
     *
     * The arrow is drawn by the native shell, which cannot reach into this window.
     * It writes the conversation id to the host, the host bumps a sequence number,
     * and this poll opens the conversation once per request — so pressing the arrow
     * lands the reader on the same conversation they were looking at.
     */
    function watchFocusRequests(ctx) {
      if (isHud) return
      let seen = 0
      const timer = setInterval(async () => {
        try {
          const response = await fetch(`${PREFIX}/focus-poll`, { headers: { accept: 'application/json' } })
          if (!response.ok) return
          const data = await response.json()
          if (typeof data.seq !== 'number' || data.seq <= seen) return
          seen = data.seq
          const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
          if (sessionId === '') return
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
            trace('focus-follow', sessionId)
          }
        } catch {
          // Host not up yet, or shutting down: the next tick retries.
        }
      }, 2000)
      window.addEventListener('pagehide', () => { clearInterval(timer) }, { once: true })
    }

    // ---------------------------------------------------------------- settings page

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }
    const labelStyle = { minWidth: '132px', fontSize: '13px', opacity: 0.9 }
    const inputStyle = {
      width: '132px',
      padding: '5px 8px',
      fontSize: '13px',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid currentColor',
      borderRadius: '6px',
      opacity: 0.9,
    }
    const hintStyle = { fontSize: '12px', opacity: 0.6, margin: '4px 0 0' }

    /** Settings page: screenshot behaviour + the two global hotkeys. */
    function SettingsSection() {
      const [config, setConfig] = react.useState(null)
      const [status, setStatus] = react.useState('')
      const [updateInfo, setUpdateInfo] = react.useState(null)
      const [updateBusy, setUpdateBusy] = react.useState('')
      const [updateMsg, setUpdateMsg] = react.useState('')
      const [updateLog, setUpdateLog] = react.useState([])

      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const response = await fetch(`${PREFIX}/config`, { headers: { accept: 'application/json' } })
            const data = await response.json()
            if (!cancelled) setConfig(data.config ?? {})
          } catch (error) {
            if (!cancelled) setStatus(`读取失败：${String(error?.message ?? error)}`)
          }
        }
        load()
        void checkUpdate()
        return () => { cancelled = true }
      }, [])

      const save = async (patch) => {
        setConfig({ ...(config ?? {}), ...patch })
        try {
          const response = await fetch(`${PREFIX}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const data = await response.json()
          if (data.error) throw new Error(String(data.error))
          setStatus('已保存')
          setTimeout(() => setStatus(''), 1600)
        } catch (error) {
          setStatus(`保存失败：${String(error?.message ?? error)}`)
        }
      }

      if (config === null) {
        return react.createElement('div', { style: { padding: '8px 0', fontSize: '13px', opacity: 0.7 } },
          status === '' ? '读取设置…' : status)
      }

      async function checkUpdate() {
        setUpdateBusy('check')
        setUpdateMsg('')
        try {
          const response = await fetch(`${PREFIX}/update-check`, { headers: { accept: 'application/json' } })
          const data = await response.json()
          setUpdateInfo(data)
          if (data.ok === false) setUpdateMsg(`检查失败：${String(data.error ?? '未知错误')}`)
          else if (data.isUpToDate === true) setUpdateMsg(`已是最新版本 ${String(data.currentVersion)}`)
          else setUpdateMsg(`发现新版本 ${String(data.latestVersion)}，可一键更新`)
        } catch (error) {
          setUpdateMsg(`检查失败：${String(error?.message ?? error)}`)
        } finally {
          setUpdateBusy('')
        }
      }

      const postUpdate = async (force) => {
        const response = await fetch(`${PREFIX}/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: force === true }),
        })
        return response.json()
      }

      /**
       * Check + install in one place. A development copy (`link:` into a profile) is
       * never replaced behind the user's back: the host answers needsConfirm and the
       * second call carries force.
       */
      const runUpdate = async (force) => {
        if (updateBusy !== '') return
        setUpdateBusy('update')
        setUpdateLog([])
        setUpdateMsg('正在更新…')
        try {
          let data = await postUpdate(force)
          let confirmed = force === true
          while (data && data.needsConfirm === true && !confirmed) {
            const proceed = window.confirm(`${String(data.message)}\n\n继续吗？`)
            if (!proceed) {
              setUpdateMsg('已取消，没有改动插件。')
              return
            }
            confirmed = true
            data = await postUpdate(true)
          }
          setUpdateLog(Array.isArray(data.log) ? data.log : [])
          setUpdateMsg(String(data.message ?? (data.ok === true ? '完成' : '更新失败')))
          if (data.updated === true) void checkUpdate()
        } catch (error) {
          setUpdateMsg(`更新失败：${String(error?.message ?? error)}`)
        } finally {
          setUpdateBusy('')
        }
      }

      const checkbox = (key, text, hint) =>
        react.createElement('div', { key, style: rowStyle },
          react.createElement('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
            react.createElement('input', {
              type: 'checkbox',
              checked: Boolean(config[key]),
              onChange: (event) => { save({ [key]: event.target.checked }) },
            }),
            text,
          ),
          hint === undefined
            ? null
            : react.createElement('span', { style: { fontSize: '12px', opacity: 0.6 } }, hint),
        )

      const hotkey = (key, text) =>
        react.createElement('div', { key, style: rowStyle },
          react.createElement('span', { style: labelStyle }, text),
          react.createElement('input', {
            style: inputStyle,
            value: String(config[key] ?? ''),
            onChange: (event) => setConfig({ ...config, [key]: event.target.value }),
            onBlur: (event) => { save({ [key]: event.target.value }) },
            onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
          }),
        )

      return react.createElement('div', null,
        react.createElement('h3', { style: { fontSize: '14px', margin: '0 0 4px' } }, '小窗与截图'),
        react.createElement('p', { style: hintStyle }, '设置对原生小窗和后台划词服务同时生效，保存后约 3 秒内应用。'),
        checkbox('copyShot', '截图自动复制到剪贴板', '全屏、框选两种截图都会复制'),
        checkbox('textFallback', '选区读取：辅助功能读不到时改用复制',
          '默认打开。先走系统辅助功能（不发按键、不碰剪贴板）；浏览器正文、老控件没有这个接口，只能复制一次来读选区 —— 会占用剪贴板，但不会再还原，所以不会覆盖你刚按的 Ctrl+C。关掉后这些地方就不出按钮。'),
        hotkey('hotkeyFull', '全屏截图快捷键'),
        hotkey('hotkeyRegion', '框选截图快捷键'),
        react.createElement('p', { style: hintStyle }, '写法：Ctrl+Shift+1、Ctrl+Shift+S、Alt+PrintScreen、F8 等。组合里必须带 Ctrl/Alt/Shift/Win 之一。'),

        react.createElement('h3', { style: { fontSize: '14px', margin: '20px 0 4px' } }, '版本与更新'),
        react.createElement('div', { style: rowStyle },
          react.createElement('span', { style: labelStyle }, '当前版本'),
          react.createElement('span', { style: { fontSize: '13px', fontFamily: 'monospace' } },
            updateInfo === null ? '查询中…' : String(updateInfo.currentVersion ?? '—')),
          react.createElement('span', { style: { fontSize: '12px', opacity: 0.6 } },
            updateInfo !== null && updateInfo.linked === true ? '（本地 link 安装）' : ''),
        ),
        react.createElement('div', { style: rowStyle },
          react.createElement('span', { style: labelStyle }, 'npm 最新版本'),
          react.createElement('span', { style: { fontSize: '13px', fontFamily: 'monospace' } },
            updateInfo === null ? '—' : String(updateInfo.latestVersion ?? '—')),
          updateInfo !== null && updateInfo.isUpToDate === false && updateInfo.latestVersion
            ? react.createElement('span', { style: { fontSize: '12px', color: '#1a7f37' } }, '有新版本')
            : null,
        ),
        react.createElement('div', { style: { display: 'flex', gap: '8px', padding: '4px 0 8px' } },
          react.createElement('button', {
            type: 'button',
            disabled: updateBusy !== '',
            onClick: () => { void checkUpdate() },
            style: {
              padding: '6px 14px', fontSize: '13px', borderRadius: '8px', cursor: updateBusy !== '' ? 'default' : 'pointer',
              border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.9,
            },
          }, updateBusy === 'check' ? '检查中…' : '检查更新'),
          react.createElement('button', {
            type: 'button',
            disabled: updateBusy !== '',
            onClick: () => { void runUpdate(false) },
            style: {
              padding: '6px 14px', fontSize: '13px', borderRadius: '8px', fontWeight: 600,
              border: 'none', background: '#2f6feb', color: '#fff', cursor: updateBusy !== '' ? 'default' : 'pointer',
            },
          }, updateBusy === 'update' ? '更新中…' : '一键更新'),
        ),
        updateMsg === ''
          ? null
          : react.createElement('p', { style: { fontSize: '12px', margin: '0 0 6px', opacity: 0.85 } }, updateMsg),
        updateLog.length === 0
          ? null
          : react.createElement('pre', {
            style: {
              fontSize: '11px', lineHeight: 1.5, maxHeight: '180px', overflow: 'auto', margin: 0,
              padding: '8px 10px', borderRadius: '8px', background: 'rgba(127,127,127,0.12)', whiteSpace: 'pre-wrap',
            },
          }, updateLog.join('\n')),
        react.createElement('p', { style: hintStyle },
          '一键更新从 npm 安装最新版；小窗外壳会随即换成新版本，主程序的插件代码要重启 DSH 才生效。本地 link 安装（开发模式）会先弹确认，不会偷偷替换你的工作目录。'),
        status === ''
          ? null
          : react.createElement('p', { style: { fontSize: '12px', margin: '6px 0 0', opacity: 0.8 } }, status),
      )
    }

    // ---------------------------------------------------------------- apply

    exports.name = MODULE_ID
    exports.inject = ['slots']

    exports.apply = (ctx) => {
      trace('apply', `${MODULE_ID}|${isHud ? 'hud' : 'main'}|${inNativeShell ? 'native' : 'web'}`)
      // A stale pre-rename row: register (so the loader accepts the bundle) but
      // claim no UI — the current `dsh-mini` entry renders it.
      if (MODULE_ID !== 'dsh-mini') {
        trace('apply:legacy-skip', MODULE_ID)
        return
      }
      ensureStyles()
      startTitleKeeper()
      followHandedSession(ctx)
      watchFocusRequests(ctx)

      // The composer tool row is shared chrome: the import button belongs to every
      // shell (main window, HUD, plain browser), so it is injected before the
      // HUD-only branch below returns.
      try {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'hud-files',
              order: 10,
              label: () => '导入文件',
            },
            FilesButton,
          ),
        )
      } catch (error) {
        trace('files:inject-failed', error && error.message)
      }

      // The settings page is global chrome, so it belongs to the main window.
      if (!isHud) {
        try {
          trace('settings:start')
          ctx.slots.inject('settings.section', () => {
            trace('settings:inject-fired')
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: 'hud-window',
                order: 30,
                label: () => 'DSH 小窗',
              },
              SettingsSection,
            )
          })
          trace('settings:injected')
        } catch (error) {
          trace('settings:failed', error && error.message)
        }
      }

      // The pop-out key lives in the *main* window only: the HUD is already popped out.
      if (!isHud) {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'hud-popout',
              order: 60,
              label: () => '弹出此窗口',
            },
            PopoutButton,
          ),
        )
        return
      }

      // Browser fallback HUD (no native title bar) still needs its own keys.
      if (inNativeShell) return

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'hud-pin',
            order: 61,
            label: () => '重新置顶',
          },
          PinButton,
        ),
      )

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'hud-close',
            order: 62,
            label: () => '关闭小窗',
          },
          CloseButton,
        ),
      )

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'hud-shot',
            order: 20,
            label: () => '截图',
          },
          ShotButton,
        ),
      )
    }

    return exports
  },
})
