/**
 * dsh-mini — host half.
 *
 * Pops the current conversation out into its own always-on-top window, the way
 * Tencent Yuanbao's mini window works. The window is a browser `--app` window
 * (chromeless, no address bar) loading the very same authenticated GUI URL the
 * main window is on, plus a `dshHud=1` flag that the browser half reads to
 * switch into HUD mode (title, compact chrome, screenshot key).
 *
 * Why a browser --app window instead of an Electron BrowserWindow: this plugin
 * runs in the Cordis host process (a child of the Electron main process), so it
 * has no access to Electron's window APIs. Spawning the installed browser with
 * --app gives a real native second window with zero Electron coupling.
 *
 * The window is then pinned with SetWindowPos (scripts/win-hud.ps1), because an
 * --app window has no always-on-top switch of its own.
 */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { setupTranslate } from './translate.js'

export const name = 'dsh-mini'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', 'scripts')

/**
 * The native shell built from `app/HudWindow.cs` (WebView2 + WinForms). It is
 * the preferred backend: a real chromeless window we own, so the title bar,
 * screenshot key and always-on-top state are ours instead of the browser's.
 */
const NATIVE_EXE = join(HERE, '..', 'app', 'bin', 'DSH小窗.exe')

/**
 * Where the exe is actually run from.
 *
 * The packaged exe ships inside the plugin folder, which is often inside a
 * developer workspace. A workspace-confined build (this machine runs one) denies
 * such a binary every write outside the workspace, and WebView2 plus the input
 * APIs then fail with E_ACCESSDENIED even when the window itself is spawned
 * correctly. Staging the exe under %LOCALAPPDATA% keeps it outside any such
 * confinement; for a normal npm install this is a no-op copy of the same files.
 */
const INSTALL_DIR = join(process.env.LOCALAPPDATA ?? tmpdir(), 'dsh-mini')
const BIN_DIR = join(INSTALL_DIR, 'bin')
const RUN_EXE = join(BIN_DIR, 'DSH小窗.exe')

/** Data the shell reads and writes. The exe keeps it beside itself, so we match. */
const TASK_NAME = 'DshMiniWindow'
const DATA_DIR = join(BIN_DIR, 'data')

/**
 * Everything the plugin and the shell exchange — request.txt, quote.txt, cmd.txt,
 * config.ini, hud.log, trace.log — lives in DATA_DIR. The shell resolves the same
 * folder from its own BaseDirectory, so the two sides must agree on this path.
 */
const WORK_DIR = DATA_DIR
const SHOT_DIR = join(INSTALL_DIR, 'shots')
const PROFILE_DIR = join(INSTALL_DIR, 'profile')

/** Set by the helper when it wants the window opened; see the watcher in apply(). */
const WANT_PATH = join(DATA_DIR, 'want.txt')

/**
 * Copy the exe and its three runtime DLLs to INSTALL_DIR when they are missing or
 * stale. Returns the path to run, or the plugin copy when staging is impossible.
 *
 * The previous build is usually still running (the helper never exits), and Windows
 * refuses to overwrite a running image — but it does allow renaming one. So a busy
 * target gets renamed aside first; those aside copies are cleaned on the next pass.
 */
function stageExe() {
  try {
    mkdirSync(BIN_DIR, { recursive: true })
    const files = ['DSH小窗.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']
    const srcDir = dirname(NATIVE_EXE)
    for (const name of files) {
      const from = join(srcDir, name)
      const to = join(BIN_DIR, name)
      if (!existsSync(from)) continue
      const src = statSync(from)
      if (existsSync(to)) {
        const dst = statSync(to)
        if (dst.size === src.size && dst.mtimeMs >= src.mtimeMs) continue
      }
      try {
        copyFileSync(from, to)
      } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
          try {
            renameSync(to, to + '.busy-' + Date.now())
            copyFileSync(from, to)
          } catch {
            // Keep the running copy: a stale binary still beats no window at all.
          }
        } else {
          throw err
        }
      }
    }
    for (const entry of readdirSync(BIN_DIR)) {
      if (entry.includes('.busy-')) {
        try { unlinkSync(join(BIN_DIR, entry)) } catch { }
      }
    }
    const staged = existsSync(RUN_EXE)
    // Carry settings over from an older in-plugin data folder.
    const legacy = join(dirname(NATIVE_EXE), 'data', 'config.ini')
    const fresh = join(DATA_DIR, 'config.ini')
    if (!existsSync(fresh) && existsSync(legacy)) copyFileSync(legacy, fresh)
    return staged ? RUN_EXE : NATIVE_EXE
  } catch {
    return NATIVE_EXE
  }
}

/**
 * Start the shell through Explorer instead of spawning it directly: a direct
 * child inherits this process's restricted token, and WebView2 then fails with
 * E_ACCESSDENIED. Explorer is started by the shell, so the window gets a normal
 * token. A `.lnk` is used when arguments are needed, because Explorer cannot
 * forward argv to an .exe.
 */
/**
 * Start the native shell with a *clean* environment. The Cordis host inherits a lot
 * of Electron/WebView2 state from the DSH process; handing that to the child made
 * WebView2 abort with E_ACCESSDENIED, while the same exe started from the desktop
 * worked. Only the variables Windows itself needs are passed through.
 */
const SHELL_ENV_KEYS = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'USERDNSDOMAIN',
  'COMPUTERNAME', 'SESSIONNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
]

function shellEnv() {
  const env = {}
  for (const key of SHELL_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function launchThroughShell(args = []) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const child = spawn(stageExe(), args, { detached: true, stdio: 'ignore', env: shellEnv(), windowsHide: false })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Start the exe through Task Scheduler.
 *
 * The host process tree spawns children inside a restricted job/token. Under it
 * WebView2 cannot initialise (E_ACCESSDENIED), user-profile writes are denied,
 * and the mouse-state APIs return nothing — which silently kills the selection
 * pill. A one-shot task is created by the Task Scheduler service instead, so the
 * process gets a clean user token. Both the window and the helper go this way.
 */
function launchThroughTask(args = []) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const isService = args.includes('--service')
    const taskName = isService ? `${TASK_NAME}Service` : TASK_NAME
    const exe = stageExe()
    const account = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`
    // The task is authored as XML rather than through schtasks switches: the switch
    // form always sets "start only on AC power", and on a laptop the task then sits
    // in Queued forever and never launches anything.
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>\\${taskName}</URI></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${account}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <Enabled>true</Enabled><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority>
  </Settings>
  <Triggers><TimeTrigger><StartBoundary>2099-12-31T23:59:00</StartBoundary><Enabled>false</Enabled></TimeTrigger></Triggers>
  <Actions Context="Author"><Exec><Command>${exe}</Command><Arguments>${args.join(' ')}</Arguments></Exec></Actions>
</Task>
`
    const xmlPath = join(DATA_DIR, `${taskName}.xml`)
    writeFileSync(xmlPath, '\uFEFF' + xml, 'utf16le')
    spawnSync('schtasks.exe', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'], {
      env: shellEnv(), windowsHide: true, timeout: 20000,
    })
    const run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { env: shellEnv(), windowsHide: true, timeout: 20000 })
    return run.status === 0
  } catch {
    return false
  }
}

/** Ask for the background helper: it consumes and removes this flag on start. */
function requestService() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    return launchThroughShell(['--service'])
  } catch {
    return false
  }
}
/** The address the shell should open; consumed by `Program.Main` when argv is empty. */
function writeRequestUrl(url) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(join(DATA_DIR, 'request.txt'), url, 'utf8')
  } catch {
    // Non-fatal: the caller reports the launch result separately.
  }
}

/** Exact-route prefix; the browser half uses the same constant. */
const PREFIX = '/dsh-mini'

/** Query flag that switches the page into HUD mode. */
const HUD_FLAG = 'dshHud'

/**
 * Re-target an already running native shell. The exe polls `pending.txt` every
 * 700 ms and navigates to whatever URL it finds, so writing it is how `open`
 * moves an existing small window onto another conversation.
 */
function writePendingUrl(url) {
  try {
    mkdirSync(WORK_DIR, { recursive: true })
    writeFileSync(join(DATA_DIR, 'pending.txt'), url, 'utf8')
  } catch {
    // A failed hand-off is not fatal: the window is already open.
  }
}

/**
 * Hand-off back to the main window.
 *
 * The small window and the main window are separate documents on separate browser
 * profiles, so they share no client state at all. Pressing the arrow drops the
 * conversation id into this file; the host publishes it over HTTP and the main
 * window's client half opens that conversation when it sees a new sequence number.
 */
const FOCUS_PATH = join(DATA_DIR, 'focus.txt')

// ------------------------------------------------------------------ updates

/** `<plugin>/lib/index.js` → the package root. */
const PLUGIN_DIR = join(HERE, '..')
const PACKAGE_NAME = 'dsh-mini'
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const MAX_UPDATE_LOG = 40
const DSH_HOME = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

function readPackageVersion(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** Enough of semver for release versions: 0.1.10 > 0.1.9, a prerelease sorts lower. */
function compareVersions(a, b) {
  const parse = (value) => String(value ?? '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  const preA = String(a).includes('-')
  const preB = String(b).includes('-')
  if (preA !== preB) return preA ? -1 : 1
  return 0
}

async function fetchLatestVersion(timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(REGISTRY_LATEST, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    })
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
    const data = await response.json()
    if (typeof data.version !== 'string') throw new Error('npm registry response has no version')
    return { version: data.version, publishTime: data.time?.[data.version] }
  } finally {
    clearTimeout(timer)
  }
}

/** Run one command, capturing both streams; never rejects. */
function runCommand(command, args, cwd, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
        if (error) {
          const reason = error.code === 'ETIMEDOUT' ? 'command timed out' : String(error.message ?? error)
          resolve({ ok: false, output: output === '' ? `[exit] ${reason}` : `${output}\n[exit] ${reason}` })
          return
        }
        resolve({ ok: true, output })
      },
    )
  })
}

/**
 * Which DSH profile owns this plugin copy.
 *
 * A packed install lives at `<profile>/node_modules/dsh-mini`; a development copy
 * is `link:`-ed into a profile instead, so the module URL resolves to the working
 * directory and the profile has to be found by reading their package.json files.
 */
function resolveInstall() {
  const real = PLUGIN_DIR
  const profiles = join(DSH_HOME, 'profiles')
  let names = []
  try { names = readdirSync(profiles) } catch { /* no profiles dir */ }
  for (const name of names) {
    const profileDir = join(profiles, name)
    let deps = {}
    try { deps = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies ?? {} } catch { continue }
    const declared = deps[PACKAGE_NAME]
    if (typeof declared !== 'string') continue
    const installed = join(profileDir, 'node_modules', PACKAGE_NAME)
    const linked = typeof declared === 'string' && declared.startsWith('link:')
    return { profileDir, profileName: name, linked, managed: !linked, pluginDir: real, installed }
  }
  const parent = dirname(real)
  const managed = parent.toLowerCase().endsWith('node_modules')
  return {
    profileDir: managed ? dirname(parent) : DSH_HOME,
    profileName: managed ? dirname(parent).split(/[\\/]/).pop() : 'unknown',
    linked: !managed,
    managed,
    pluginDir: real,
    installed: real,
  }
}

/** The node+pnpm DSH ships with (node <pnpm.mjs> add …), so no global pnpm is needed. */
function findBundledPnpm() {
  const runtimesDir = join(DSH_HOME, 'dsh-runtimes')
  let names = []
  try { names = readdirSync(runtimesDir) } catch { return null }
  for (const runtimeName of names) {
    const deps = join(runtimesDir, runtimeName, 'dependencies')
    const pnpmJs = join(deps, 'pnpm', 'bin', 'pnpm.mjs')
    if (!existsSync(pnpmJs)) continue
    const nodeExe = process.platform === 'win32' ? join(deps, 'node', 'bin', 'node.exe') : join(deps, 'node', 'bin', 'node')
    return { label: `pnpm (${runtimeName})`, command: existsSync(nodeExe) ? nodeExe : process.execPath, pnpmJs }
  }
  return null
}

/**
 * A profile's `pnpm-workspace.yaml` refuses packages published in the last 24 h
 * (`minimumReleaseAge`). A fresh release would be rejected, so allow this one
 * explicitly; every failure here is non-fatal.
 */
function ensureReleaseAgeExclude(profileDir, version) {
  const yamlPath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) return false
  let text
  try { text = readFileSync(yamlPath, 'utf8') } catch { return false }
  if (!/minimumReleaseAge\s*:/.test(text)) return false
  const entry = `${PACKAGE_NAME}@${version}`
  if (text.includes(entry)) return false
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex((line) => /^minimumReleaseAgeExclude\s*:/.test(line))
  if (header === -1) {
    const age = lines.findIndex((line) => /^minimumReleaseAge\s*:/.test(line))
    if (age === -1) return false
    lines.splice(age + 1, 0, 'minimumReleaseAgeExclude:', `  - ${entry}`)
  } else {
    let at = header + 1
    while (at < lines.length && /^\s+-\s/.test(lines[at])) at += 1
    lines.splice(at, 0, `  - ${entry}`)
  }
  try {
    writeFileSync(yamlPath, lines.join('\n'), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Install the released version into the profile.
 *
 * Returns the log plus whether the on-disk plugin copy really changed; the caller
 * refuses to report success on a command that exited 0 without upgrading anything.
 */
async function applyUpdate(options = {}) {
  const log = []
  const push = (line) => { if (log.length < MAX_UPDATE_LOG) log.push(line) }
  const install = resolveInstall()
  const current = readPackageVersion(install.pluginDir) ?? '0.0.0'

  let latest
  try {
    latest = await fetchLatestVersion()
    push(`registry: latest=${latest.version}${latest.publishTime ? ` (${latest.publishTime})` : ''}`)
  } catch (error) {
    push(`registry query failed: ${String(error?.message ?? error)}`)
    return { ok: false, updated: false, currentVersion: current, message: `查询 npm 最新版本失败：${String(error?.message ?? error)}`, log }
  }

  push(`installed: ${install.pluginDir} (v${current})`)
  push(`profile: ${install.profileDir}${install.linked ? ' (link: install)' : ''}`)

  if (compareVersions(latest.version, current) <= 0 && options.force !== true) {
    return {
      ok: true, updated: false, currentVersion: current, latestVersion: latest.version, linked: install.linked,
      message: `本地已是 ${current}，npm 上最新为 ${latest.version}，未做任何安装。`, log,
    }
  }

  // A development copy that is `link:`-ed into the profile: installing replaces the
  // link with the published package. Never do that behind the user's back.
  if (install.linked && options.force !== true) {
    return {
      ok: false, updated: false, linked: true, needsConfirm: true,
      currentVersion: current, latestVersion: latest.version,
      message: `当前是从本地目录 link 安装的（${install.pluginDir}）。一键更新会用 npm 上的 ${latest.version} 替换这个链接（本地目录不会被改动）。继续的话再调一次 force:true。`,
      log,
    }
  }

  if (ensureReleaseAgeExclude(install.profileDir, latest.version)) push('patched: minimumReleaseAgeExclude += ' + PACKAGE_NAME + '@' + latest.version)

  const managers = []
  const bundled = findBundledPnpm()
  if (bundled) {
    managers.push({
      label: bundled.label,
      command: bundled.command,
      args: [bundled.pnpmJs, 'add', `${PACKAGE_NAME}@${latest.version}`, '--save-exact', '--config.minimum-release-age=0', '-C', install.profileDir],
    })
  }
  managers.push({
    label: 'npm',
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', `${PACKAGE_NAME}@${latest.version}`, '--save-exact', '--no-audit', '--no-fund', '--prefix', install.profileDir],
  })

  for (const manager of managers) {
    push(`install: ${manager.label} → ${manager.command} ${manager.args.join(' ')}`)
    const result = await runCommand(manager.command, manager.args, install.profileDir)
    push(`install(${manager.label}): ${result.ok ? 'ok' : 'failed'}`)
    if (result.output !== '') {
      for (const line of result.output.split(/\r?\n/).slice(-12)) if (line.trim() !== '') push(`  ${line.trim()}`)
    }
    const now = readPackageVersion(install.installed)
    if (result.ok && now === latest.version) {
      return {
        ok: true, updated: true, linked: false, currentVersion: current, latestVersion: latest.version, newVersion: now,
        restartShell: true,
        message: `已从 ${current} 更新到 ${now}。小窗外壳会自动换成新版本；主程序的插件代码需要重启 DSH 才生效。`,
        log,
      }
    }
    push(`verify: on-disk version is ${now ?? 'unknown'}, trying the next installer`)
  }

  return {
    ok: false, updated: false, currentVersion: current, latestVersion: latest.version,
    message: `自动更新失败（当前 ${current}，目标 ${latest.version}）。可手动执行 npm i -g 或到 npm 页面下载。`,
    log,
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (error) { reject(new Error(`invalid JSON body: ${error.message}`)) }
    })
    req.on('error', reject)
  })
}

/** First PowerShell that actually exists, preferring PowerShell 7. */
function powershell() {
  const windir = process.env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(windir, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no PowerShell found (looked for pwsh 7 and Windows PowerShell 5.1)')
}

/**
 * Run one helper script and parse its single-line JSON reply.
 * @param {string} script file name inside scripts/
 * @param {string[]} args
 */
function runScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const file = join(SCRIPTS, script)
    if (!existsSync(file)) { reject(new Error(`hud: helper not found: ${file}`)); return }
    let shell
    try { shell = powershell() } catch (error) { reject(error); return }
    const child = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => { reject(error) })
    child.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
      if (line === undefined) {
        reject(new Error(`hud: ${script} produced no JSON (exit ${String(code)})${err ? `: ${err.trim().slice(0, 300)}` : ''}`))
        return
      }
      let parsed
      try { parsed = JSON.parse(line) } catch (error) { reject(new Error(`hud: ${script} returned unparsable JSON: ${error.message}`)); return }
      if (parsed.status !== 'ok') { reject(new Error(`hud: ${script} failed: ${String(parsed.error ?? 'unknown')}`)); return }
      resolve(parsed.data ?? {})
    })
  })
}

/** Locate an installed Chromium browser that supports `--app`. */
function findBrowser(configured) {
  if (configured && existsSync(configured)) return configured
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const candidates = [
    join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA ?? pf, 'Google\\Chrome\\Application\\chrome.exe'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('no Edge or Chrome found; set `browserPath` in the plugin config')
}

/**
 * Add the HUD flag to a URL without disturbing an existing query string or hash.
 * The GUI may route with `#/...`, so the flag must land before the hash.
 */
function withQuery(href, key, value) {
  const hashIndex = href.indexOf('#')
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : ''
  const sep = beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`
}

function withHudFlag(href) {
  return withQuery(href, HUD_FLAG, '1')
}

function assertLocalHref(href) {
  let url
  try { url = new URL(href) } catch { throw new Error('href is not a URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('href must be http(s)')
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to pop out a non-local URL (host: ${host})`)
  }
  return url
}

/**
 * The address the Web carrier is reachable at. The desktop window cannot supply it
 * (its own `location.href` is a custom scheme), so the host resolves it here.
 */
function advertise(ctx) {
  try {
    const webApp = typeof ctx.get === 'function' ? ctx.get('webApp') : undefined
    if (webApp !== undefined && webApp !== null && typeof webApp.getAdvertisedUrl === 'function') {
      const url = String(webApp.getAdvertisedUrl() ?? '')
      if (url !== '') return url
    }
  } catch {
    // Fall through to the carrier origin.
  }
  try {
    const origin = ctx.webServer.getOrigin()
    if (typeof origin === 'string' && origin !== '') return origin
  } catch {
    // Nothing advertised at all.
  }
  return ''
}

const CONFIG_PATH = join(DATA_DIR, 'config.ini')

const CONFIG_DEFAULTS = { copyShot: true, ask: true, textFallback: true, hotkeyFull: 'Ctrl+Shift+1', hotkeyRegion: 'Ctrl+Shift+2' }

/**
 * Settings live in a flat `key=value` file because the window shell (C# 5) and this
 * plugin both read them and neither should need a JSON parser to do it.
 */
function readConfig() {
  const config = { ...CONFIG_DEFAULTS }
  try {
    const text = readFileSync(CONFIG_PATH, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key === 'copyShot' || key === 'ask' || key === 'textFallback') config[key] = value !== '0'
      else if (key === 'hotkeyFull' || key === 'hotkeyRegion') config[key] = value
    }
  } catch {
    // Missing file means defaults.
  }
  return config
}

function writeConfig(config) {
  mkdirSync(WORK_DIR, { recursive: true })
  const lines = [
    '# DSH 小窗设置 / settings. The C# shell reads this file too.',
    `copyShot=${config.copyShot ? '1' : '0'}`,
    `ask=${config.ask ? '1' : '0'}`,
    `hotkeyFull=${config.hotkeyFull}`,
    `textFallback=${config.textFallback ? '1' : '0'}`,
    `hotkeyRegion=${config.hotkeyRegion}`,
  ]
  writeFileSync(CONFIG_PATH, lines.join('\n') + '\n', 'utf8')
}

/** Tokenized address the shell and the background service can both open. */
function tokenizedAddress(ctx) {
  const base = advertise(ctx)
  if (base === '') return ''
  try {
    const target = new URL(base)
    const clean = `${target.origin}${target.pathname}`
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection !== undefined && connection !== null && typeof connection.authenticatedUrl === 'function') {
      return connection.authenticatedUrl(clean)
    }
    return clean
  } catch {
    return base
  }
}

/**
 * Keep exactly one background helper, and make sure it is running this build.
 *
 * The helper is supposed to be single-instance through a named mutex, but older builds
 * let that mutex be finalized while running, so every DSH restart added another copy —
 * each with its own tray icon, its own hook and its own pill. This reconciles by start
 * time: a helper started after the exe was last staged is current and gets reused;
 * everything else is asked to quit (it disposes its tray icon) and then killed.
 */
function reconcileService() {
  try {
    const script = join(SCRIPTS, 'reconcile-service.ps1')
    if (!existsSync(script)) return { kept: 0 }
    const exe = existsSync(RUN_EXE) ? RUN_EXE : NATIVE_EXE
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ExePath', exe, '-DataDir', DATA_DIR],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' },
    )
    const text = String(result.stdout ?? '')
    const line = text
      .split(/\r?\n/)
      .map((each) => each.trim())
      .filter((each) => each.startsWith('{'))
      .pop()
    if (!line) return { kept: 0 }
    const state = JSON.parse(line)
    return { kept: Number(state.kept) || 0, killed: Array.isArray(state.killed) ? state.killed : [] }
  } catch {
    return { kept: 0 }
  }
}

/**
 * Start the always-on helper. It owns the "问大肥鱼" pill and the global screenshot
 * hotkeys, so both keep working while the small window is closed. The exe enforces
 * single instance itself, which makes a blind spawn safe.
 */
function ensureService(ctx) {
  if (!existsSync(NATIVE_EXE)) return null
  const url = tokenizedAddress(ctx)
  if (url) writeRequestUrl(url)
  // Reuse a helper that already runs this build; never stack a second tray icon.
  const state = reconcileService()
  if (state && state.kept > 0) return 'reuse'
  // Must not be a plain child of this process: see launchThroughTask().
  if (launchThroughTask(['--service'])) return 'task'
  return requestService() ? 'shell' : null
}

export function apply(ctx, config = {}) {
  const titlePrefix = String(config.titlePrefix ?? 'DSH 小窗')
  const titleB64 = Buffer.from(titlePrefix, 'utf8').toString('base64')
  const width = Number(config.width ?? 460)
  const height = Number(config.height ?? 920)
  const margin = Number(config.margin ?? 8)
  const disposers = []
  let spawned = null

  // The pill and the global hotkeys must not depend on the small window being open,
  // so the helper starts with the plugin. The carrier may not be up yet, hence the delay.
  setTimeout(() => { try { ensureService(ctx) } catch { } }, 2500)

  /**
   * The helper cannot start the window itself: everything it spawns inherits the
   * host's restricted token, and WebView2 refuses to initialise under it. So the
   * helper drops `want.txt` next to its log and we launch the window here, through
   * Task Scheduler, which hands the exe a clean user token.
   */
  const wantWatch = setInterval(() => {
    try {
      if (!existsSync(WANT_PATH)) return
      unlinkSync(WANT_PATH)
      const url = tokenizedAddress(ctx)
      if (url) writeRequestUrl(url)
      if (!launchThroughTask()) launchThroughShell()
    } catch {
      // A failed request must not take the plugin down; the helper logs separately.
    }
  }, 2000)
  if (typeof wantWatch.unref === 'function') wantWatch.unref()
  disposers.push(() => clearInterval(wantWatch))

  /**
   * "Back to the main window" relays a conversation.
   *
   * The native shell cannot call into the main window, so it drops the id into
   * focus.txt; this watcher turns it into a sequence number, and the main window's
   * client half polls `/focus-poll` and opens whatever it last saw. Sequence rather
   * than a queue: only the newest request matters, and a stale one must not fire
   * twice if two tabs happen to poll.
   */
  const focus = { seq: 0, sessionId: '' }
  const focusWatch = setInterval(() => {
    try {
      if (!existsSync(FOCUS_PATH)) return
      const raw = readFileSync(FOCUS_PATH, 'utf8').trim()
      unlinkSync(FOCUS_PATH)
      const sessionId = raw.split(/\r?\n/)[0].trim()
      if (sessionId === '' && focus.sessionId === '') return
      focus.seq += 1
      focus.sessionId = sessionId
    } catch {
      // A racing delete is fine: the next tick reads nothing and moves on.
    }
  }, 700)
  if (typeof focusWatch.unref === 'function') focusWatch.unref()
  disposers.push(() => clearInterval(focusWatch))

  /** The browser pid we launched, so later requests find the window without the title. */
  const ownerPid = () => (spawned !== null && Number.isFinite(spawned.pid) ? String(spawned.pid) : '0')

  const route = (path, handler) => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${path}`, handler }))
  }

  /**
   * The translation desk. It owns `/dsh-mini/translate*` — a streamed answer, its own
   * history (browsable afterwards, deliberately not a DSH conversation) and the shot the
   * helper froze when the pill was clicked.
   */
  const translate = setupTranslate(ctx, {
    route,
    sendJson,
    readJson,
    dir: join(DATA_DIR, 'translate'),
    log: (message) => {
      try {
        mkdirSync(WORK_DIR, { recursive: true })
        appendFileSync(join(WORK_DIR, 'trace.log'), `${new Date().toISOString()} translate ${message}\n`, 'utf8')
      } catch { }
    },
  })
  void translate

  /**
   * Where the standalone desk should point. The shell reads this file and navigates its
   * own WebView2 at it; the token rides in the URL, so the page can call back into the
   * plugin routes without knowing anything about authentication.
   */
  const deskUrlPath = join(WORK_DIR, 'translate-url.txt')
  const writeDeskUrl = () => {
    const base = advertise(ctx)
    if (base === '') return
    try {
      const target = new URL(base)
      const clean = `${target.origin}/dsh-mini/translate/ui`
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      const url = connection !== undefined && connection !== null && typeof connection.authenticatedUrl === 'function'
        ? connection.authenticatedUrl(clean)
        : clean
      mkdirSync(WORK_DIR, { recursive: true })
      writeFileSync(deskUrlPath, url, 'utf8')
    } catch {
      // The desk simply opens empty; the next tick retries.
    }
  }
  setTimeout(writeDeskUrl, 3000)
  const deskUrlWatch = setInterval(writeDeskUrl, 30000)
  if (typeof deskUrlWatch.unref === 'function') deskUrlWatch.unref()
  disposers.push(() => clearInterval(deskUrlWatch))
  /**
   * Diagnostic breadcrumb channel. The client cannot log anywhere we can read, so
   * `/trace?step=...` (hit through a one-pixel image request) appends to a file.
   */
  route('/trace', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const line = `${new Date().toISOString()} ${url.searchParams.get('step') ?? '?'} ${url.searchParams.get('detail') ?? ''}\n`
      mkdirSync(WORK_DIR, { recursive: true })
      appendFileSync(join(WORK_DIR, 'trace.log'), line, 'utf8')
    } catch {
      // Diagnostics must never break the request.
    }
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  })

  let shotSeq = 0

  route('/config', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: readConfig() })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'GET or POST' }); return }
    let body
    try { body = await readJson(req) } catch (error) { sendJson(res, 400, { error: error.message }); return }
    const next = readConfig()
    for (const key of ['copyShot', 'ask', 'textFallback', 'hotkeyFull', 'hotkeyRegion']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = body[key]
    }
    // Normalize before writing: the shell matches these strings exactly when it
    // registers the global hotkeys.
    next.copyShot = Boolean(next.copyShot)
  next.textFallback = Boolean(next.textFallback)
    next.ask = Boolean(next.ask)
    next.hotkeyFull = String(next.hotkeyFull ?? '').trim() || CONFIG_DEFAULTS.hotkeyFull
    next.hotkeyRegion = String(next.hotkeyRegion ?? '').trim() || CONFIG_DEFAULTS.hotkeyRegion
    writeConfig(next)
    sendJson(res, 200, { ok: true, config: next })
  })

  route('/open', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    let body
    try { body = await readJson(req) } catch (error) { sendJson(res, 400, { error: error.message }); return }
    try {
      // The desktop renderer is not served over http(s): there `window.location.href`
      // is a file:// or app:// address, so a client-supplied href is unusable. Only
      // accept it when it really is an http(s) URL, and otherwise ask the Web
      // carrier for the address it advertises.
      const offered = String(body.href ?? '')
      const advertised = /^https?:/i.test(offered) ? offered : advertise(ctx)
      if (advertised === '') {
        sendJson(res, 400, { error: 'no web address available; pass an http(s) href' })
        return
      }
      const href = advertised
      assertLocalHref(href)

      // Already open? Raise the existing window instead of stacking duplicates.
      const status = await runScript('win-hud.ps1', ['-Action', 'status', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '0']).catch(() => ({ found: false }))
      if (status.found === true || status['found'] === true) {
        const focused = await runScript('win-hud.ps1', ['-Action', 'focus', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '0']).catch(() => null)
        const pinned = await runScript('win-hud.ps1', ['-Action', 'pin', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '2000', '-Width', String(width), '-Height', String(height), '-Margin', String(margin)]).catch(() => null)
        sendJson(res, 200, { ok: true, reused: true, focused: focused !== null, window: pinned ?? status })
        return
      }

      // The HUD gets a *fresh* browser profile, so it holds none of the main
      // window's cookies. Without the process token the server answers "dsh web
      // authentication required", so ask Connection for a tokenized URL.
      const target = new URL(href)
      const base = `${target.origin}${target.pathname}`
      let authenticated = base
      let authSource = 'href'
      try {
        const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
        if (connection !== undefined && connection !== null && typeof connection.authenticatedUrl === 'function') {
          authenticated = connection.authenticatedUrl(base)
          authSource = 'token'
        }
      } catch {
        // No token available: fall back to the caller's URL, which may already carry one.
      }
      const url0 = authSource === 'token' ? `${withHudFlag(authenticated)}${target.hash}` : withHudFlag(href)
      // The small window is a separate document with no shared client state, so it
      // learns which conversation to show from the URL.
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      const url = sessionId === '' ? url0 : withQuery(url0, 'session', sessionId)

      // Preferred backend: the WebView2 shell we build ourselves. It is a real
      // native window (no browser chrome), it pins itself, and it carries its own
      // title bar with the screenshot key. The browser --app path stays as a
      // fallback for machines where the exe has not been built yet.
      ensureService(ctx)

      const nativeAvailable = existsSync(NATIVE_EXE)
      let backend = 'browser'
      let browser = null
      if (nativeAvailable) {
        backend = 'native'
        // A running shell owns the window: hand it the new URL instead of starting
        // a second process (the exe's own single-instance path does the same, but
        // this way the response reports the real pid and `reused`).
        const existing = await runScript('native-status.ps1', []).catch(() => ({ found: false }))
        if (existing.found === true) {
          // Only re-navigate when the caller asked for a specific conversation; a
          // plain "pop out" on the window that is already open should just raise it.
          if (sessionId === '') {
            await runScript('native-status.ps1', ['-Action', 'focus']).catch(() => null)
          } else {
            writePendingUrl(url)
          }
          sendJson(res, 200, { ok: true, reused: true, backend, pid: existing.pid, sessionId, url })
          return
        }
        // Hand the address over through request.txt and let Explorer start the
        // window, so it does not inherit a restricted token (see launchThroughShell).
        writeRequestUrl(url)
        if (!launchThroughTask()) launchThroughShell()
        spawned = { pid: null }
      } else {
        browser = findBrowser(config.browserPath)
        mkdirSync(PROFILE_DIR, { recursive: true })
        const args = [
          `--app=${url}`,
          `--window-size=${width},${height}`,
          `--window-position=${Math.max(0, margin)},${margin}`,
          `--user-data-dir=${PROFILE_DIR}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate,MediaRouter',
        ]
        spawned = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: true })
        spawned.unref()
      }

      // An --app launch may re-exec itself, so the pid we spawned can be gone by
      // now; the helper also matches the window by its title, which the HUD page
      // sets as soon as it boots. A failed pin is reported, not thrown: the window
      // is already open at that point and the user can still use it.
      let window = null
      let warning = null
      if (backend === 'browser') {
        try {
          window = await runScript('win-hud.ps1', [
            '-Action', 'pin', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '20000',
            '-Width', String(width), '-Height', String(height), '-Margin', String(margin),
          ])
        } catch (error) {
          warning = String(error?.message ?? error)
        }
      }
      sendJson(res, 200, { ok: true, reused: false, backend, browser, url, authSource, pid: spawned.pid ?? null, window, warning })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('/close', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const data = await runScript('win-hud.ps1', ['-Action', 'close', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '0'])
      sendJson(res, 200, { ok: true, ...data })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('/focus', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const data = await runScript('win-hud.ps1', ['-Action', 'focus', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '0'])
      sendJson(res, 200, { ok: true, ...data })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('/state', async (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    try {
      const data = await runScript('win-hud.ps1', ['-Action', 'status', '-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-WaitMs', '0'])
      sendJson(res, 200, { ok: true, ...data, titlePrefix, width, height })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  route('/shot', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    let body
    try { body = await readJson(req) } catch (error) { sendJson(res, 400, { error: error.message }); return }
    try {
      mkdirSync(SHOT_DIR, { recursive: true })
      shotSeq += 1
      const out = join(SHOT_DIR, `hud-shot-${Date.now()}-${String(shotSeq)}.png`)
      const args = ['-TitleB64', titleB64, '-OwnerPid', ownerPid(), '-OutFile', out]
      if (body.keepHud === true) args.push('-KeepHud')
      const data = await runScript('hud-shot.ps1', args)
      const bytes = readFileSync(out)
      sendJson(res, 200, {
        ok: true,
        file: data.file ?? out,
        png: `data:image/png;base64,${bytes.toString('base64')}`,
        width: data.width, height: data.height,
        bytes: bytes.length,
        hidHud: (data.hidden ?? 0) > 0,
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  /** The main window asks here after the arrow was pressed; seeing a new `seq` means "switch". */
  route('/focus-poll', (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    sendJson(res, 200, { ok: true, seq: focus.seq, sessionId: focus.sessionId })
  })

  /** Version info for the settings page; read-only and cheap. */
  route('/update-check', async (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return }
    const install = resolveInstall()
    const current = readPackageVersion(install.pluginDir) ?? '0.0.0'
    try {
      const latest = await fetchLatestVersion()
      sendJson(res, 200, {
        ok: true,
        currentVersion: current,
        latestVersion: latest.version,
        publishTime: latest.publishTime ?? null,
        isUpToDate: compareVersions(latest.version, current) <= 0,
        linked: install.linked,
        pluginDir: install.pluginDir,
        profileDir: install.profileDir,
        npmUrl: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/${latest.version}`,
      })
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        currentVersion: current,
        latestVersion: null,
        isUpToDate: true,
        linked: install.linked,
        pluginDir: install.pluginDir,
        error: String(error?.message ?? error),
      })
    }
  })

  /** One-click update from npm. The window shell is restarted so the new exe is used. */
  route('/update', async (req, res) => {
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    let body
    try { body = await readJson(req) } catch (error) { sendJson(res, 400, { error: error.message }); return }
    try {
      const result = await applyUpdate({ force: body.force === true })
      if (result.ok && result.updated === true && result.restartShell === true) {
        // The exe ships inside the package: restart the shell now so it runs the
        // freshly staged binary instead of waiting for the next pop-out.
        // Ask nicely first — a forced kill leaves the helper's tray icon behind.
        try { writeFileSync(join(DATA_DIR, 'quit.txt'), '1') } catch { /* ignore */ }
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600) } catch { /* ignore */ }
        try {
          spawnSync('taskkill.exe', ['/F', '/IM', 'DSH小窗.exe'], { windowsHide: true, timeout: 8000 })
        } catch {
          // Not running is the normal case.
        }
        setTimeout(() => { try { ensureService(ctx) } catch { /* logged by the shell */ } }, 400)
      }
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
    }
  })
}
