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

运行时数据在 **`<插件目录>\app\bin\data\`**（`config.ini`、`window.txt`、`hud.log`、`request.txt`、
WebView2 用户数据），和 exe 放在一起、按用户隔离。之所以不再放 `%LOCALAPPDATA%\dsh-hud\`：

宿主进程树下派生的子进程可能带着受限令牌，连用户目录都写不了（`0x80070005`），
而 exe 自己的目录一定可写；数据一旦落在用户目录，小窗连日志都写不出来。
`config.ini` 首次运行时会从旧位置自动搬过来，老用户不用手工迁移。

## 安装

### A. 从 npm 装（别人用这个）

```bash
cd ~/.dsh/profiles/desktop
npm install dsh-mini
```

然后在同一个 `package.json` 的 `dsh.profile.bundles` 末尾加一项 `"dsh-mini"`，重启 DSH（或 `plugin_manager set_bundle` 关一次再开一次）。

装完不需要额外配置：插件会在 DSH 启动 2.5 秒后自己拉起常驻服务（划词药丸 + 全局热键 + 托盘），小窗由标题栏的「弹出此窗口」按需打开。**前提是机器上已有 WebView2 Runtime**（见上面「系统要求」）。

> **exe 会被自动复制到工作区之外**：第一次用到时，插件把 `app/bin/` 里的 exe 与三个 dll
> 拷到 `%LOCALAPPDATA%\dsh-mini\bin\`，之后一切都从那里跑（数据目录是同级 `bin\data\`）。
> 原因见下面「为什么不能就地运行」——DSH 的工作区沙箱会按镜像路径限制**位于工作区里的**可执行文件，
> 就地跑会出现「写不了 AppData、读不到鼠标、WebView2 拒绝访问」这一串怪现象。

### B. 源码 link（改代码时用）

改代码不必每次 `npm pack`，把 profile 里的依赖指向你本地这份仓库即可：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-mini": "link:<本仓库在你机器上的绝对路径>" },
"dsh": { "profile": { "bundles": [ ..., "dsh-mini" ] } }
```

把 `<本仓库在你机器上的绝对路径>` 换成你 clone 下来的那个目录（例如 `C:/code/dsh-mini`），
然后 `npm install` 让 npm 建好 `node_modules/dsh-mini` 这层链接；之后改代码不需要重新安装。
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
| `/dsh-mini/trace` | GET | 诊断信标：把 `step/detail` 追加到 `<data>\trace.log` |

## 构建原生壳

```powershell
cd app
./build-app.ps1      # 从 %TEMP%\wv2 或 NuGet 取 WebView2 依赖 → csc 编译 → 产物在 app/bin/
```

只用到 .NET Framework 自带的 `csc.exe`（C# 5 语法，别写 `$"..."`、`?.`、`nameof`）。
**编译前先关掉正在跑的小窗**，否则 `csc` 会报 `CS0016 未能写入输出文件 … 另一个程序正在使用此文件`。

## 调试

`<data>` 指 `%LOCALAPPDATA%\dsh-mini\bin\data\`（exe 就在它隔壁 `bin\` 里）。

* `<data>\hud.log`：壳自己的日志（导航、WebView2 各阶段、划词、eval 结果、异常）。
* `<data>\trace.log`：页面侧信标（`apply` / `click` / `opened` / `open-failed`）。
  页面没有 console 通道，这是唯一能从外部看到页面行为的办法。
* `app/dev.ps1 -Build -Url <带 token 的地址> [-Eval probe.js]`：杀旧进程 → 构建 → 启动 → 跑一段
  JS 到页面里 → 打印 `hud.log`。`app/probe/*.js` 是现成的探测脚本。
* 页面里跑 eval 的办法：把 JS 写进 `<data>\eval.js`，壳 700ms 内会执行并把结果写进 `hud.log`。
* 三个开关文件（存在即开，删掉即静默）：`<data>\uia.txt`（UIA 详情）、`<data>\poll.txt`（轮询/hook 状态）、
  `<data>\seltest.txt`（触发一次只读不弹的自检）。

## 划词问大肥鱼

在**任何程序**里用鼠标选中一段文字，松开后光标右下方会弹出蓝色小药丸「问大肥鱼」；点它，
小窗自动弹到最前，选中的内容以引用块（每行 `> ` 前缀）插进输入框，直接接着提问即可。

* 实现在 `app/SelectionWatcher.cs`：**低级鼠标钩子**（`SetWindowsHookEx(WH_MOUSE_LL)`）拿按下/抬起，
  松开时若拖动距离 ≥6 逻辑像素、且不在小窗/药丸自己身上 → 后台线程等 130ms（双击选词等 320ms）→
  校验仍在前台 → 取选区。
  > 为什么不用 90ms 轮询 `GetAsyncKeyState`：从 DSH 宿主进程树里派生出来的进程读不到输入状态
  > （恒为 0，实测 `poll alive down=False ks=False`），钩子能在系统层面收到消息，不受这个限制。
  > 钩子装不上时才回退到轮询。
* **判断「这次划词该不该管」用的是前台窗口，不是光标下的窗口**。WinUI 版记事本、设置、截图工具这类应用的
  内容在独立合成层里，`WindowFromPoint` 在它们内部会返回桌面 `Progman` —— 早期按坐标判断时，这些窗口里的
  划词全被当成"点在桌面上"跳过（日志里是一串 `skip: shell surface Progman`）。现在只在一个窗口**确实是**
  桌面 / 任务栏 / 资源管理器时才跳过，坐标只用于给药丸定位。
* **取选区三级阶梯**（`SelectionReader.ReadHit`），从最无侵入的一档开始：
  1. **UI Automation**（`TextPattern`）—— 不碰键盘、不碰剪贴板，还能拿到选区最后一行/一个字的矩形，
     药丸因此能精确贴在它右下角。Notepad、Word、WPS、VS Code、WinForms/WPF、DSH 自己都走这一档。
  2. **`WM_COPY`** —— 发给焦点控件，不发按键。部分老式编辑框只认这条。
  3. **合成一次 `Ctrl+C`** —— 只有前两档都拿不到时才用。**浏览器正文（Chromium）、部分 Electron 应用、
     某些游戏/自绘控件根本没有 `TextPattern` 也没有 `WM_COPY`，这是唯一可行的手段**。
* **绝不做「备份剪贴板 → 复制 → 还原」**。之前那套是"选中后复制不上"的元凶：还原那一步会把你刚按的
  `Ctrl+C` 覆盖回旧内容。现在第三档会**把选区留在剪贴板里**（你在浏览器里划一下就发现 `Ctrl+V` 有内容了），
  代价是<u>占用</u>剪贴板，而不是<u>破坏</u>它 —— 这是读取 Chromium 选区的唯一代价，取舍写在明处。
* 设置页的「选区读取：辅助功能读不到时改用复制」**默认打开**；关掉后浏览器正文里就不会再弹按钮，
  但剪贴板绝对不会被碰（适合只用 Office/记事本、或对剪贴板敏感的场景）。
* 保护：按住 Ctrl/Alt/Shift 时的拖动直接跳过（那是复制/扩选，不是重新选词）；终端
  （console/cascadia/mintty/putty）不发按键；资源管理器/桌面/任务栏（Progman/WorkerW/CabinetWClass…）
  一律跳过（否则会真的复制文件、污染 `Win+V` 历史）；用户按着修饰键期间完全不介入。
* 药丸 9 秒无操作自动消失；托盘菜单「划词问大肥鱼」可随时关掉，状态存在
  `%LOCALAPPDATA%\dsh-mini\bin\data\ask.txt`。
* 因此**标题条 ✕ 只是收进托盘**（不是退出）——watcher 活在这个进程里，退出了就没法划词。
  彻底退出用托盘菜单「退出」。
* 诊断：`hud.log` 里 `[pill]` 开头的行会写每次 `kick / skip / read N chars`，以及实际走了哪一档：
  `copy: wm_copy N chars`、`copy: key_chord N chars seq A->B`（`0 chars` 且序号没动，说明那儿没有真选中
  或目标程序忽略了合成按键）；`kick` 行还带 `fg= / root= / class= / underCursor=`，一眼看出命中的是哪个窗口。
  往 `<data>\seltest.txt` 写任意内容可触发一次「只读不弹」的自检；`<data>\uia.txt`、`<data>\poll.txt`
  分别是 UIA 详情与轮询状态的高噪声追踪，删掉文件即静默（`<data>` = `%LOCALAPPDATA%\dsh-mini\bin\data`）。

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
* 兼容模式：读不到选区时模拟 `Ctrl+C`（**默认关**。关着时只用系统辅助功能读选区，
  完全不碰剪贴板、不发按键；打开后老式控件才读得到，代价是可能和自己按的 `Ctrl+C` 抢剪贴板）；
* 全屏截图快捷键、框选截图快捷键（失焦即保存）。

配置落在 `<插件目录>\app\bin\data\config.ini`（`key=value`，C# 壳、宿主插件、客户端三边都读），
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

### 小窗是怎么被启动的（重要）

#### 为什么不能就地运行（DSH 工作区沙箱）

DSH 的工作区沙箱是**按可执行文件所在路径**生效的：只要 exe 躺在工作区目录里，它派生出来的进程就会
继承受限的作业对象 / 令牌 —— 具体表现是三条，全都命中过：

| 现象 | 日志指纹 |
| --- | --- |
| 写不了 `%LOCALAPPDATA%` / `%TEMP%` | `DIAG … appdata=FAIL temp=FAIL 0x80070005` |
| 读不到鼠标状态 | `poll alive down=False ks=False held=0000/0000/0000` |
| WebView2 初始化被拒 | `wv2: FAIL UnauthorizedAccessException 0x80070005` |

对照组很简单：把同一份 exe 拷到 `%LOCALAPPDATA%\dsh-mini-test\` 再跑，`DIAG` 立刻变成
`appdata=OK temp=OK`。所以插件在第一次运行前会 `stageExe()` 把
`app/bin/DSH小窗.exe` + 三个 dll 复制到 `%LOCALAPPDATA%\dsh-mini\bin\`（按 size+mtime 比对，改代码后
自动更新；目标正被占用时先 `rename` 到 `.busy-<时间戳>` 再复制，Windows 允许重命名运行中的镜像）。

#### 为什么用计划任务

即使 exe 搬出了工作区，**从宿主进程树里 `spawn` 出来的子进程**依旧可能在 `EnsureCoreWebView2Async`
处吃 `E_ACCESSDENIED`。改用 Task Scheduler 服务创建进程则拿到干净的用户令牌，WebView2 正常初始化。
所以插件不直接 `spawn` 小窗，而是 `schtasks /Create /XML … /TN DshMiniWindow` 再 `/Run`。

任务是用 **XML** 建的，不是 `/SC ONCE` 那套开关 —— 因为命令行开关建出来的任务默认
`DisallowStartIfOnBatteries=true`，笔记本在用电池时任务只会停在 `Status: Queued`，exe 根本不启动
（踩过：窗口"点了没反应"，`schtasks /Query` 里是 Queued）。XML 里显式写：

```xml
<Settings>
  <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
</Settings>
<Triggers><TimeTrigger Enabled="false"><StartBoundary>2099-12-31T23:59:00</StartBoundary></TimeTrigger></Triggers>
```

触发开关是 `Enabled="false"` + 2099 年，所以它永远不会自己弹窗，只有点「弹出此窗口」时被手动 `Run`。
每次打开都 `/F` 覆盖创建，指向当前安装路径；普通用户即可创建，不需要管理员权限。
如果所在机器禁止创建计划任务，插件会回退成直接 `spawn`（受限情况下 WebView2 可能起不来）。

后台服务（划词药丸、全局热键）不需要 WebView2，用的是同名机制的 `DshMiniWindowService` 任务
（同样 XML、同样 2099 触发），这样它也能读到鼠标钩子。

卸载插件不会删除这两个任务（npm 卸载没有钩子），需要时手工清掉：

```powershell
schtasks /Delete /TN DshMiniWindow /F
schtasks /Delete /TN DshMiniWindowService /F
```
排查时看 `app\bin\data\hud.log`，正常应该是：

```
wv2: begin
wv2: udf writable=…\app\bin\data\webview2
wv2: env ok 151.x
wv2: ensured
wv2: ready
```

如果停在 `wv2: FAIL UnauthorizedAccessException 0x80070005`，说明这次进程是直连启动的
（计划任务创建失败，插件回退到了 `spawn`），检查 `schtasks /Query /TN DshMiniWindow` 是否还在、
以及当前账户有没有创建计划任务的权限（普通用户默认可以建自己的任务）。
## 已知边界

* 仅 Windows；依赖系统 WebView2 Runtime（Win10/11 一般自带）。
* 小窗是**独立的浏览器上下文**：主窗的输入框草稿、滚动位置不会带过去，但会话内容通过宿主读得到。
* 截图只有「整屏」和「框选/吸附窗口」两种，没有滚动长截图；框选吸附依赖窗口标题非空，
  无标题窗口（部分全屏游戏、自绘界面）会退化成「该点所在的整块屏幕」。
  （滚动长截图评估过：要拼接滚动帧 + 去重 + 处理懒加载，工作量明显大于本轮其它几项，先没做。）
* 划词按三级阶梯取选区：UIA `TextPattern`（无侵入、带选区矩形）→ `WM_COPY`（发消息、不发按键）→
  合成一次 `Ctrl+C`。**Chromium 正文没有 `TextPattern`、也不响应 `WM_COPY`**（我实测过 UIA 与
  IAccessible2 两条路都拿不到选区），所以浏览器里必然走到第三档，会占用剪贴板；不想被碰可在设置页关掉
  「选区读取：辅助功能读不到时改用复制」。终端（console/cascadia/mintty/putty）和桌面/资源管理器窗口
  直接跳过，避免 Ctrl+C 变成 SIGINT 或真的复制文件。**任何情况都不再还原旧剪贴板内容**——那正是以前
  「选中后 Ctrl+C 复制不上」的根因。
* 主题色与小窗边框：导航完成后同步两次，另外每 6 秒复查一次页面背景色；
  跨显示器拖到不同 DPI 的屏会收到 `WM_DPICHANGED` 并重算标题条/图标/最小尺寸。
* **DSH 自己的窗口里不会弹药丸**（有意如此，不做）：主窗是 Electron/Chromium，`Chrome_WidgetWin_1`
  在辅助功能没激活时不暴露文本（实测 `textFound=True` 但 `uia raw=0`），只剩合成 `Ctrl+C` 这一档，
  而它会和页面自己的复制粘贴抢剪贴板。真要支持，正路是在 `lib/client.js` 里监听页面内
  `selectionchange` + 自绘药丸（`dsh-selection-explain` 就是这么做的）——那是另一个功能，不混进本插件。
* 药丸对小窗和它自己免疫（`OverOwnWindows`），所以在小窗内部划词也不会弹。
* 标题条图标是 `Segoe MDL2 Assets` 字体，字号偏小（E8BB 关闭键取 8.5f 才和其它图标一样大）。

