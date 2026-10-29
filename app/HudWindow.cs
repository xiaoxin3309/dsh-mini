using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DshHud
{
    internal static class Native
    {
        internal const int WM_DPICHANGED = 0x02E0;

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        internal static extern uint GetDpiForSystem();

        [DllImport("user32.dll")]
        internal static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        [DllImport("shcore.dll")]
        internal static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        internal static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECTW
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MONITORINFO
        {
            public int cbSize;
            public RECTW rcMonitor;
            public RECTW rcWork;
            public uint dwFlags;
        }

        internal const uint MONITOR_DEFAULTTOPRIMARY = 2;

        /// <summary>Primary monitor work area in physical pixels.</summary>
        internal static Rectangle WorkArea()
        {
            try
            {
                POINT pt;
                pt.X = 0;
                pt.Y = 0;
                IntPtr mon = MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY);
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(mon, ref mi))
                {
                    return Rectangle.FromLTRB(mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom);
                }
            }
            catch
            {
            }
            return Screen.PrimaryScreen.WorkingArea;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT
        {
            public int X;
            public int Y;
        }

        /// <summary>Effective DPI of the monitor that owns the given point (0,0 = primary).</summary>
        internal static float EffectiveScale()
        {
            try
            {
                POINT pt;
                pt.X = 0;
                pt.Y = 0;
                IntPtr mon = MonitorFromPoint(pt, 2 /*MONITOR_DEFAULTTOPRIMARY*/);
                uint dx, dy;
                if (GetDpiForMonitor(mon, 0 /*MDT_EFFECTIVE_DPI*/, out dx, out dy) == 0 && dx >= 96)
                {
                    return dx / 96f;
                }
            }
            catch
            {
            }

            uint dpi = GetDpiForSystem();
            if (dpi >= 96)
            {
                return dpi / 96f;
            }
            return 1f;
        }

        [DllImport("user32.dll")]
        internal static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        internal static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        internal static extern bool ShowWindow(IntPtr hWnd, int cmd);

        internal const int SW_RESTORE = 9;
        [DllImport("dwmapi.dll")]
        internal static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        internal const int WM_NCHITTEST = 0x0084;
        internal const int WM_NCLBUTTONDOWN = 0x00A1;
        internal const int HTCLIENT = 1;
        internal const int HTCAPTION = 2;
        internal const int HTLEFT = 10;
        internal const int HTRIGHT = 11;
        internal const int HTTOP = 12;
        internal const int HTTOPLEFT = 13;
        internal const int HTTOPRIGHT = 14;
        internal const int HTBOTTOM = 15;
        internal const int HTBOTTOMLEFT = 16;
        internal const int HTBOTTOMRIGHT = 17;

        internal const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        internal const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        internal const int DWMWCP_ROUND = 2;
    }

    internal sealed class HudForm : Form
    {
        private readonly string startUrl;
        private readonly string pendingPath;
        private readonly string statePath;
        private readonly Mutex mutex;

        private WebView2 web;
        private NotifyIcon tray;
        private System.Windows.Forms.Timer pendingTimer;
        private SelectionWatcher watcher;
        private ToolStripMenuItem askMenuItem;
        private string pendingQuote;
        private string pendingCmd;
        private HudConfig config;
        private long configStamp;
        private string askFlagPath;
        private Panel titleBar;
        private Label titleLabel;
        private Label pinButton;
        private readonly List<Label> iconButtons = new List<Label>();
        private readonly List<int> iconWidths = new List<int>();
        private Panel gapPanel;
        private System.Windows.Forms.Timer themeTimer;
        private Color chromeBg = Color.FromArgb(247, 247, 248);
        private Color chromeFg = Color.FromArgb(32, 32, 36);
        private bool pinned = true;
        private bool ready;
        private float scale = 1f;

        internal HudForm(string url, string title, Mutex mutex)
        {
            this.startUrl = url;
            this.mutex = mutex;

            string dir = HudConfig.Dir;
            pendingPath = Path.Combine(dir, "pending.txt");
            statePath = Path.Combine(dir, "window.txt");
            askFlagPath = Path.Combine(dir, "ask.txt");

            scale = Native.EffectiveScale();

            SuspendLayout();
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Text = title;
            TopMost = true;
            ShowInTaskbar = true;
            BackColor = Color.FromArgb(247, 247, 248);
            DoubleBuffered = true;
            KeyPreview = true;
            Padding = new Padding(Unit(5));
            MinimumSize = Logical(300, 340);
            Size = Logical(460, 560);
            RestoreSavedBounds();

            BuildTitleBar(title);
            BuildWebView();
            BuildTray();
            ResumeLayout(false);

            pendingTimer = new System.Windows.Forms.Timer();
            pendingTimer.Interval = 700;
            pendingTimer.Tick += OnPendingTick;
            pendingTimer.Start();

            // The page can repaint itself long after load (theme switch, session switch,
            // moving between monitors with different DPI). Keep the chrome in step.
            themeTimer = new System.Windows.Forms.Timer();
            themeTimer.Interval = 6000;
            themeTimer.Tick += delegate
            {
                if (!ready || !Visible) return;
                SyncChromeWithPageAsync(0);
            };
            themeTimer.Start();

            watcher = new SelectionWatcher(this);
            watcher.QuoteRequested += AskAboutSelection;
            watcher.Enabled = ReadAskFlag();

            config = HudConfig.Load();
            configStamp = HudConfig.Stamp();
            SelectionReader.ClipboardFallback = config.TextFallback;
        }

        private Size Logical(int w, int h)
        {
            return new Size((int)Math.Round(w * scale), (int)Math.Round(h * scale));
        }

        private int Unit(int v)
        {
            return (int)Math.Round(v * scale);
        }

        // ---------- chrome ----------

        private void BuildTitleBar(string title)
        {
            titleBar = new Panel();
            titleBar.Dock = DockStyle.Top;
            titleBar.Height = Unit(36);
            titleBar.BackColor = Blend(chromeBg, chromeFg, 0.04);
            Controls.Add(titleBar);

            titleLabel = new Label();
            titleLabel.AutoSize = false;
            titleLabel.Dock = DockStyle.Fill;
            titleLabel.TextAlign = ContentAlignment.MiddleLeft;
            titleLabel.Padding = new Padding(Unit(12), 0, 0, 0);
            titleLabel.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            titleLabel.ForeColor = chromeFg;
            titleLabel.Text = title;
            titleLabel.MouseDown += OnDragAreaMouseDown;
            titleLabel.MouseDoubleClick += OnTitleDoubleClick;
            titleBar.Controls.Add(titleLabel);

            Label pin = MakeIcon("\uE718", "\u7F6E\u9876", 44);
            pin.Click += delegate { TogglePin(); };
            pinButton = pin;

            Label back = MakeIcon("\uE72B", "\u4E3B", 40);
            back.Click += delegate { BackToMain(); };

            Label shot = MakeIcon("\uE722", "\u622A", 40);
            shot.Click += delegate { DoScreenshot(); };

            // Region / window picker. Segoe MDL2 "Crop" = E7A8.
            Label crop = MakeIcon("\uE7A8", "\u6846", 40);
            crop.Click += delegate { DoRegionCapture(); };

            // The close glyph is drawn noticeably larger than the others at the same
            // point size, so it gets its own smaller face and a hover highlight.
            Label close = MakeIcon("\uE8BB", "\u00D7", 40);
            close.Font = new Font("Segoe MDL2 Assets", 8.5f, FontStyle.Regular);
            close.ForeColor = IconTint();
            close.MouseEnter += delegate { close.BackColor = Color.FromArgb(232, 17, 35); close.ForeColor = Color.White; };
            close.MouseLeave += delegate { close.BackColor = Color.Transparent; close.ForeColor = IconTint(); };
            close.Click += delegate { HideToTray(); };

            // Small spacer so the last key does not sit on the window border. Right
            // docking stacks leftwards, so the spacer is added last to stay rightmost.
            Panel gap = new Panel();
            gap.Dock = DockStyle.Right;
            gap.Width = Unit(6);
            gapPanel = gap;

            titleBar.Controls.Add(close);
            titleBar.Controls.Add(pin);
            titleBar.Controls.Add(back);
            titleBar.Controls.Add(shot);
            titleBar.Controls.Add(crop);
            titleBar.Controls.Add(gap);

            titleBar.MouseDown += OnDragAreaMouseDown;
            titleBar.MouseDoubleClick += OnTitleDoubleClick;
        }

        private Label MakeIcon(string glyph, string fallback, int width)
        {
            Label b = new Label();
            b.Dock = DockStyle.Right;
            b.Width = Unit(width);
            iconWidths.Add(width);
            b.TextAlign = ContentAlignment.MiddleCenter;
            b.Font = new Font("Segoe MDL2 Assets", 10f, FontStyle.Regular);
            b.ForeColor = IconTint();
            b.Cursor = Cursors.Hand;
            b.Text = glyph;
            b.MouseEnter += delegate { b.BackColor = HoverTint(); };
            b.MouseLeave += delegate { b.BackColor = Color.Transparent; };
            b.Tag = fallback;
            iconButtons.Add(b);
            return b;
        }

        /// <summary>
        /// The window frame and title bar follow the page's own colours. Before the
        /// page has reported in, a neutral light grey stands in for it.
        /// </summary>
        private Color Blend(Color a, Color b, double amount)
        {
            int r = (int)Math.Round(a.R + (b.R - a.R) * amount);
            int g = (int)Math.Round(a.G + (b.G - a.G) * amount);
            int bl = (int)Math.Round(a.B + (b.B - a.B) * amount);
            return Color.FromArgb(r, g, bl);
        }

        private Color IconTint()
        {
            return Blend(chromeFg, chromeBg, 0.25);
        }

        private Color HoverTint()
        {
            return Blend(chromeBg, chromeFg, 0.12);
        }

        private void OnDragAreaMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
        }

        private void OnTitleDoubleClick(object sender, MouseEventArgs e)
        {
            Size = (WindowState == FormWindowState.Maximized) ? Logical(460, 920) : Screen.FromControl(this).WorkingArea.Size;
        }

        private void TogglePin()
        {
            pinned = !pinned;
            TopMost = pinned;
            pinButton.ForeColor = pinned ? Color.FromArgb(110, 190, 255) : Color.FromArgb(140, 140, 148);
        }

        private void BuildWebView()
        {
            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.FromArgb(24, 24, 27);
            web.AllowExternalDrop = false;
            Controls.Add(web);
            web.BringToFront();
        }

        private void BuildTray()
        {
            tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = "DSH \u5C0F\u7A97";
            tray.Visible = true;
            tray.DoubleClick += delegate { RestoreFromTray(); };

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("\u663E\u793A\u5C0F\u7A97", null, delegate { RestoreFromTray(); });

            askMenuItem = new ToolStripMenuItem("\u5212\u8BCD\u95EE\u5927\u80A5\u9C7C");
            askMenuItem.CheckOnClick = true;
            askMenuItem.Checked = true;
            askMenuItem.CheckedChanged += delegate
            {
                if (watcher == null) return;
                watcher.Enabled = askMenuItem.Checked;
                WriteAskFlag(askMenuItem.Checked);
            };
            menu.Items.Add(askMenuItem);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("\u9000\u51FA", null, delegate { Close(); });
            tray.ContextMenuStrip = menu;
        }

        private void RestoreFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        /// <summary>
        /// The close key parks the window in the tray instead of exiting: the selection
        /// watcher lives in this process, so the "问大肥鱼" pill would die with it.
        /// </summary>
        private void HideToTray()
        {
            Hide();
            if (tray != null && !tray.Visible) tray.Visible = true;
        }

        private bool ReadAskFlag()
        {
            try
            {
                if (!File.Exists(askFlagPath)) return true;
                return File.ReadAllText(askFlagPath).Trim() != "0";
            }
            catch
            {
                return true;
            }
        }

        private void WriteAskFlag(bool on)
        {
            try
            {
                File.WriteAllText(askFlagPath, on ? "1" : "0", Encoding.UTF8);
            }
            catch
            {
            }
        }

        // ---------- lifecycle ----------

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = Native.DWMWCP_ROUND;
                Native.DwmSetWindowAttribute(Handle, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
                int dark = 1;
                Native.DwmSetWindowAttribute(Handle, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
            }
            catch
            {
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            InitWebViewAsync();
        }

        private async void InitWebViewAsync()
        {
            try
            {
                Log("wv2: begin");
                string[] udfs = new string[]
                {
                    Path.Combine(HudConfig.Dir, "webview2"),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-hud", "webview2"),
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webview2"),
                    Path.Combine(Path.GetTempPath(), "dsh-mini-webview2")
                };
                // The sandboxed spawn used by the plugin can deny writes to %LOCALAPPDATA%,
                // so pick the first folder we can actually write into before handing it to
                // WebView2 - a denied user data folder fails with E_ACCESSDENIED.
                string chosenUdf = null;
                foreach (string cand in udfs)
                {
                    try
                    {
                        Directory.CreateDirectory(cand);
                        string probe = Path.Combine(cand, ".write-probe");
                        File.WriteAllText(probe, "ok");
                        File.Delete(probe);
                        chosenUdf = cand;
                        Log("wv2: udf writable=" + cand);
                        break;
                    }
                    catch (Exception exProbe)
                    {
                        Log("wv2: udf not writable " + cand + " -> " + exProbe.GetType().Name + " 0x" + exProbe.HResult.ToString("X8"));
                    }
                }
                if (chosenUdf == null)
                {
                    throw new InvalidOperationException("no writable user data folder");
                }
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, chosenUdf, null);
                Log("wv2: env ok " + env.BrowserVersionString);
                await web.EnsureCoreWebView2Async(env);
                Log("wv2: ensured");

                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                web.CoreWebView2.Settings.IsZoomControlEnabled = false;
                web.CoreWebView2.WebMessageReceived += OnWebMessage;
                web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

                // A real browser zoom: the layout viewport becomes 460/0.9 CSS px, so
                // the document still fills the window edge to edge. CSS `zoom` on the
                // body only shrank the used height, which left blank bands.
                web.ZoomFactor = 0.9;

                try
                {
                    SyncHintCookies(startUrl);
                }
                catch
                {
                }

                web.CoreWebView2.Navigate(startUrl);
                ready = true;
                Log("wv2: ready");
            }
            catch (Exception ex)
            {
                Log("wv2: FAIL " + ex.GetType().Name + " 0x" + ex.HResult.ToString("X8") + " :: " + ex.Message);
                MessageBox.Show("WebView2 \u521D\u59CB\u5316\u5931\u8D25\uFF1A" + ex.Message,
                    "DSH \u5C0F\u7A97", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnPendingTick(object sender, EventArgs e)
        {
            try
            {
                if (File.Exists(pendingPath))
                {
                    string url = File.ReadAllText(pendingPath, Encoding.UTF8).Trim();
                    File.Delete(pendingPath);
                    if (url.Length > 0 && ready)
                    {
                        SyncHintCookies(url);
                        web.CoreWebView2.Navigate(url);
                        RestoreFromTray();
                    }
                }
            }
            catch
            {
            }
            PumpEval();
            PumpRequests();

            try
            {
                string pillPath = Path.Combine(Path.GetDirectoryName(pendingPath), "showpill.txt");
                if (File.Exists(pillPath))
                {
                    File.Delete(pillPath);
                    if (watcher != null) watcher.DebugPill();
                }

                string regionPath = Path.Combine(Path.GetDirectoryName(pendingPath), "regionshot.txt");
                if (File.Exists(regionPath))
                {
                    File.Delete(regionPath);
                    DoRegionCapture();
                }

                string testPath = Path.Combine(Path.GetDirectoryName(pendingPath), "seltest.txt");
                if (File.Exists(testPath))
                {
                    File.Delete(testPath);
                    if (watcher != null) watcher.TestProbe();
                }
            }
            catch
            {
            }
        }

        /// <summary>
        /// Work handed over by the background service: a quote to insert, or a screenshot
        /// command from a global hotkey. Both arrive as files so the two processes never
        /// need to agree on IPC.
        /// </summary>
        private void PumpRequests()
        {
            try
            {
                long stamp = HudConfig.Stamp();
                if (stamp != configStamp)
                {
                    configStamp = stamp;
                    config = HudConfig.Load();
                    SelectionReader.ClipboardFallback = config.TextFallback;
                    Log("config reloaded copyShot=" + config.CopyShot +
                        " textFallback=" + (config.TextFallback ? "1" : "0"));
                }

                string quote = HudConfig.QuotePath;
                if (File.Exists(quote))
                {
                    string text = File.ReadAllText(quote, Encoding.UTF8);
                    File.Delete(quote);
                    if (!string.IsNullOrEmpty(text))
                    {
                        Log("quote from service " + text.Length + " chars");
                        pendingQuote = text;
                        RestoreFromTray();
                        if (ready && web != null && web.CoreWebView2 != null) FlushPendingQuote();
                    }
                }

                string cmd = HudConfig.CmdPath;
                if (File.Exists(cmd))
                {
                    string kind = File.ReadAllText(cmd, Encoding.UTF8).Trim();
                    File.Delete(cmd);
                    if (kind.Length > 0)
                    {
                        Log("cmd from service: " + kind);
                        if (!ready) pendingCmd = kind;
                        else RunCmd(kind);
                    }
                }
                else if (pendingCmd != null && ready)
                {
                    string kind = pendingCmd;
                    pendingCmd = null;
                    RunCmd(kind);
                }
            }
            catch
            {
            }
        }

        private void RunCmd(string kind)
        {
            if (kind == "region") DoRegionCapture();
            else DoScreenshot();
        }

        /// <summary>
        /// The GUI authenticates a fresh profile by redirecting to a cleaned URL, which
        /// drops our query flags. Cookies survive that redirect, so the hand-off values
        /// live there where the page can still read them.
        /// </summary>
        private void SyncHintCookies(string url)
        {
            CoreWebView2Cookie hud = web.CoreWebView2.CookieManager.CreateCookie("dsh_hud", "1", "127.0.0.1", "/");
            hud.Expires = DateTime.Now.AddHours(12);
            web.CoreWebView2.CookieManager.AddOrUpdateCookie(hud);

            string session = QueryValue(url, "session");
            CoreWebView2Cookie handoff = web.CoreWebView2.CookieManager.CreateCookie(
                "dsh_hud_session", session, "127.0.0.1", "/");
            handoff.Expires = session.Length == 0 ? DateTime.Now.AddSeconds(-1) : DateTime.Now.AddHours(12);
            web.CoreWebView2.CookieManager.AddOrUpdateCookie(handoff);
        }

        private static string QueryValue(string url, string key)
        {
            int question = url.IndexOf('?');
            if (question < 0) return "";
            string query = url.Substring(question + 1);
            int hash = query.IndexOf('#');
            if (hash >= 0) query = query.Substring(0, hash);
            string[] parts = query.Split('&');
            for (int i = 0; i < parts.Length; i++)
            {
                int equals = parts[i].IndexOf('=');
                if (equals <= 0) continue;
                if (parts[i].Substring(0, equals) == key)
                {
                    return Uri.UnescapeDataString(parts[i].Substring(equals + 1));
                }
            }
            return "";
        }

        /// <summary>Dev loop: drop JS into %LOCALAPPDATA%\dsh-hud\eval.js, result lands in hud.log.</summary>
        private void PumpEval()
        {
            try
            {
                if (!ready) return;
                string dir = Path.GetDirectoryName(pendingPath);
                string evalPath = Path.Combine(dir, "eval.js");
                if (!File.Exists(evalPath)) return;
                string script = File.ReadAllText(evalPath, Encoding.UTF8);
                File.Delete(evalPath);
                RunEval(script);
            }
            catch
            {
            }
        }

        private async void RunEval(string script)
        {
            string dir = Path.GetDirectoryName(pendingPath);
            string logPath = Path.Combine(dir, "hud.log");
            try
            {
                string result = await web.CoreWebView2.ExecuteScriptAsync(script);
                File.WriteAllText(logPath, result, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(logPath, "eval failed: " + ex.Message, Encoding.UTF8); }
                catch { }
            }
        }

        // ---------- page bridge ----------

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess) return;
            try
            {
                web.CoreWebView2.ExecuteScriptAsync(HudPage.Script);
            }
            catch
            {
            }
            // The app paints itself a moment after load, so sample the theme twice.
            SyncChromeWithPageAsync(400);
            SyncChromeWithPageAsync(1800);
            if (Environment.GetEnvironmentVariable("DSH_HUD_DEBUG") == "1")
            {
                RunProbe();
            }
            if (pendingQuote != null && web != null && web.CoreWebView2 != null)
            {
                QuoteAsync(pendingQuote);
                pendingQuote = null;
            }
        }

        /// <summary>
        /// Paint the frame and title bar in the page's own colours, so a light document
        /// does not sit inside a black border. The page reports the two computed values
        /// (`background-color|color`) and the shell recolours its chrome from them.
        /// </summary>
        private async void SyncChromeWithPageAsync(int delay)
        {
            if (delay > 0)
            {
                try { await System.Threading.Tasks.Task.Delay(delay); }
                catch { return; }
            }
            try
            {
                if (!ready || web.CoreWebView2 == null) return;
                string raw = await web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){var s=getComputedStyle(document.body);" +
                    "return s.backgroundColor+'|'+s.color;})()");
                string text = Unquote(raw);
                string[] parts = text.Split('|');
                if (parts.Length < 2) return;
                Color bg = ParseCssColor(parts[0], Color.Empty);
                Color fg = ParseCssColor(parts[1], Color.Empty);
                if (bg.IsEmpty || bg.A == 0) return;
                if (fg.IsEmpty) fg = Luminance(bg) > 0.55 ? Color.FromArgb(32, 32, 36) : Color.FromArgb(235, 235, 240);
                ApplyChrome(bg, fg);
            }
            catch
            {
            }
        }

        private void ApplyChrome(Color bg, Color fg)
        {
            chromeBg = bg;
            chromeFg = fg;
            try
            {
                BackColor = bg;
                if (titleBar != null) titleBar.BackColor = Blend(bg, fg, 0.04);
                if (titleLabel != null) titleLabel.ForeColor = fg;
                for (int i = 0; i < iconButtons.Count; i++) iconButtons[i].ForeColor = IconTint();
                if (pinButton != null) pinButton.ForeColor = IconTint();

                int dark = Luminance(bg) < 0.45 ? 1 : 0;
                if (IsHandleCreated)
                {
                    Native.DwmSetWindowAttribute(Handle, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
                }
            }
            catch
            {
            }
        }

        private static double Luminance(Color c)
        {
            return (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;
        }

        /// <summary>ExecuteScriptAsync answers with a JSON literal; unwrap it.</summary>
        private static string Unquote(string raw)
        {
            if (raw == null) return "";
            string text = raw.Trim();
            if (text.Length >= 2 && text[0] == '"' && text[text.Length - 1] == '"')
            {
                text = text.Substring(1, text.Length - 2);
            }
            return text.Replace("\\\"", "\"").Replace("\\u0026", "&").Replace("\\/", "/");
        }

        private static Color ParseCssColor(string value, Color fallback)
        {
            if (value == null) return fallback;
            string text = value.Trim();
            if (text.Length == 0) return fallback;
            int open = text.IndexOf('(');
            if (open < 0 || text.IndexOf("rgb", StringComparison.OrdinalIgnoreCase) != 0) return fallback;
            int close = text.IndexOf(')', open);
            if (close < 0) return fallback;
            string[] parts = text.Substring(open + 1, close - open - 1).Split(',');
            if (parts.Length < 3) return fallback;
            int r, g, b;
            if (!int.TryParse(parts[0].Trim(), out r)) return fallback;
            if (!int.TryParse(parts[1].Trim(), out g)) return fallback;
            if (!int.TryParse(parts[2].Trim(), out b)) return fallback;
            int a = 255;
            if (parts.Length >= 4)
            {
                double alpha;
                if (double.TryParse(parts[3].Trim(), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out alpha))
                {
                    a = (int)Math.Round(alpha * 255);
                }
            }
            return Color.FromArgb(a, Math.Min(255, r), Math.Min(255, g), Math.Min(255, b));
        }

        private async void RunProbe()
        {
            string logPath = Path.Combine(Path.GetDirectoryName(pendingPath), "hud.log");
            try
            {
                await System.Threading.Tasks.Task.Delay(3000);
                string raw = await web.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify(window.__dshHud ? window.__dshHud.probe() : {err:'bridge missing'})");
                File.WriteAllText(logPath, raw, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(logPath, "probe failed: " + ex.Message, Encoding.UTF8);
                }
                catch
                {
                }
            }
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string text;
            try
            {
                text = e.TryGetWebMessageAsString();
            }
            catch
            {
                return;
            }
            if (text == null) return;

            if (text.IndexOf("\"shot\"", StringComparison.Ordinal) >= 0) { DoScreenshot(); return; }
            if (text.IndexOf("\"shot-region\"", StringComparison.Ordinal) >= 0) { DoRegionCapture(); return; }
            if (text.IndexOf("\"pin\"", StringComparison.Ordinal) >= 0) { TogglePin(); return; }
            if (text.IndexOf("\"close\"", StringComparison.Ordinal) >= 0) { Close(); return; }
            if (text.IndexOf("\"hide\"", StringComparison.Ordinal) >= 0) { Hide(); return; }
        }

        private void BackToMain()
        {
            try
            {
                Process self = Process.GetCurrentProcess();
                foreach (Process p in Process.GetProcessesByName("DeepSeek Harness"))
                {
                    if (p.Id == self.Id) continue;
                    IntPtr h = p.MainWindowHandle;
                    if (h == IntPtr.Zero) continue;
                    Native.ShowWindow(h, Native.SW_RESTORE);
                    Native.SetForegroundWindow(h);
                    break;
                }
            }
            catch
            {
            }
            Hide();
        }
        private void SendToPage(string json)
        {
            if (!ready) return;
            try
            {
                web.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch
            {
            }
        }

        // ---------- 划词问大肥鱼 ----------

        /// <summary>
        /// Called when the user clicks the pill next to a selection. Brings the window up
        /// and quotes the captured text into the composer.
        /// </summary>
        private void AskAboutSelection(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            pendingQuote = text;
            RestoreFromTray();
            if (ready && web != null && web.CoreWebView2 != null) FlushPendingQuote();
        }

        private void FlushPendingQuote()
        {
            if (pendingQuote == null) return;
            string text = pendingQuote;
            pendingQuote = null;
            QuoteAsync(text);
        }

        private async void QuoteAsync(string text)
        {
            try
            {
                string script = "(function(){try{return window.__dshHud && window.__dshHud.quote("
                    + "\"" + Escape(text) + "\") ? 'ok' : 'fail';}catch(e){return 'err:' + e.message;}})()";
                string result = await web.CoreWebView2.ExecuteScriptAsync(script);
                Log("quote " + text.Length + " chars -> " + result);
            }
            catch (Exception ex)
            {
                Log("quote failed: " + ex.Message);
            }
        }

        private void Log(string line)
        {
            string text = DateTime.Now.ToString("HH:mm:ss") + " " + line + "\r\n";
            try
            {
                string logPath = Path.Combine(Path.GetDirectoryName(pendingPath), "hud.log");
                File.AppendAllText(logPath, text, Encoding.UTF8);
            }
            catch
            {
            }
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "dsh-mini-hud.log"), text, Encoding.UTF8);
            }
            catch
            {
            }
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "hud-bin.log"), text, Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static string Escape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private void CopyToClipboard(Image img)
        {
            try
            {
                Clipboard.SetImage(img);
                Log("copied to clipboard " + img.Width + "x" + img.Height);
            }
            catch (Exception ex)
            {
                Log("clipboard failed: " + ex.Message);
            }
        }

        private void DoScreenshot()
        {
            if (!ready) return;
            Hide();
            Application.DoEvents();
            Thread.Sleep(320);
            try
            {
                Rectangle vs = RegionCaptureForm.PhysicalVirtualScreen();
                using (Bitmap bmp = new Bitmap(vs.Width, vs.Height))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(vs.X, vs.Y, 0, 0, new Size(vs.Width, vs.Height), CopyPixelOperation.SourceCopy);
                    }
                    byte[] bytes;
                    using (MemoryStream ms = new MemoryStream())
                    {
                        bmp.Save(ms, ImageFormat.Png);
                        bytes = ms.ToArray();
                    }
                    string b64 = Convert.ToBase64String(bytes);
                    if (config != null && config.CopyShot) CopyToClipboard(bmp);
                    SendToPage("{\"type\":\"shot-result\",\"dataUrl\":\"data:image/png;base64," + b64 +
                               "\",\"width\":" + vs.Width + ",\"height\":" + vs.Height + "}");
                }
            }
            catch (Exception ex)
            {
                SendToPage("{\"type\":\"shot-error\",\"error\":\"" + Escape(ex.Message) + "\"}");
            }
            finally
            {
                Show();
                Activate();
            }
        }

        /// <summary>
        /// Freeze the desktop, let the user pick a window (click) or a rectangle (drag),
        /// then crop that out of the frozen frame. Cropping the frozen bitmap instead of
        /// re-capturing means the overlay can never end up in its own picture.
        /// </summary>
        private void DoRegionCapture()
        {
            if (!ready) return;

            Rectangle vs = RegionCaptureForm.PhysicalVirtualScreen();
            Bitmap frozen = null;
            Bitmap crop = null;
            try
            {
                Hide();
                Application.DoEvents();
                Thread.Sleep(240);

                List<CaptureTarget> targets = RegionCaptureForm.CollectTargets();
                frozen = RegionCaptureForm.GrabDesktop(vs);
                bool picked = false;
                Rectangle local = Rectangle.Empty;
                using (RegionCaptureForm picker = new RegionCaptureForm(frozen, vs, targets))
                {
                    if (picker.ShowDialog() == DialogResult.OK)
                    {
                        Rectangle r = picker.SelectedRect;
                        local = new Rectangle(r.X - vs.X, r.Y - vs.Y, r.Width, r.Height);
                        picked = local.Width > 1 && local.Height > 1;
                        if (picked)
                        {
                            // Clone before the picker disposes the frozen backdrop.
                            crop = frozen.Clone(local, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                        }
                    }
                    frozen = null; // owned and disposed by the picker
                }

                Log("region pick " + (picked ? (local.Width + "x" + local.Height) : "none") +
                    " at " + local.X + "," + local.Y);
                if (!picked || crop == null) return;

                byte[] bytes;
                using (MemoryStream ms = new MemoryStream())
                {
                    crop.Save(ms, ImageFormat.Png);
                    bytes = ms.ToArray();
                }
                string b64 = Convert.ToBase64String(bytes);
                if (config != null && config.CopyShot) CopyToClipboard(crop);
                SendToPage("{\"type\":\"shot-result\",\"dataUrl\":\"data:image/png;base64," + b64 +
                           "\",\"width\":" + crop.Width + ",\"height\":" + crop.Height + "}");
            }
            catch (Exception ex)
            {
                SendToPage("{\"type\":\"shot-error\",\"error\":\"" + Escape(ex.Message) + "\"}");
            }
            finally
            {
                if (crop != null) crop.Dispose();
                Show();
                Activate();
            }
        }

        // ---------- window plumbing ----------

        /// <summary>
        /// Re-derive every hard-coded pixel size from a new DPI factor. Called when the
        /// window is dragged to a monitor with a different scale (WM_DPICHANGED), which
        /// is why the sizes are kept in logical units in the first place.
        /// </summary>
        private void ApplyScale(float next)
        {
            if (next <= 0f) return;
            Size logical = new Size(
                (int)Math.Round(Width / (double)scale),
                (int)Math.Round(Height / (double)scale));
            scale = next;
            Padding = new Padding(Unit(5));
            MinimumSize = Logical(300, 340);
            if (titleBar != null) titleBar.Height = Unit(36);
            if (titleLabel != null) titleLabel.Padding = new Padding(Unit(12), 0, 0, 0);
            if (gapPanel != null) gapPanel.Width = Unit(6);
            for (int i = 0; i < iconButtons.Count && i < iconWidths.Count; i++)
            {
                iconButtons[i].Width = Unit(iconWidths[i]);
            }
            Size = Logical(logical.Width, logical.Height);
            Log("dpi scale " + next.ToString("0.##"));
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_DPICHANGED)
            {
                int dpi = (int)(m.WParam.ToInt64() & 0xFFFF);
                if (dpi > 0)
                {
                    float next = dpi / 96f;
                    if (Math.Abs(next - scale) > 0.01f) ApplyScale(next);
                }
                SyncChromeWithPageAsync(0);
            }

            if (m.Msg == Native.WM_NCHITTEST)
            {
                int edge = Unit(7);
                int screenX = (short)(m.LParam.ToInt64() & 0xFFFF);
                int screenY = (short)((m.LParam.ToInt64() >> 16) & 0xFFFF);
                Point p = PointToClient(new Point(screenX, screenY));
                bool left = p.X <= edge;
                bool right = p.X >= ClientSize.Width - edge;
                bool top = p.Y <= edge;
                bool bottom = p.Y >= ClientSize.Height - edge;
                if (left && top) { m.Result = (IntPtr)Native.HTTOPLEFT; return; }
                if (right && top) { m.Result = (IntPtr)Native.HTTOPRIGHT; return; }
                if (left && bottom) { m.Result = (IntPtr)Native.HTBOTTOMLEFT; return; }
                if (right && bottom) { m.Result = (IntPtr)Native.HTBOTTOMRIGHT; return; }
                if (left) { m.Result = (IntPtr)Native.HTLEFT; return; }
                if (right) { m.Result = (IntPtr)Native.HTRIGHT; return; }
                if (top) { m.Result = (IntPtr)Native.HTTOP; return; }
                if (bottom) { m.Result = (IntPtr)Native.HTBOTTOM; return; }
            }
            base.WndProc(ref m);
        }

        private void RestoreSavedBounds()
        {
            Rectangle wa = Native.WorkArea();
            int x = wa.Right - Width - Unit(16);
            int y = wa.Top + Unit(16);
            if (File.Exists(statePath))
            {
                try
                {
                    string[] parts = File.ReadAllText(statePath).Split(',');
                    if (parts.Length == 4)
                    {
                        int sx, sy, sw, sh;
                        if (int.TryParse(parts[0], out sx) && int.TryParse(parts[1], out sy) &&
                            int.TryParse(parts[2], out sw) && int.TryParse(parts[3], out sh) && sw > 200 && sh > 200)
                        {
                            Rectangle saved = new Rectangle(sx, sy, sw, sh);
                            bool visible = false;
                            foreach (Screen s in Screen.AllScreens)
                            {
                                if (Rectangle.Intersect(s.WorkingArea, saved).Width > 80) { visible = true; break; }
                            }
                            if (visible) { Location = new Point(sx, sy); Size = new Size(sw, sh); return; }
                        }
                    }
                }
                catch
                {
                }
            }
            Location = new Point(x, y);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            try
            {
                Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(statePath, r.X + "," + r.Y + "," + r.Width + "," + r.Height);
            }
            catch
            {
            }
            if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
            if (watcher != null) { watcher.Dispose(); watcher = null; }
            if (pendingTimer != null) { pendingTimer.Stop(); pendingTimer.Dispose(); pendingTimer = null; }
            if (mutex != null)
            {
                try { mutex.ReleaseMutex(); } catch { }
                mutex.Dispose();
            }
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape) { Hide(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }

    internal static class Program
    {
        private static void Diag(string tag)
        {
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "hud-bin.log");
            StringBuilder sb = new StringBuilder();
            try
            {
                sb.Append(DateTime.Now.ToString("HH:mm:ss")).Append(" DIAG ").Append(tag);
                System.Security.Principal.WindowsIdentity wi = System.Security.Principal.WindowsIdentity.GetCurrent();
                sb.Append(" user=").Append(wi.Name).Append(" groups=").Append(wi.Groups.Count);
                foreach (System.Security.Principal.IdentityReference g in wi.Groups)
                {
                    string v = g.Value;
                    if (v.StartsWith("S-1-16-") || v.Contains("Codex") || v.StartsWith("S-1-5-21") == false) continue;
                }
                sb.Append(" il=");
                try { sb.Append(wi.Owner.Value); } catch { }
                string probe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-hud", "diag-" + System.Guid.NewGuid().ToString("N") + ".txt");
                try
                {
                    File.WriteAllText(probe, "x");
                    sb.Append(" appdata=OK");
                    try { File.Delete(probe); } catch { }
                }
                catch (Exception exw)
                {
                    sb.Append(" appdata=FAIL ").Append(exw.GetType().Name).Append(" 0x").Append(exw.HResult.ToString("X8")).Append(" :: ").Append(exw.Message);
                }
                string tprobe = Path.Combine(Path.GetTempPath(), "dsh-mini-diag.txt");
                try
                {
                    File.AppendAllText(tprobe, DateTime.Now + " " + tag + "\r\n");
                    sb.Append(" temp=OK");
                }
                catch (Exception exw2)
                {
                    sb.Append(" temp=FAIL 0x").Append(exw2.HResult.ToString("X8"));
                }
                sb.Append(" tempdir=").Append(Path.GetTempPath());
            }
            catch (Exception ex)
            {
                sb.Append(" DIAG-ERR ").Append(ex.Message);
            }
            try { File.AppendAllText(path, sb.ToString() + "\r\n", Encoding.UTF8); } catch { }
        }

        [STAThread]
        private static void Main(string[] argv)
        {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch { }
            Diag("start");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string url = null;
            string title = "DSH \u5C0F\u7A97";
            bool service = false;
            bool probe = false;
            long probeHwnd = 0;
            for (int i = 0; i < argv.Length; i++)
            {
                if (argv[i] == "--url" && i + 1 < argv.Length) url = argv[i + 1];
                else if (argv[i] == "--title" && i + 1 < argv.Length) title = argv[i + 1];
                else if (argv[i] == "--service") service = true;
                else if (argv[i] == "--probe") probe = true;
                else if (argv[i] == "--hwnd" && i + 1 < argv.Length)
                {
                    long parsed;
                    if (long.TryParse(argv[i + 1], out parsed)) probeHwnd = parsed;
                }
                else if (argv[i] == "--debug")
                {
                    // expose the WebView2 page over CDP so we can inspect/patch the DOM from outside
                    Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                        "--remote-debugging-port=9333");
                    Environment.SetEnvironmentVariable("DSH_HUD_DEBUG", "1");
                }
            }

            if (probe)
            {
                // Headless self-test: read the selection once and report it, no window at all.
                SelectionHit hit = SelectionReader.ReadHit(new IntPtr(probeHwnd));
                string head = hit.Text ?? "";
                if (head.Length > 60) head = head.Substring(0, 60);
                SelectionWatcher.Log("probe " + (hit.Text == null ? 0 : hit.Text.Length) + " chars" +
                                     (hit.HasRect ? " rect=" + hit.Rect.ToString() : " rect=none") +
                                     " head=" + head.Replace("\n", " ").Replace("\r", " "));
                return;
            }
            // Launched through Explorer (no argv): the plugin asks for the background helper
            // by dropping this flag file, because a shortcut would raise a security prompt.
            if (!service)
            {
                try
                {
                    string svcFlag = Path.Combine(HudConfig.Dir, "service.flag");
                    if (File.Exists(svcFlag))
                    {
                        File.Delete(svcFlag);
                        service = true;
                    }
                }
                catch { }
            }
            if (service)
            {
                // One background helper: it owns the selection pill and the global hotkeys,
                // so "问大肥鱼" works whether or not this window has ever been opened.
                bool serviceCreated;
                Mutex serviceMutex = new Mutex(true, "Local\\DshHudService", out serviceCreated);
                if (!serviceCreated)
                {
                    serviceMutex.Dispose();
                    return;
                }
                Application.Run(new SelectionService(url));
                return;
            }

            if (string.IsNullOrEmpty(url))
            {
                // Launched without arguments (for example from a shortcut so the process gets
                // a normal token): the plugin drops the address it wants into request.txt.
                try
                {
                    string reqPath = Path.Combine(HudConfig.Dir, "request.txt");
                    if (File.Exists(reqPath))
                    {
                        foreach (string line in File.ReadAllLines(reqPath, Encoding.UTF8))
                        {
                            string cand = line.Trim();
                            if (cand.StartsWith("http://") || cand.StartsWith("https://")) { url = cand; break; }
                        }
                    }
                }
                catch { }
            }
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("\u7F3A\u5C11 --url \u53C2\u6570\u3002", "DSH \u5C0F\u7A97",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // Fail fast with an actionable message when this machine has no WebView2
            // Runtime: the window cannot render anything without it, and an async throw
            // inside WebView init would otherwise surface as a bare error or a dead window.
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (Exception)
            {
                MessageBox.Show(
                    "\u5C0F\u7A97\u9700\u8981 Microsoft Edge WebView2 Runtime\uFF0C\u672C\u673A\u6CA1\u6709\u627E\u5230\u3002\r\n\r\n" +
                    "\u4E0B\u8F7D\u5730\u5740\uFF08\u5B98\u65B9\uFF0CEvergreen \u5B89\u88C5\u5305\uFF09\uFF1A\r\n" +
                    "https://go.microsoft.com/fwlink/p/?LinkId=2124703\r\n\r\n" +
                    "Windows 11 \u901A\u5E38\u81EA\u5E26\uFF1BWindows 10 \u5982\u679C\u6CA1\u6709\uFF0C\u88C5\u5B8C\u91CD\u5F00\u5C0F\u7A97\u5373\u53EF\u3002",
                    "DSH \u5C0F\u7A97", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string dir = HudConfig.Dir;
            string pending = Path.Combine(dir, "pending.txt");

            bool created;
            Mutex mutex = new Mutex(true, "Local\\DshHudWindow", out created);
            if (!created)
            {
                try { File.WriteAllText(pending, url, Encoding.UTF8); }
                catch { }
                return;
            }

            Application.Run(new HudForm(url, title, mutex));
        }
    }
}
