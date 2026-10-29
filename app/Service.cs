using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshHud
{
    /// <summary>
    /// Flat ini-style settings shared by the window shell, the background service and the
    /// host plugin. Deliberately not JSON: powershell 5.1, C# 5 and node all have to agree
    /// on it without pulling in a parser.
    /// </summary>
    internal sealed class HudConfig
    {
        internal bool CopyShot;
        internal bool Ask;
        internal string HotkeyFull;
        internal string HotkeyRegion;
        internal bool TextFallback;

        internal HudConfig()
        {
            CopyShot = true;
            Ask = true;
            HotkeyFull = "Ctrl+Shift+1";
            HotkeyRegion = "Ctrl+Shift+2";
            TextFallback = true;
        }

        internal static string Dir
        {
            get
            {
                // Keep every file next to the executable: a process launched by the plugin
                // can run under a restricted token that is denied writes to %LOCALAPPDATA%,
                // which broke the WebView2 profile and the window <-> service IPC files.
                string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
                try
                {
                    Directory.CreateDirectory(dir);
                }
                catch
                {
                    dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-hud");
                    Directory.CreateDirectory(dir);
                }
                try
                {
                    string legacy = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-hud");
                    string oldCfg = Path.Combine(legacy, "config.ini");
                    string newCfg = Path.Combine(dir, "config.ini");
                    if (File.Exists(oldCfg) && !File.Exists(newCfg)) File.Copy(oldCfg, newCfg, false);
                }
                catch { }
                return dir;
            }
        }

        internal static string ConfigPath { get { return Path.Combine(Dir, "config.ini"); } }
        internal static string QuotePath { get { return Path.Combine(Dir, "quote.txt"); } }
        internal static string CmdPath { get { return Path.Combine(Dir, "cmd.txt"); } }

        internal static HudConfig Load()
        {
            HudConfig cfg = new HudConfig();
            try
            {
                if (!File.Exists(ConfigPath)) return cfg;
                foreach (string raw in File.ReadAllLines(ConfigPath, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim();
                    string val = line.Substring(eq + 1).Trim();
                    if (key == "copyShot") cfg.CopyShot = val != "0";
                    else if (key == "ask") cfg.Ask = val != "0";
                    else if (key == "hotkeyFull") cfg.HotkeyFull = val;
                    else if (key == "hotkeyRegion") cfg.HotkeyRegion = val;
                    else if (key == "textFallback") cfg.TextFallback = val != "0";
                }
            }
            catch
            {
            }
            return cfg;
        }

        internal void Save()
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("# DSH 小窗设置 / settings. The settings page writes this file too.");
                sb.AppendLine("copyShot=" + (CopyShot ? "1" : "0"));
                sb.AppendLine("ask=" + (Ask ? "1" : "0"));
                sb.AppendLine("hotkeyFull=" + HotkeyFull);
                sb.AppendLine("hotkeyRegion=" + HotkeyRegion);
                sb.AppendLine("textFallback=" + (TextFallback ? "1" : "0"));
                File.WriteAllText(ConfigPath, sb.ToString(), Encoding.UTF8);
            }
            catch
            {
            }
        }

        internal static long Stamp()
        {
            try
            {
                if (!File.Exists(ConfigPath)) return 0;
                return File.GetLastWriteTimeUtc(ConfigPath).Ticks;
            }
            catch
            {
                return 0;
            }
        }
    }

    /// <summary>
    /// Hidden window that only exists to own global hotkeys (RegisterHotKey needs a hwnd
    /// and a message loop) and to be a BeginInvoke target for the watcher.
    /// </summary>
    internal sealed class HotkeyHost : Form
    {
        internal event Action<string> HotkeyPressed;

        private const int WM_HOTKEY = 0x0312;
        private const int ID_FULL = 0x1001;
        private const int ID_REGION = 0x1002;

        internal HotkeyHost()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(1, 1);
            Location = new Point(-4000, -4000);
            Text = "DSH 划词服务";
        }

        internal void Bind(HudConfig cfg)
        {
            try
            {
                UnregisterHotKey(Handle, ID_FULL);
                UnregisterHotKey(Handle, ID_REGION);

                uint mods, vk;
                if (TryParse(cfg.HotkeyFull, out mods, out vk))
                {
                    if (!RegisterHotKey(Handle, ID_FULL, mods, vk))
                        SelectionWatcher.Log("hotkey full busy: " + cfg.HotkeyFull);
                }
                if (TryParse(cfg.HotkeyRegion, out mods, out vk))
                {
                    if (!RegisterHotKey(Handle, ID_REGION, mods, vk))
                        SelectionWatcher.Log("hotkey region busy: " + cfg.HotkeyRegion);
                }
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("hotkey bind failed: " + ex.Message);
            }
        }

        internal static bool TryParse(string spec, out uint mods, out uint vk)
        {
            mods = 0;
            vk = 0;
            if (string.IsNullOrEmpty(spec)) return false;

            string[] parts = spec.Split('+');
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i].Trim();
                if (part.Length == 0) continue;
                string low = part.ToLowerInvariant();

                if (low == "ctrl" || low == "control") { mods |= 0x0002; continue; }
                if (low == "alt") { mods |= 0x0001; continue; }
                if (low == "shift") { mods |= 0x0004; continue; }
                if (low == "win") { mods |= 0x0008; continue; }

                if (low.Length == 1)
                {
                    char c = char.ToUpperInvariant(low[0]);
                    if (c >= 'A' && c <= 'Z') { vk = (uint)c; continue; }
                    if (c >= '0' && c <= '9') { vk = (uint)c; continue; }
                }
                if (low.Length >= 2 && low[0] == 'f')
                {
                    int n;
                    if (int.TryParse(low.Substring(1), out n) && n >= 1 && n <= 24)
                    {
                        vk = (uint)(0x70 + n - 1);
                        continue;
                    }
                }
                if (low == "printscreen" || low == "prtsc") { vk = 0x2C; continue; }
                if (low == "space") { vk = 0x20; continue; }
                if (low == "tab") { vk = 0x09; continue; }
                if (low == "enter" || low == "return") { vk = 0x0D; continue; }
                if (low == "esc" || low == "escape") { vk = 0x1B; continue; }
                return false;
            }
            return vk != 0;
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (!Visible)
            {
                // never let the helper window surface, even if someone calls Show()
                Hide();
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                Action<string> handler = HotkeyPressed;
                if (handler != null) handler(id == ID_REGION ? "region" : "full");
                return;
            }
            base.WndProc(ref m);
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    }

    /// <summary>
    /// Background process that keeps "问大肥鱼" alive without the window: the pill must
    /// work even when the HUD was never opened. It also owns the global screenshot hotkeys
    /// and hands work to the window shell over files (quote.txt / cmd.txt).
    /// </summary>
    internal sealed class SelectionService : ApplicationContext
    {
        private readonly HotkeyHost host;
        private readonly SelectionWatcher watcher;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem askItem;
        private readonly string exePath;
        private string url;
        private HudConfig config;
        private long configStamp;
        private readonly System.Windows.Forms.Timer configTimer;

        internal static string RequestUrl()
        {
            try
            {
                string reqPath = Path.Combine(HudConfig.Dir, "request.txt");
                if (File.Exists(reqPath))
                {
                    foreach (string line in File.ReadAllLines(reqPath, Encoding.UTF8))
                    {
                        string cand = line.Trim();
                        if (cand.StartsWith("http://") || cand.StartsWith("https://")) return cand;
                    }
                }
            }
            catch { }
            return null;
        }

        internal SelectionService(string url)
        {
            this.url = string.IsNullOrEmpty(url) ? RequestUrl() : url;
            exePath = Application.ExecutablePath;
            config = HudConfig.Load();
            configStamp = HudConfig.Stamp();

            host = new HotkeyHost();
            IntPtr forceHandle = host.Handle; // create it now: hotkeys/message loop need it
            host.HotkeyPressed += OnHotkey;

            watcher = new SelectionWatcher(host);
            watcher.QuoteRequested += DeliverQuote;
            watcher.Enabled = config.Ask;
            SelectionReader.ClipboardFallback = config.TextFallback;

            tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = "DSH 划词服务";
            tray.Visible = true;
            tray.DoubleClick += delegate { OpenHud(); };

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("打开小窗", null, delegate { OpenHud(); });
            askItem = new ToolStripMenuItem("划词问大肥鱼");
            askItem.CheckOnClick = true;
            askItem.Checked = config.Ask;
            askItem.CheckedChanged += delegate
            {
                config.Ask = askItem.Checked;
                config.Save();
                configStamp = HudConfig.Stamp();
                watcher.Enabled = config.Ask;
            };
            menu.Items.Add(askItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray.ContextMenuStrip = menu;

            host.Bind(config);
            SelectionWatcher.Log("service started url=" + (url == null ? "none" : "yes"));

            configTimer = new System.Windows.Forms.Timer();
            configTimer.Interval = 2500;
            configTimer.Tick += OnConfigTick;
            configTimer.Start();
        }

        /// <summary>Diagnostic hook: pillrect.txt holds "x,y,w,h" and previews the pill placement.</summary>
        private void CheckPillRect()
        {
            try
            {
                string path = Path.Combine(HudConfig.Dir, "pillrect.txt");
                if (!File.Exists(path)) return;
                string raw = File.ReadAllText(path).Trim();
                File.Delete(path);
                string[] parts = raw.Split(',');
                if (parts.Length != 4) return;
                Rectangle rect = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]),
                                               int.Parse(parts[2]), int.Parse(parts[3]));
                watcher.DebugPillAt(rect);
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("pillrect failed: " + ex.Message);
            }
        }

        private void OnConfigTick(object sender, EventArgs e)
        {
            CheckPillRect();
            long stamp = HudConfig.Stamp();
            if (stamp == configStamp) return;
            configStamp = stamp;
            config = HudConfig.Load();
            watcher.Enabled = config.Ask;
            askItem.Checked = config.Ask;
            SelectionReader.ClipboardFallback = config.TextFallback;
            host.Bind(config);
            SelectionWatcher.Log("config reloaded: hotkeyFull=" + config.HotkeyFull +
                                 " hotkeyRegion=" + config.HotkeyRegion +
                                 " textFallback=" + (config.TextFallback ? "1" : "0"));
        }

        private void OnHotkey(string kind)
        {
            try
            {
                SelectionWatcher.Log("hotkey " + kind);
                File.WriteAllText(HudConfig.CmdPath, kind, Encoding.UTF8);
                OpenHud();
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("hotkey failed: " + ex.Message);
            }
        }

        /// <summary>The pill was clicked: park the text, then bring the window up.</summary>
        private void DeliverQuote(string text)
        {
            try
            {
                File.WriteAllText(HudConfig.QuotePath, text, Encoding.UTF8);
                SelectionWatcher.Log("quote saved " + text.Length + " chars");
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("quote save failed: " + ex.Message);
            }
            OpenHud();
        }

        private void OpenHud()
        {
            try
            {
                IntPtr hwnd = FindHudWindow();
                if (hwnd != IntPtr.Zero)
                {
                    Native.ShowWindow(hwnd, Native.SW_RESTORE);
                    Native.SetForegroundWindow(hwnd);
                    return;
                }
                // The plugin refreshes request.txt on every pop-out, so prefer it over the
                // address this helper was started with (it may be from an earlier boot).
                string fresh = RequestUrl();
                if (!string.IsNullOrEmpty(fresh)) url = fresh;
                if (string.IsNullOrEmpty(url))
                {
                    SelectionWatcher.Log("spawn skipped: no url");
                    return;
                }
                // Start the shell through Explorer: a direct child would inherit the
                // restricted token this helper runs under, and WebView2 then fails to
                // initialise with E_ACCESSDENIED.
                try
                {
                    Process.Start("explorer.exe", "\"" + exePath + "\"");
                }
                catch
                {
                    Process.Start(exePath, "--url \"" + url + "\" --title \"DSH 小窗\"");
                }
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("spawn failed: " + ex.Message);
            }
        }

        private static IntPtr FindHudWindow()
        {
            try
            {
                string name = Path.GetFileNameWithoutExtension(Application.ExecutablePath);
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle;
                    }
                    catch
                    {
                    }
                    finally
                    {
                        p.Dispose();
                    }
                }
            }
            catch
            {
            }
            return IntPtr.Zero;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { configTimer.Stop(); configTimer.Dispose(); } catch { }
                try { if (watcher != null) watcher.Dispose(); } catch { }
                try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch { }
                try { if (host != null) host.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }
}
