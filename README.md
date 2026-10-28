# dsh-mini

[![npm](https://img.shields.io/npm/v/dsh-mini.svg)](https://www.npmjs.com/package/dsh-mini)
[![license](https://img.shields.io/npm/l/dsh-mini.svg)](LICENSE)

仓库 https://github.com/xiaoxin3309/dsh-mini ｜ npm 包名 `dsh-mini`

把当前会话一键弹出成一个**独立置顶小窗**，小窗里有整屏截图和框选截图两个键（截图时小窗自己不进入画面，图片直接插进输入框）；在任意程序里选中文字，还会就地弹出「问大肥鱼」小药丸，点一下把小窗叫出来并引用那段话。

```
主窗 DSH                                     DSH 小窗（WebView2 原生窗口，置顶贴右）
┌──────────────────────────────┐            ┌───────────────┐
│ 会话标题            ▯ ← 弹出  │  ───────▶  │ DSH 小窗  ✕📌↔📷│
│                              │            │  会话标题  ☰ ⊕ │
│  对话 …                       │            │  对话 …        │
│                              ��            │               │
│  [+] … [发送]                 │            │ [+] … [发送]  │
└──────────────────────────────┘            └───────────────┘
                                            无边框自绘标题条、可拖拽、可缩放、置顶
```

## 它怎么工作

三个部分：

1. **宿主半身**（`lib/index.js`，跑在 DSH 的 Node 进程里）：注册 `/dsh-mini/*` 路由，
   负责拼地址（`webApp.getAdvertisedUrl()` + `connection.authenticatedUrl()`）、起窗口、转发截图。
2. **浏览器半身**（`lib/client.js`，跑在页面里）：主窗只注册一个「弹出此窗口」按钮；
   小窗里由原生壳的标题条负责交互，所以不再重复渲染按钮。
   另外把宿主给的 `session` 参数/converted cookie 变成 `uiWorkspace.openSession(sessionId)`，让小窗直接落在当前会话上。
3. **原生窗口壳**（`app/HudWindow.cs` → `app/bin/DSH小窗.exe`）：WinForms + WebView2，
   自绘标题条（`✕` 关闭、`📌` 置顶、`↔` 回主窗、`📷` 截图），无边框、可按边缘拖拽缩放、系统托盘。

### 为什么不直接 `window.open`

DSH 桌面主窗的 `setWindowOpenHandler` 对 http/https 一律 `shell.openExternal` 并 `deny`，
拿不到第二个 `BrowserWindow`；宿主进程又是 Electron main 的子进程，没有 Electron API。
所以窗口壳只能自己造：WebView2 复用系统自带的 Chromium，不必打包一整个 Electron。

### 401 与 token

小窗是**独立配置档**，没有主窗 cookie，裸地址会被回 `dsh web authentication required`。
所以 `/open` 用 `connection.authenticatedUrl()` 取进程 token；小窗打开后 GUI 会 302 到干净 URL
（query 全丢），因此壳在导航前写入两个 cookie：`dsh_hud=1`（小窗标志）和
`dsh_hud_session=<会话 id>`（要落哪个会话），页面侧据此恢复。

### 截图（两个键）

两个键都在原生壳内完成，不再调 PowerShell，小窗自己不会出现在画面里：隐藏自己 → 抓屏 →
PNG → base64 → `postMessage` 给页面 → 走 Lexical 粘贴事件塞进输入框。

| 键 | 行为 |
|---|---|
| `📷` 截整屏 | 一次截下整个虚拟桌面，直接进输入框 |
| `⧉` 框选 | 冻结当前桌面 → 全屏遮罩里**移动鼠标即自动吸附到光标下那个窗口**（带窗口标题和尺寸标签），**单击**就截这个窗口；**拖拽**则自由框选一块矩形；`Esc` / 右键取消 |

框选的实现要点（`app/RegionCapture.cs`）：

- 遮罩自己盖住整屏，所以**不能用 `WindowFromPoint`**（它只会返回遮罩自己）。正确顺序是：
  先把屏幕冻结成位图，再在遮罩出现**之前**用 `EnumWindows` 快照窗口列表（顶层在前，
  跳过自身进程 / `WS_EX_TOOLWINDOW` / 空标题 / `DWMWA_CLOAKED` 幽灵窗 / 任务栏与桌面），
  然后按 z 序取「第一个包含光标的矩形」——等于遮罩不存在时 `WindowFromPoint` 的答案。
- 窗口矩形用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取，去掉 DWM 给最大化窗口
  加的那圈隐形边框，截出来的图和眼睛看到的一致。
- **单位必须统一到物理像素**：本进程是 per-monitor v2，而 `SystemInformation.VirtualScreen`
  走 `GetSystemMetrics`，会按**线程**的 DPI 上下文作答，在 150% 缩放下返回逻辑尺寸
  （1707x1067 而不是 2560x1600），遮罩就只盖住屏幕左上一块。所以虚拟屏改用
  `EnumDisplayMonitors` + `GetMonitorInfo` 的 `rcMonitor` 并集（永远是物理像素），
  遮罩窗口再用 `SetWindowPos` 按物理坐标钉住；选区、候选窗口、光标一律存物理坐标，
  只在绘制时用 `PointToClient` 换算一次。

### 配色与缩放（v0.1.x 两处关键修法）

- **边框跟着页面主题走**：导航完成后（400ms / 1800ms 各一次）读出
  `getComputedStyle(document.body).backgroundColor` 和 `color`，解析成 RGB 后
  `ApplyChrome(bg, fg)`：窗体底色 = 页面底色、标题条 = 底色混 4% 前景色、图标色 = 前景色混底色、
  再按亮度决定要不要 `DWMWA_USE_IMMERSIVE_DARK_MODE`。深色主题下自动变深，浅色下自动变浅，
  不会出现「浅色页面套黑框」。
- **不要用 CSS `body{zoom}` 缩小页面**：它只缩「已用高度」，视口没变，右/底会留空白带。
  正确做法是 WebView2 原生 `web.ZoomFactor = 0.9`——布局视口会变成 `460/0.9≈511` CSS px，
  页面四周都填满。

## 界面上的东西

| 位置 | 主窗 | 小窗标题条（从左到右） |
|---|---|---|
| 按钮 | 会话标题栏右侧 `▯` 弹出此窗口 | `✕` 关闭、`📌` 置顶、`↔` 回主窗、`📷` 截整屏、`⧉` 框选 |

小窗打开的是**当前会话**；再点一次「弹出此窗口」不会开第二个窗口，只是把已有窗口提到前面
（带会话参数时才重新导航）。

## 系统要求

跑起来需要的东西，**除了第一行都必须由机器自备**（`dsh-mini` 只带插件代码 + `app/bin` 里那 4 个文件）：

| 依赖 | 谁提供 | 说明 |
|---|---|---|
| `node` ≥ 20 + DSH ≥ 0.2.0-rc.1 | DSH 本体 | `dsh.compatibility` 声明的范围 |
| Windows 10 1903+ / 11，**x64** | 系统 | 原生壳按 `/platform:x64` 编译，`WebView2Loader.dll` 只有 win-x64；`package.json` 有 `"os": ["win32"]` |
| **.NET Framework 4.x**（4.7.2 以上） | 系统自带 | 原生壳是 WinForms + `csc` 编的 .NET Framework exe；`UIAutomationClient`/`UIAutomationTypes`/`WindowsBase` 都用 GAC 里的系统版本，不用另外装 |
| **Microsoft Edge WebView2 Runtime** | **需要自备** | 小窗就是 WebView2 窗口，没有它开不出画面。Win11 通常自带；Win10 多数机器随 Edge 已装。缺的话原生壳会弹窗给出官方下载地址（Evergreen 包），装完重开小窗即可。**包内不含 runtime**（几百 MB，且应走系统更新） |
| Windows PowerShell 5.1 | 系统自带 | 只在浏览器回退模式（`backend:"edge"`）和 `scripts/native-status.ps1` 查进程时用；原生模式下截图/划词全是 C# |
| 剪贴板、全局热键 | 用户权限 | 划词读选区用的 UIA/`Ctrl+C` 走当前用户桌面；管理员窗口（UIPI）里的选区读不到，这是 Windows 的限制 |

数据目录固定是 `%LOCALAPPDATA%\dsh-hud\`（`config.ini`、`window.txt`、日志、WebView2 用户数据），
改名前后没动过，装到别的机器上也是这个路径、按用户隔离。

## 安装（本机已做）

profile 走 `link:` 依赖，和 `tju-plugin` 一样：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-mini": "link:C:/Users/xiaoxin3309/Documents/deepseek-harness/default-workspace/dsh-hud-window" },
"dsh": { "profile": { "bundles": [ ..., "dsh-mini" ] } }
```

`node_modules/dsh-mini` 是指向本目录的 junction，改代码不需要重新安装。
宿主半身（`lib/index.js`）的改动需要 `plugin_manager set_bundle` 关一次再开一次（或重启 DSH）；
浏览器半身（`lib/client.js`）的改动需要**刷新页面**（`F5`）——bundle 的 `rev` 由内容算出，刷新即取新版。

## 配置

`cordis.patch.yml`：

| 键 | 默认 | 说明 |
|---|---|---|
| `titlePrefix` | `DSH 小窗` | 窗口标题（也是浏览器回退模式下找窗口的依据） |
| `width` / `height` | 460 / 560 | 小窗初始尺寸（逻辑像素），超出工作区自动夹紧 |
| `browserPath` | 空 | 只在没有 `app/bin/DSH小窗.exe` 的回退模式下使用 |

## 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-mini/open` | POST | `{sessionId?}` → 起小窗（`backend:"native"`）或复用已有窗口 |
| `/dsh-mini/close` | POST | 关掉小窗 |
| `/dsh-mini/focus` | POST | 重新置顶 |
| `/dsh-mini/shot` | POST | 截全屏（不含小窗），回 dataURL |
| `/dsh-mini/state` | GET | 小窗是否在跑 |
| `/dsh-mini/trace` | GET | 诊断信标：把 `step/detail` 追加到 `%LOCALAPPDATA%\dsh-hud\trace.log` |

## 构建原生壳

```powershell
cd app
./build-app.ps1      # 从 %TEMP%\wv2 或 NuGet 取 WebView2 依赖 → csc 编译 → 产物在 app/bin/
```

只用到 .NET Framework 自带的 `csc.exe`（C# 5 语法，别写 `$"..."`、`?.`、`nameof`）。
**编译前先关掉正在跑的小窗**，否则 `csc` 会报 `CS0016 未能写入输出文件 … 另一个程序正在使用此文件`。

## 调试

* `%LOCALAPPDATA%\dsh-hud\hud.log`：壳自己的日志（导航、eval 结果、异常）。
* `%LOCALAPPDATA%\dsh-hud\trace.log`：页面侧信标（`apply` / `click` / `opened` / `open-failed`）。
  页面没有 console 通道，这是唯一能从外部看到页面行为的办法。
* `app/dev.ps1 -Build -Url <带 token 的地址> [-Eval probe.js]`：杀旧进程 → 构建 → 启动 → 跑一段
  JS 到页面里 → 打印 `hud.log`。`app/probe/*.js` 是现成的探测脚本。
* 页面里跑 eval 的办法：把 JS 写进 `%LOCALAPPDATA%\dsh-hud\eval.js`，壳 700ms 内会执行并把结果写进 `hud.log`。

## 划词问大肥鱼

在**任何程序**里用鼠标选中一段文字，松开后光标右下方会弹出蓝色小药丸「问大肥鱼」；点它，
小窗自动弹到最前，选中的内容以引用块（每行 `> ` 前缀）插进输入框，直接接着提问即可。

* 实现在 `app/SelectionWatcher.cs`：全局鼠标钩子（90ms 轮询）→ 松开时若拖动距离 ≥6 逻辑像素、
  且不在小窗/药丸自己身上 → 后台线程等 130ms（双击选词等 320ms）→ 校验仍在前台 → 取选区。
* Windows 没有「给我当前选区」的 API，所以取选区是：备份剪贴板 → 发一次 `Ctrl+C` →
  轮询 `GetClipboardSequenceNumber()` 变化（最多 900ms）→ 读文本 → **还原剪贴板**。
  用序列号而不是「文本变了没」，重复选同一段也能识别。
* 三处保护：终端窗口（console/cascadia/mintty/putty）**不发** `Ctrl+C`（会变 SIGINT）；
  资源管理器/桌面/任务栏（Progman/WorkerW/CabinetWClass…）直接跳过（否则会真的复制文件、
  污染 `Win+V` 剪贴板历史）；用户已切窗就不发。
* 药丸 9 秒无操作自动消失；托盘菜单「划词问大肥鱼」可随时关掉，状态存在
  `%LOCALAPPDATA%\dsh-hud\ask.txt`。
* 因此**标题条 ✕ 只是收进托盘**（不是退出）——watcher 活在这个进程里，退出了就没法划词。
  彻底退出用托盘菜单「退出」。
* 诊断：`hud.log` 里 `[pill]` 开头的行会写每次 `kick / skip / read N chars`；
  往 `%LOCALAPPDATA%\dsh-hud\seltest.txt` 写任意内容可触发一次「只读不弹」的自检。

## 常驻划词服务、全局快捷键与设置页

小窗关着也要能划词，所以插件会拉起一个常驻进程（同一个 exe 的 `--service` 模式）：

```
DSH小窗.exe --service --url <tokenized>    # Mutex Local\DshHudService，单实例
```

* 托盘图标「DSH 划词服务」：双击开小窗；菜单可开关划词、退出。
* 划词命中后药丸出现在**选中内容最后一个元素的右下方**（`x = sel.Right + 10`、`y = sel.Bottom + 8`）—— 落在最后一行下面、右边，不会盖住你刚划出来的字。右边顶到屏幕边缘就整体左移到选区右端对齐（仍留在下方）；下方也放不下时翻到最后一行的上方；最后统一 clamp 到 `GetMonitorInfo().rcWork`，**任何情况下都不会跑出屏幕**。
* 关掉小窗（✕）只是收进托盘 —— 服务死在同一个进程里，退出就再没有划词。

### 全局快捷键

服务用 `RegisterHotKey` 注册两个组合，触发后写 `cmd.txt` 并唤起小窗执行：

| 默认 | 动作 |
| --- | --- |
| `Ctrl+Shift+1` | 整屏截图（`DoScreenshot`） |
| `Ctrl+Shift+2` | 框选截图（`DoRegionCapture`） |

> 默认值刻意避开 `Ctrl+Alt+1/2`：这台机器上 `Ctrl+Alt+1`、`Ctrl+Alt+2`、`Ctrl+Alt+A/X`
> 都被别的程序占了（`RegisterHotKey` 直接返回 false，日志里是 `hotkey full busy: …`）。
> 想换组合在设置页里改，用 `Ctrl/Alt/Shift/Win` + 字母/数字/F1–F24/PrintScreen 等写法。

### 设置页

主窗「设置 → DSH 小窗」：

* 截图自动复制到剪贴板（默认开，整屏/框选都复制）；
* 全屏截图快捷键、框选截图快捷键（失焦即保存）。

配置落在 `%LOCALAPPDATA%\dsh-hud\config.ini`（`key=value`，C# 壳、宿主插件、客户端三边都读），
服务每 2.5 秒看一次文件时间戳，改完约 3 秒内生效并重新注册热键。

## 打包与分发

```powershell
cd app; ./build-app.ps1      # 先把窗口壳编出来（app/bin/*.exe）
cd ..;  npm pack             # → dsh-mini-0.1.0.tgz（约 600 KB）
```

* 包里**已经带上** `app/bin/` 的 `DSH小窗.exe` 和三个 WebView2 dll，所以装完不用再编译。
* 装到另一个 profile / 另一台机器：

  ```jsonc
  // ~/.dsh/profiles/<profile>/package.json
  "dependencies": { "dsh-mini": "file:D:/path/to/dsh-mini-0.1.0.tgz" },
  "dsh": { "profile": { "bundles": [ … , "dsh-mini" ] } }
  ```

  然后重启 DSH（宿主插件只在启动时加载；客户端 bundle 刷新页面即可）。
* `app/build-app.ps1` 自己会解决 WebView2 依赖：先找 `app/vendor/`，再找 `%TEMP%\wv2`，
  都没有就从 NuGet 下 `Microsoft.Web.WebView2 1.0.4314.35` 并解压 —— 空机器上也能直接编（实测 28 秒）。
* exe 文件名是用码点拼的（`'DSH' + [char]0x5C0F + [char]0x7A97`），故意不写中文字面量：
  这个脚本一旦丢掉 BOM，powershell 5.1 会按 GBK 解析，字面量就会变成 `DSH灏忕獥.exe`（踩过两次）。

## 已知边界

* 仅 Windows；依赖系统 WebView2 Runtime（Win10/11 一般自带）。
* 小窗是**独立的浏览器上下文**：主窗的输入框草稿、滚动位置不会带过去，但会话内容通过宿主读得到。
* 截图只有「整屏」和「框选/吸附窗口」两种，没有滚动长截图；框选吸附依赖窗口标题非空，
  无标题窗口（部分全屏游戏、自绘界面）会退化成「该点所在的整块屏幕」。
  （滚动长截图评估过：要拼接滚动帧 + 去重 + 处理懒加载，工作量明显大于本轮其它几项，先没做。）
* 划词优先走 UI Automation `TextPattern.GetSelection()`（无侵入、能拿到选区矩形），
  只有 UIA 读不到时才回退「发 Ctrl+C 读剪贴板」；终端（console/cascadia/mintty/putty）
  和桌面/资源管理器窗口直接跳过，避免 Ctrl+C 变成 SIGINT 或真的复制文件。
* 主题色与小窗边框：导航完成后同步两次，另外每 6 秒复查一次页面背景色；
  跨显示器拖到不同 DPI 的屏会收到 `WM_DPICHANGED` 并重算标题条/图标/最小尺寸。
* 标题条图标是 `Segoe MDL2 Assets` 字体，字号偏小（E8BB 关闭键取 8.5f 才和其它图标一样大）。

