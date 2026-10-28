# DSH 小窗 2.0：自研原生窗口方案

> 变更理由：Edge `--app` 虽然能用，但窗口是浏览器托管的——标题由页面自管、进程会 re-exec、没法做托盘/单实例/自绘标题条。改成自己造一个窗口壳，页面内容仍然用 DSH 自己的 UI。

---

## 1. 三条路的技术对比（已调研）

| 方案 | 体积 | 前置条件 | 窗口可控性 | 结论 |
|---|---|---|---|---|
| Edge `--app`（现状） | 0 | 装 Edge | 差（浏览器窗口，标题/进程都不受控） | 弃用，保留为兜底 |
| Electron 便携壳 | ~100MB 下载 | 无 | 好 | 太重，为一个 460px 小窗不值 |
| Pake / Tauri | ~5MB | 需 Rust 工具链或预编译二进制 | 好 | 环境不具备，链路长 |
| **WebView2 + WinForms** | **exe ~200KB + 3 个 dll（约 1MB）** | 系统已装 WebView2 Runtime | **好** | **采用** |

### WebView2 路线已实测可行的证据
- WebView2 Runtime 已装：`HKLM`SOFTWARE`WOW6432Node`Microsoft`EdgeUpdate`Clients`{F3017226-...}` → `pv=155.0.4283.62`
- 系统自带 C# 编译器：`C:`Windows`Microsoft.NET`Framework64`v4.0.30319\csc.exe`（14.8.10001），.NET Framework 4.8.10008 → **不需要装 dotnet SDK**
- NuGet 可达，已下载 `Microsoft.Web.WebView2 1.0.4314.35` 到 `%TEMP%\wv2`，关键文件：
  - `lib`net462`Microsoft.Web.WebView2.Core.dll`（703 KB）
  - `lib`net462`Microsoft.Web.WebView2.WinForms.dll`（38 KB）
  - `runtimes\win-x64`native`WebView2Loader.dll`（195 KB）

---

## 2. 窗口形态（小尺寸悬浮窗）

- 默认 **460 × 920** 逻辑像素，可拉伸（最小 380 × 520）
- **无系统边框**，自绘 32px 标题条：
  - 左：`DSH 小窗 · <会话名>`
  - 右：📷 截图 / 📌 置顶开关 / ✕ 关闭
- 默认置顶、贴当前显示器右缘；拖动后记住位置（`%LOCALAPPDATA%\dsh-hud\window.json`）
- `Esc` 收进托盘；托盘单击唤醒
- **单实例**：命名 Mutex，重复启动只把新 URL 转发给已开窗口
- 支持多显示器 + 高 DPI（manifest 声明 PerMonitorV2）

---

## 3. 内容层：为什么仍然用 DSH 自己的 UI

会话渲染、工具调用卡片、审批弹窗、图片粘贴、@ 引用、思考过程折叠……都是 DSH 客户端组件。自己重写等于重做半个产品，且会随 DSH 升级立刻失效。

所以策略是「**保留组件、只改布局**」：

- 隐藏左侧会话列表（侧栏）
- 隐藏会话 header 的冗余控件，只留标题
- 压缩消息区与 composer 的内外边距
- 输入框、发送键、📄 文件按钮全部原样保留

### 关于「选择模型」——不用自研
DSH composer 里本来就有模型选择槽位：`conversation.input.model`（源码 `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`，注释原文 *"ModelSelect: the composer's named model seat"*）。它是 Model / Effort 二级下拉。

窄宽度下它会自动缩成图标形态（CSS 变量 `--dsh-composer-model-icon-display` / `--dsh-composer-model-text-display`），460px 宽度足够，保持原样即可。

---

## 4. 架构（三层）

```
┌─ DSH 主窗（Electron）─────────────┐
│ 右上角 [⧉ 弹出此窗口]             │
└───────────┬───────────────────────┘
            │ POST /dsh-mini/open {href}
┌───────────▼───────────────────────┐
│ 宿主插件 dsh-hud-window           │
│  connection.authenticatedUrl()    │
│  → 生成带 token 的 URL            │
│  → StartProcess DSH小窗.exe       │
└───────────┬───────────────────────┘
            │ --url <tokenized>&dshHud=1
┌───────────▼───────────────────────┐
│ 原生壳 DSH小窗.exe (WebView2)     │
│  - 无边框/置顶/托盘/单实例        │
│  - 导航前写 cookie dsh_hud=1      │
│  - WebMessage 通道 ⇄ 页面         │
└───────────┬───────────────────────┘
            │ 加载 http://127.0.0.1:58791/?token=...
┌───────────▼───────────────────────┐
│ 页面内的客户端插件（HUD 模式）    │
│  - 紧凑 CSS（隐藏侧栏/压缩间距）  │
│  - 工具条按钮（截图等）           │
│  - insertIntoComposer 注入图片    │
└───────────────────────────────────┘
```

---

## 5. 关键接口

| 方向 | 形式 |
|---|---|
| 插件 → 壳 | `DSH小窗.exe --url "<tokenized>" --title "DSH 小窗"` |
| 页面 → 壳 | `window.chrome.webview.postMessage({ type: 'shot' \| 'pin' \| 'close' \| 'ready' })` |
| 壳 → 页面 | `window.chrome.webview.addEventListener('message', e => ...)` |
| 截图流程 | 页面发 `shot` → 壳 `Hide()` → 调 `hud-shot.ps1`（已有，截全屏） → 壳 `Show()` → 回传 base64 → 页面 `insertIntoComposer()` |

HUD 标志用 **cookie `dsh_hud=1`**（由壳的 CookieManager 在导航前写入），不再依赖 query 参数——规避 token 重定向丢参数的坑。

---

## 6. 分步实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 最小验证：csc 编译一个能加载 DSH GUI 的 WebView2 窗口，确认 token URL 可进、可发消息 | 0.5h |
| P1 | 壳功能：无边框/拖动/缩放/置顶/贴边/单实例/位置记忆/托盘 | 2–3h |
| P2 | 视觉：DOM 探针拿稳定选择器 → 紧凑 CSS；自绘标题条；确认模型下拉可用 | 1–2h |
| P3 | 截图与文件：截图按钮（隐藏自己后截屏）+ 注入；验证 📄 文件按钮 | 1h |
| P4 | 集成：插件 `/open` 启动 exe、主窗按钮打通、WebView2 缺失时回退 Edge | 1h |
| P5 | 打磨：README、图标、快捷键、可选开机自启 | 1h |

合计约 **6–9 小时**，分 2–3 轮交付；每轮结束都能直接看到效果。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| WebView2 初始化失败 / 白屏 | 配置项 `backend: webview2 \| edge`，一键回退到现有 Edge 方案 |
| 无边框拖动与缩放（WM_NCHITTEST） | 标准做法，约 80 行；缩放可用右下角 grip 简化 |
| DSH 升级后 CSS 选择器失效 | 只做「收窄」不做「重排」，选择器多重兜底；失效时退化为原布局，功能不受影响 |
| token 出现在命令行 | 同机同用户才可见；可改为写临时文件或 CookieManager 直设 cookie |
| 打包分发 | 本机直接跑；给别人只需 4 个文件（exe + 3 dll），或把 dll 嵌进 exe 资源 |

---

## 8. 需要拍板

1. **窗口边框**：无边框自绘（最干净）还是保留系统标题栏（可直接拖动/最小化）？
2. **左侧会话列表**：完全隐藏，还是保留一个可展开的 ☰ 按钮（方便切会话）？
3. **跳回主窗**：小窗里要不要一个「↔ 回到主窗口此会话」的入口？

---

## 附：与现有 Edge 方案的关系

现有 `dsh-hud-window` 插件（Edge `--app` 版）保留不动，作为 `backend: edge` 兜底。新壳只是替换「窗口那一层」，页面侧的插件、截图脚本、粘贴注入逻辑全部复用。

---

## 9. 实施结果（已完成）

三个拍板项按用户口头答复落地：无边框自绘、只留必要的键、加「回主窗」。

* `app/bin/DSH小窗.exe`（约 43 KB）+ 3 个 WebView2 dll，`csc` 单文件产物，不打包 Electron。
* 标题条从左到右：`✕` 关闭 / `📌` 置顶 / `↔` 回主窗 / `📷` 截图。截图不再走 PowerShell，
  壳内隐藏自己 320ms → `CopyFromScreen` → base64 → 页面 Lexical 粘贴。
* 默认 460x560 逻辑像素（150% 缩放下 690x840 物理），贴当前显示器右上；`MinimumSize` 300x340。
* 可缩放：`Padding = 5px` 把窗口边缘留给窗体，绕开 WebView2 子 HWND 吞掉 `WM_NCHITTEST` 的坑；
  实测从左边缘拖入 180px：`690x840` → `510x840`。
* 页面紧凑化：窄屏时 DSH 自己会切 `dsh-mobile-app-header`（52→42px）与抽屉式侧栏；
  缩放改由 WebView2 原生 `web.ZoomFactor = 0.9` 负责（用 CSS `body{zoom}` 只缩「已用高度」，
  右/底会留空白带 —— 这是用户反馈后定位到的第二个根因）。
* 配色同步：导航完成后读页面 `body` 的背景色与文字色，`ApplyChrome(bg, fg)` 把窗体底色、
  标题条、图标色一起换掉（并按亮度切 `DWMWA_USE_IMMERSIVE_DARK_MODE`），
  解决「浅色页面套一圈黑框」（用户反馈的第一个问题）。
* 会话交接：宿主把 `session=<id>` 拼进地址，壳同时写 `dsh_hud` / `dsh_hud_session` 两个 cookie
  （因为 token 登录后 302 会丢掉整个 query），页面侧 `uiWorkspace.openSession(sessionId)` 落到该会话。
* 按钮链路实测：`POST /dsh-mini/open` → `backend:"native"` → 窗口起来并显示当前会话；
  再点一次只把已有窗口提到前面，不重复开窗。
* 诊断：`/dsh-mini/trace` 信标 + `%LOCALAPPDATA%\dsh-hud\trace.log`，配合 UI Automation 的 `Invoke`
  才定位到「主窗 `location.href` 是 `dsh-app:` 自定义协议，客户端给不出可用地址」这个根因
  —— 最终改成「客户端只给 sessionId，地址由宿主 `webApp.getAdvertisedUrl()` 拼」。


### 框选截图（第二轮叠加）

标题条现在是两个截图键：`📷` 截整屏、`⧉` 框选。框选这条链路的两个关键点：

* **命中测试不能靠 `WindowFromPoint`**：遮罩自己盖住整屏，`WindowFromPoint` 只会返回遮罩自己
  （第一版就是这么退化成「整个显示器」的）。正确做法是：先冻结桌面位图，再在遮罩显示**之前**
  用 `EnumWindows` 快照窗口 z 序列表（跳过自身、`WS_EX_TOOLWINDOW`、空标题、`DWMWA_CLOAKED`、
  任务栏/桌面），遮罩里按「第一个包含光标的矩形」取窗口 —— 等价于遮罩不存在时的
  `WindowFromPoint`。窗口矩形用 `DWMWA_EXTENDED_FRAME_BOUNDS`，去掉最大化窗口的隐形边框。
* **单位必须统一到物理像素**：`SystemInformation.VirtualScreen` 背后是 `GetSystemMetrics`，
  在 per-monitor v2 进程里按**线程**的 DPI 上下文作答，150% 缩放下返回逻辑尺寸
  （1707x1067 而不是 2560x1600）—— 遮罩于是只盖住左上角三分之二，光标坐标却是物理像素，
  选区就整体偏左偏上。改用 `EnumDisplayMonitors` + `GetMonitorInfo(rcMonitor)` 的并集
  （永远物理像素）拿虚拟屏，`SetWindowPos` 按物理坐标钉窗口，选区/候选/光标全程物理像素，
  绘制时再用 `PointToClient` 换算一次，所有缩放差异都自动抵消。

交互：鼠标移动即吸附高亮光标下的窗口（标签显示窗口标题 + 尺寸），单击截该窗口，拖拽自由框选，
`Esc` / 右键取消；遮罩外用 120 alpha 黑纱压暗，选区边缘 2px `rgb(59,130,246)` 蓝框。
`RegionCaptureForm` 在 `AppDomain` 与主窗同进程，冻结位图由调用方 `GrabDesktop` 提供并在
`Dispose` 时释放 —— 所以裁剪必须在 `using` 块内先 `Clone`。

### 后续可做（更新）

1. 小窗内的「附件/模型」等下拉在 460px 下略挤，可按需继续压缩 CSS（`app/hud-page.js`）。
2. ~~截图只有全屏~~ → 已加框选 + 窗口吸附（见上一节）；滚动长截图仍未做。
3. 若以后 `dsh` 放开了第二个 `BrowserWindow` 的创建，可以省掉这个 exe。

## 10. 第七轮叠加：常驻划词服务 / 设置页 / 全局快捷键

划词原本寄生在小窗进程里（`SelectionWatcher` 由 `HudForm` 持有），小窗一关就没了。第七轮把它拆成两类进程：

| 进程 | 入口 | 职责 |
| --- | --- | --- |
| 小窗 | \DSH小窗.exe --url …\ | WebView2 窗口、截图、引用落进 composer |
| 服务 | \DSH小窗.exe --service --url …\ | 90ms 鼠标状态机 + UIA 取选区 + 药丸 + 全局热键 + 托盘 |

两者用文件通信（都在 \%LOCALAPPDATA%\dsh-hud\）：`quote.txt`（划词正文）、`cmd.txt`（\ull\/\egion\）、`pending.txt`（要导航到的 URL）、`config.ini`（设置）。小窗每 700ms 轮询一次，服务每 2.5s 查一次 config 时间戳。

**选区读取顺序**：UIA `TextPattern.GetSelection()`（能同时拿到文字和选区矩形，无副作用）→ 失败才回退剪贴板（备份 IDataObject → 发 Ctrl+C → 等剪贴板序列号变化 → 还原）。终端窗口与桌面/资源管理器直接跳过，否则 Ctrl+C 会变成 SIGINT 或真的复制文件。

**药丸定位**：`x = sel.Right + 10`、`y = sel.Bottom + 8`（最后一行右下方，不遮住选中的字）；右边越界整体左移，下方越界翻到上方，最后 clamp 到 `GetMonitorInfo().rcWork`。

**热键**：\HotkeyHost : Form\（1x1 隐藏窗口，\ShowInTaskbar=false\）持有 `RegisterHotKey`；`WM_HOTKEY` 回调写 `cmd.txt` 再唤起小窗。默认 \Ctrl+Shift+1/2\，因为本机 \Ctrl+Alt+1/2\ 已被占用。

### 关于「拖到另一块屏不会重算」

这句话原本指的是**两件事**，现在都处理了：

1. **主题色**：小窗的标题条/边框颜色是从页面 `getComputedStyle(document.body)` 抄来的，早期只在 `NavigationCompleted` 后采样两次 —— 页面自己不重载、只是换了主题（或在 DSH 里切了明暗），边框就会停在旧颜色。现在多了 6 秒一次的复查（仅窗口可见时）。
2. **DPI 缩放**：标题条高度、图标宽度、最小尺寸都是「逻辑值 × scale」，而 `scale` 是启动时按主显示器算的常量（150% → 1.5）。把窗口拖到另一块 100% 的显示器上，窗口本身会被系统重排，但我们手绘的那些尺寸不会重算，看起来就会偏大/偏小。现在收到 `WM_DPICHANGED` 时用新的 DPI 重新算一遍 `scale` 并重建这些尺寸。