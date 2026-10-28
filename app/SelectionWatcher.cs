using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

namespace DshHud
{
    /// <summary>Small Win32 surface used by the selection watcher.</summary>
    internal static class ShellWin
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT
        {
            public int X;
            public int Y;

            internal POINT(int x, int y)
            {
                X = x;
                Y = y;
            }
        }

        [DllImport("user32.dll")]
        internal static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        internal static extern IntPtr WindowFromPoint(POINT p);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

        [DllImport("user32.dll")]
        internal static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        [DllImport("user32.dll")]
        internal static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll")]
        internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        internal const uint GA_ROOT = 2;
        internal const int VK_LBUTTON = 0x01;
        internal const int VK_SHIFT = 0x10;
        internal const int VK_CONTROL = 0x11;
        internal const int VK_MENU = 0x12;
        internal const byte VK_C = 0x43;
        internal const uint KEYEVENTF_KEYUP = 0x0002;

        [StructLayout(LayoutKind.Sequential)]
        internal struct GUITHREADINFO
        {
            public int cbSize;
            public uint flags;
            public IntPtr hwndActive;
            public IntPtr hwndFocus;
            public IntPtr hwndCapture;
            public IntPtr hwndMenuOwner;
            public IntPtr hwndMoveSize;
            public IntPtr hwndCaret;
            public RECT rcCaret;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

        [DllImport("user32.dll")]
        internal static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam,
            IntPtr lParam, uint flags, uint timeout, out IntPtr result);

        internal const uint WM_COPY = 0x0301;
        internal const uint SMTO_ABORTIFHUNG = 0x0002;

        internal static bool IsMouseDown()
        {
            return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        }

        internal static bool IsKeyDown(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        /// <summary>
        /// True while the user holds Ctrl/Alt/Shift himself. Every probe is skipped then:
        /// injecting our own Ctrl+C on top of a real one is what made the user's copies
        /// land empty, and it can also cancel a drag-copy in Explorer.
        /// </summary>
        internal static bool IsModifierDown()
        {
            return IsKeyDown(VK_CONTROL) || IsKeyDown(VK_MENU) || IsKeyDown(VK_SHIFT);
        }

        /// <summary>
        /// The control that currently has the keyboard focus. WM_COPY has to be delivered to
        /// the edit control, not the top-level window.
        /// </summary>
        internal static IntPtr FocusedControl()
        {
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return IntPtr.Zero;
                uint pid;
                uint tid = GetWindowThreadProcessId(fg, out pid);
                GUITHREADINFO gti = new GUITHREADINFO();
                gti.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
                if (GetGUIThreadInfo(tid, ref gti))
                {
                    if (gti.hwndFocus != IntPtr.Zero) return gti.hwndFocus;
                    if (gti.hwndActive != IntPtr.Zero) return gti.hwndActive;
                }
                return fg;
            }
            catch
            {
                return IntPtr.Zero;
            }
        }

        /// <summary>
        /// Terminals map Ctrl+C to an interrupt rather than to "copy", so the clipboard
        /// fallback must never fire over one of them.
        /// </summary>
        internal static bool IsTerminalAt(Point p)
        {
            try
            {
                IntPtr h = WindowFromPoint(new POINT(p.X, p.Y));
                if (h == IntPtr.Zero) return false;
                StringBuilder sb = new StringBuilder(256);
                if (GetClassName(h, sb, sb.Capacity) <= 0) return false;
                string cls = sb.ToString().ToLowerInvariant();
                return cls.IndexOf("console") >= 0
                    || cls.IndexOf("cascadia") >= 0
                    || cls.IndexOf("mintty") >= 0
                    || cls.IndexOf("putty") >= 0
                    || cls.IndexOf("terminal") >= 0;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Same terminal test as <see cref="IsTerminalAt"/> but for a known window handle.</summary>
        internal static bool IsTerminalWindow(IntPtr h)
        {
            try
            {
                if (h == IntPtr.Zero) return false;
                StringBuilder sb = new StringBuilder(256);
                if (GetClassName(h, sb, sb.Capacity) <= 0) return false;
                string cls = sb.ToString().ToLowerInvariant();
                return cls.IndexOf("console") >= 0
                    || cls.IndexOf("cascadia") >= 0
                    || cls.IndexOf("mintty") >= 0
                    || cls.IndexOf("putty") >= 0
                    || cls.IndexOf("terminal") >= 0;
            }
            catch
            {
                return false;
            }
        }
        internal static IntPtr RootWindowAt(Point p)
        {
            try
            {
                return GetAncestor(WindowFromPoint(new POINT(p.X, p.Y)), GA_ROOT);
            }
            catch
            {
                return IntPtr.Zero;
            }
        }

        /// <summary>
        /// Explorer, the desktop and the taskbar read Ctrl+C as "copy the selected file",
        /// so probing them would litter the clipboard history with file copies. Those
        /// surfaces are skipped outright.
        /// </summary>
        internal static bool IsShellSurfaceAt(Point p)
        {
            try
            {
                IntPtr root = RootWindowAt(p);
                if (root == IntPtr.Zero) return true;
                StringBuilder sb = new StringBuilder(256);
                if (GetClassName(root, sb, sb.Capacity) <= 0) return false;
                string cls = sb.ToString().ToLowerInvariant();
                return cls == "progman"
                    || cls == "workerw"
                    || cls == "shell_traywnd"
                    || cls == "shell_secondarytraywnd"
                    || cls == "cabinetwclass"
                    || cls == "explorewclass"
                    || cls == "desktopwindowxamlsource";
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Game clients (Unity/Unreal shells) paint their own UI and expose no text, so the
        /// Ctrl+C fallback below would be delivered to them as a stray "C". In 原神 "C" is the
        /// character screen, so a double-click anywhere on the game silently opened it. Game
        /// surfaces are never probed: there is no selection to read there anyway.
        /// </summary>
        internal static bool IsGameWindow(IntPtr h)
        {
            try
            {
                if (h == IntPtr.Zero) return false;
                IntPtr root = GetAncestor(h, GA_ROOT);
                if (root == IntPtr.Zero) root = h;

                StringBuilder sb = new StringBuilder(256);
                if (GetClassName(root, sb, sb.Capacity) > 0)
                {
                    string cls = sb.ToString().ToLowerInvariant();
                    if (cls == "unitywndclass" || cls == "unrealwindow") return true;
                }

                uint pid;
                GetWindowThreadProcessId(root, out pid);
                if (pid != 0)
                {
                    string name = "";
                    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); }
                    catch { }
                    string[] games = { "yuanshen", "genshinimpact", "starrail", "zenlesszonezero", "bh3" };
                    foreach (string g in games)
                    {
                        if (name.IndexOf(g) >= 0) return true;
                    }
                }
            }
            catch
            {
            }
            return false;
        }

        /// <summary>
        /// Ask the focused control to copy through WM_COPY. This is the polite fallback:
        /// no keystrokes are synthesised, so a real Ctrl+C pressed by the user is never
        /// raced or cancelled, and nothing is written back over the clipboard.
        /// </summary>
        internal static bool SendCopyMessage()
        {
            try
            {
                IntPtr target = FocusedControl();
                if (target == IntPtr.Zero) return false;
                IntPtr result;
                SendMessageTimeout(target, WM_COPY, IntPtr.Zero, IntPtr.Zero,
                    SMTO_ABORTIFHUNG, 300, out result);
                return true;
            }
            catch
            {
                return false;
            }
        }

        internal static void SendCopy()
        {
            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(VK_C, 0, 0, UIntPtr.Zero);
            keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
    }

    /// <summary>
    /// Grabs the text of a live selection. Windows has no global "give me the selection"
    /// API, so the shell sends Ctrl+C, watches the clipboard sequence number to know when
    /// the copy actually landed, then puts the previous clipboard back.
    /// </summary>
    /// <summary>What was selected and where its last line sits (physical screen pixels).</summary>
    internal struct SelectionHit
    {
        internal string Text;
        internal Rectangle Rect;
        internal bool HasRect;

        /// <summary>Where to hang the pill when we have no real rectangle.</summary>
        internal Rectangle AnchorPoint(Point fallback)
        {
            if (HasRect) return Rect;
            return new Rectangle(fallback.X, fallback.Y, 0, 0);
        }
    }

    internal static class SelectionReader
    {
        /// <summary>
        /// On by default, but only ever consulted after UIA came back empty — so modern text
        /// surfaces (Notepad, WinForms, WPF, Office, the browser's own chrome) never touch the
        /// clipboard. Chromium content and legacy controls expose no TextPattern at all, and for
        /// those a copy is the only way to read the selection.
        ///
        /// Crucially the copy is *not* undone: the old implementation restored the previous
        /// clipboard contents afterwards, and that restore raced the user's own Ctrl+C and
        /// overwrote what they had just copied. Losing the previous clipboard contents is the
        /// price of reading a selection here; breaking Ctrl+C is not.
        /// </summary>
        internal static bool ClipboardFallback = true;

        /// <summary>
        /// Read the current selection. UIA first: it is passive (no keystrokes, no clipboard
        /// churn) and it also tells us where the selection ends, which is what the pill
        /// anchors to. Ctrl+C is only the fallback for apps that do not expose TextPattern.
        ///
        /// `hwnd` is the window the user dragged in. Targeting it beats asking for the
        /// focused element: the helper process often is not the foreground app by the
        /// time we look, and a window can keep a selection while unfocused.
        /// </summary>
        internal static SelectionHit ReadHit(IntPtr hwnd)
        {
            SelectionHit hit = new SelectionHit();
            hit.Text = "";

            try
            {
                AutomationElement el = hwnd != IntPtr.Zero ? AutomationElement.FromHandle(hwnd) : null;
                if (el == null) el = AutomationElement.FocusedElement;
                AutomationElement text = FindTextElement(el, 0);
                if (text != null)
                {
                    object pattern;
                    if (text.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                    {
                        TextPattern tp = (TextPattern)pattern;
                        TextPatternRange[] ranges = tp.GetSelection();
                        if (ranges != null && ranges.Length > 0)
                        {
                            string text2 = ranges[0].GetText(-1);
                            if (!string.IsNullOrEmpty(text2))
                            {
                                hit.Text = Normalize(text2);
                                // UIA hands back one rect per line in physical screen pixels;
                                // the last one is the end of the selection, which is where
                                // the pill wants to sit.
                                System.Windows.Rect[] rects = ranges[0].GetBoundingRectangles();
                                if (rects != null && rects.Length > 0)
                                {
                                    System.Windows.Rect last = rects[rects.Length - 1];
                                    if (last.Width > 0.5 && last.Height > 0.5)
                                    {
                                        hit.Rect = Rectangle.Round(new RectangleF(
                                            (float)last.X, (float)last.Y,
                                            (float)last.Width, (float)last.Height));
                                        hit.HasRect = true;
                                    }
                                }
                                return hit;
                            }
                        }
                    }
                }
            }
            catch
            {
            }

            if (ClipboardFallback) hit.Text = Read();
            return hit;
        }

        internal static SelectionHit ReadHit()
        {
            return ReadHit(IntPtr.Zero);
        }

        /// <summary>
        /// Breadth-first walk for the first element that supports TextPattern. Editors are
        /// usually one or two levels below the top window (Notepad: window → pane →
        /// document), so a shallow bound is enough and keeps this fast.
        /// </summary>
        private static AutomationElement FindTextElement(AutomationElement root, int depth)
        {
            if (root == null || depth > 4) return null;
            try
            {
                object pattern;
                if (root.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return root;

                TreeWalker walker = TreeWalker.RawViewWalker;
                AutomationElement child = walker.GetFirstChild(root);
                int guard = 0;
                while (child != null && guard < 40)
                {
                    guard += 1;
                    AutomationElement found = FindTextElement(child, depth + 1);
                    if (found != null) return found;
                    child = walker.GetNextSibling(child);
                }
            }
            catch
            {
            }
            return null;
        }

        private static string Normalize(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            text = text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
            if (text.Length > 4000) text = text.Substring(0, 4000);
            return text;
        }

        internal static string Read()
        {
            string result = "";
            Thread worker = new Thread(delegate()
            {
                result = ReadOnStaThread();
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.IsBackground = true;
            worker.Start();
            if (!worker.Join(2000)) return "";
            return result;
        }

        private static string ReadOnStaThread()
        {
            // No clipboard backup/restore any more. Restoring was the actual damage: while
            // we waited for our own copy to land, the user's real Ctrl+C could complete
            // first, and our restore then threw that copy away ("复制不上"). Now the worst
            // case is that the selection text stays on the clipboard — which is exactly
            // what the user just asked for anyway.
            if (ShellWin.IsModifierDown()) return "";

            uint seq = ShellWin.GetClipboardSequenceNumber();
            // WM_COPY is best effort only: Win32 edits answer it, Chromium and most
            // modern renderers ignore it, and SendMessageTimeout also returns false
            // when the target window is busy. Never treat "no answer" as "no selection".
            ShellWin.SendCopyMessage();

            string text = WaitForClipboardText(seq, 320);
            if (!string.IsNullOrEmpty(text))
            {
                SelectionWatcher.Log("copy: wm_copy " + text.Length + " chars");
                return Finish(text);
            }

            // A real key chord is the only thing that works for Chromium content and
            // legacy controls. Only when the user has opted in, and never while they
            // are holding a modifier themselves.
            if (!ClipboardFallback || ShellWin.IsModifierDown()) return "";
            try
            {
                ShellWin.SendCopy();
            }
            catch
            {
                return "";
            }
            text = WaitForClipboardText(seq, 700);
            SelectionWatcher.Log("copy: key_chord " + (text == null ? 0 : text.Length) +
                " chars seq " + seq + "->" + ShellWin.GetClipboardSequenceNumber());
            return string.IsNullOrEmpty(text) ? "" : Finish(text);
        }

        /// <summary>Wait until the clipboard sequence number moves, then read its text.</summary>
        private static string WaitForClipboardText(uint seq, int budgetMs)
        {
            int waited = 0;
            while (waited < budgetMs)
            {
                Thread.Sleep(25);
                waited += 25;
                if (ShellWin.GetClipboardSequenceNumber() == seq) continue;
                try
                {
                    if (Clipboard.ContainsText()) return Clipboard.GetText();
                }
                catch
                {
                }
                return "";
            }
            return "";
        }

        private static string Finish(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            text = text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
            if (text.Length == 0) return "";
            if (text.Length > 4000) text = text.Substring(0, 4000);
            return text;
        }
    }

    /// <summary>The little pill that follows a selection: "问大肥鱼".</summary>
    internal sealed class AskButton : Form
    {
        internal event EventHandler Clicked;

        private static readonly Color BaseBg = Color.FromArgb(255, 255, 255);
        private static readonly Color HoverBg = Color.FromArgb(243, 244, 246);
        private static readonly Color TextColor = Color.FromArgb(24, 24, 27);
        private static readonly Color BorderColor = Color.FromArgb(206, 208, 214);

        private readonly Label label;
        private float scale;

        internal AskButton(float scale)
        {
            this.scale = scale > 0f ? scale : 1f;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = BaseBg;
            DoubleBuffered = true;
            KeyPreview = false;

            Fingerprint();

            label = new Label();
            label.Text = "\u95EE\u5927\u80A5\u9C7C";
            label.AutoSize = false;
            label.Dock = DockStyle.Fill;
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.ForeColor = TextColor;
            label.BackColor = Color.Transparent;
            label.Cursor = Cursors.Hand;
            label.Click += delegate { Fire(); };
            label.MouseEnter += delegate { SetHover(true); };
            label.MouseLeave += delegate { SetHover(false); };
            Controls.Add(label);

            MouseEnter += delegate { SetHover(true); };
            MouseLeave += delegate { SetHover(false); };
            Click += delegate { Fire(); };

            ApplyMetrics();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // The monitor DPI is only reliable through the window itself; take it from here
            // so the pill is never a shrunken 96-dpi rectangle on a 150% screen.
            int dpi = DeviceDpi;
            if (dpi >= 96)
            {
                float s = dpi / 96f;
                if (Math.Abs(s - scale) > 0.01f)
                {
                    scale = s;
                    ApplyMetrics();
                }
            }
        }

        private void ApplyMetrics()
        {
            label.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            Width = TextRenderer.MeasureText(label.Text, label.Font).Width + U(28);
            Height = U(32);
            ApplyRoundedRegion();
        }

        internal void Fingerprint()
        {
            SelectionWatcher.Log("pill scale=" + scale.ToString("0.00"));
        }

        /// <summary>Never steal focus from the document the user is selecting in.</summary>
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
                return cp;
            }
        }

        internal void ShowNear(Point cursor)
        {
            Rectangle wa = Native.WorkArea();
            int x = cursor.X + U(14);
            int y = cursor.Y + U(18);
            if (x + Width > wa.Right) x = cursor.X - Width - U(10);
            if (y + Height > wa.Bottom) y = cursor.Y - Height - U(10);
            if (x < wa.Left) x = wa.Left + U(4);
            if (y < wa.Top) y = wa.Top + U(4);

            Location = new Point(x, y);
            if (!Visible) Show();
            BringToFront();
            SelectionWatcher.Log("pill at " + x + "," + y + " " + Width + "x" + Height);
        }

        /// <summary>
        /// Hangs the pill at the end of the last selected line: to its right when there is
        /// room, otherwise right-aligned underneath the selection. Clamped to the work area.
        /// </summary>
        internal void ShowNearSelection(SelectionHit hit, Point fallback)
        {
            Rectangle wa = Native.WorkArea();
            int x;
            int y;
            string mode;

            if (hit.HasRect && hit.Rect.Width > 0)
            {
                // bottom-right of the last selected rect: keeps the text itself uncovered
                Rectangle sel = hit.Rect;
                x = sel.Right + U(10);
                y = sel.Bottom + U(8);
                mode = "right-below";
                if (x + Width > wa.Right - U(6))
                {
                    // not enough room to the right: slide left, still under the last line
                    x = sel.Right - Width;
                    y = sel.Bottom + U(8);
                    mode = "below";
                }
                if (y + Height > wa.Bottom - U(6))
                {
                    // bottom of the screen: flip above the last line
                    y = sel.Top - Height - U(8);
                    mode = "above";
                }
            }
            else
            {
                x = fallback.X + U(14);
                y = fallback.Y + U(18);
                mode = "cursor";
            }

            if (x < wa.Left + U(6)) x = wa.Left + U(6);
            if (x + Width > wa.Right - U(6)) x = wa.Right - Width - U(6);
            if (y < wa.Top + U(6)) y = wa.Top + U(6);
            if (y + Height > wa.Bottom - U(6)) y = wa.Bottom - Height - U(6);

            Location = new Point(x, y);
            if (!Visible) Show();
            BringToFront();
            SelectionWatcher.Log("pill at " + x + "," + y + " " + Width + "x" + Height +
                                 " mode=" + mode + " sel=" + (hit.HasRect ? hit.Rect.ToString() : "none"));
        }

        internal void Dismiss()
        {
            if (Visible) Hide();
        }

        private int U(int v)
        {
            return (int)Math.Round(v * scale);
        }

        private void SetHover(bool on)
        {
            BackColor = on ? HoverBg : BaseBg;
            label.ForeColor = TextColor;
            Invalidate();
        }

        private void Fire()
        {
            EventHandler handler = Clicked;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        /// <summary>Capsule outline: the corner radius is half the height, so both ends are fully round.</summary>
        private GraphicsPath BuildPath(Rectangle b)
        {
            GraphicsPath path = new GraphicsPath();
            int d = Math.Max(2, Math.Min(b.Height, b.Width));
            path.AddArc(b.X, b.Y, d, d, 180, 90);
            path.AddArc(b.Right - d, b.Y, d, d, 270, 90);
            path.AddArc(b.Right - d, b.Bottom - d, d, d, 0, 90);
            path.AddArc(b.X, b.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private void ApplyRoundedRegion()
        {
            using (GraphicsPath path = BuildPath(new Rectangle(0, 0, Width, Height)))
            {
                Region = new Region(path);
            }
        }

        /// <summary>A hairline border keeps the white pill readable on white pages.</summary>
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int inset = Math.Max(1, U(1));
            Rectangle b = new Rectangle(inset, inset, Width - inset * 2 - 1, Height - inset * 2 - 1);
            using (GraphicsPath path = BuildPath(b))
            using (Pen pen = new Pen(BorderColor, Math.Max(1f, U(1))))
            {
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    /// <summary>
    /// Polls the mouse button (a low-level hook buys nothing here), notices drag-selects
    /// and double-clicks anywhere on the desktop, reads the selection and offers the pill.
    /// </summary>
    internal sealed class SelectionWatcher : IDisposable
    {
        internal event Action<string> QuoteRequested;

        private readonly Form host;
        private readonly AskButton button;
        private readonly System.Windows.Forms.Timer timer;
        private readonly float scale;

        private bool down;
        private Point downPt;
        private Point lastClickPt;
        private int downTick;
        private int lastClickTick;
        private int shownTick;
        private int probeId;
        private bool enabled = true;
        private string text = "";

        internal SelectionWatcher(Form host)
        {
            this.host = host;
            scale = Native.EffectiveScale();

            button = new AskButton(scale);
            button.Clicked += OnButtonClicked;

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 90;
            timer.Tick += Poll;
            timer.Start();
        }

        internal bool Enabled
        {
            get { return enabled; }
            set
            {
                enabled = value;
                if (!value) HideButton();
            }
        }

        public void Dispose()
        {
            try
            {
                timer.Stop();
                timer.Tick -= Poll;
                timer.Dispose();
            }
            catch
            {
            }
            try
            {
                button.Clicked -= OnButtonClicked;
                button.Dispose();
            }
            catch
            {
            }
        }

        private int U(int v)
        {
            return (int)Math.Round(v * scale);
        }

        private bool OverOwnWindows(Point p)
        {
            if (host != null && host.Visible && host.Bounds.Contains(p)) return true;
            if (button != null && button.Visible && button.Bounds.Contains(p)) return true;
            return false;
        }

        private void Poll(object sender, EventArgs e)
        {
            int now = Environment.TickCount;
            Point p = Cursor.Position;
            bool isDown = ShellWin.IsMouseDown();

            if (isDown && !down)
            {
                down = true;
                downPt = p;
                downTick = now;
                if (button.Visible && !button.Bounds.Contains(p)) HideButton();
            }
            else if (!isDown && down)
            {
                down = false;
                int elapsed = now - downTick;
                int dist = Math.Abs(p.X - downPt.X) + Math.Abs(p.Y - downPt.Y);

                if (elapsed < 8000 && dist >= U(6))
                {
                    if (!OverOwnWindows(p)) Kick(p, 130);
                }
                else if (dist < U(4))
                {
                    // double-click / triple-click selects a word or a paragraph
                    bool second = now - lastClickTick < 520
                        && Math.Abs(p.X - lastClickPt.X) < U(24)
                        && Math.Abs(p.Y - lastClickPt.Y) < U(24);
                    if (second && !OverOwnWindows(p)) Kick(p, 320);
                    lastClickTick = now;
                    lastClickPt = p;
                }
            }

            if (button.Visible && now - shownTick > 9000) HideButton();
        }

        internal static void Log(string line)
        {
            try
            {
                string dir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-hud");
                System.IO.Directory.CreateDirectory(dir);
                System.IO.File.AppendAllText(System.IO.Path.Combine(dir, "hud.log"),
                    DateTime.Now.ToString("HH:mm:ss") + " [pill] " + line + "\r\n",
                    System.Text.Encoding.UTF8);
            }
            catch
            {
            }
        }

        private void Kick(Point pt, int delay)
        {
            if (!enabled) { Log("skip: disabled"); return; }
            // A drag with Ctrl/Shift/Alt held is a copy or an extension, not a fresh
            // selection: probing it races the user's own shortcut.
            if (ShellWin.IsModifierDown()) { Log("skip: modifier down"); return; }

            if (ShellWin.IsShellSurfaceAt(pt)) { Log("skip: shell surface"); return; }
            int id = ++probeId;
            bool terminal = ShellWin.IsTerminalAt(pt);
            IntPtr root = ShellWin.RootWindowAt(pt);
            if (ShellWin.IsGameWindow(root)) { Log("skip: game window"); return; }
            Log("kick at " + pt.X + "," + pt.Y + " terminal=" + terminal + " root=" + root);

            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                try
                {
                    Thread.Sleep(delay);
                    if (id != probeId) return;
                    if (terminal) { Log("skip: terminal"); return; }
                    // the user may have switched apps while we waited; never copy there
                    // prefer whatever the user is actually looking at; the window under the
                    // cursor may be a stale/overlapped one (explorer behind a maximized app)
                    IntPtr fg = ShellWin.GetForegroundWindow();
                    if (fg != IntPtr.Zero && ShellWin.IsTerminalWindow(fg)) { Log("skip: foreground terminal"); return; }
                    if (ShellWin.IsGameWindow(fg)) { Log("skip: foreground game"); return; }

                    SelectionHit hit = SelectionReader.ReadHit(fg != IntPtr.Zero ? fg : root);
                    if (string.IsNullOrEmpty(hit.Text) && fg != IntPtr.Zero && fg != root)
                    {
                        hit = SelectionReader.ReadHit(root);
                    }
                    string got = hit.Text;
                    Log("read " + (got == null ? -1 : got.Length) + " chars" +
                        (hit.HasRect ? " rect=" + hit.Rect.ToString() : " rect=none"));
                    if (string.IsNullOrEmpty(got)) return;
                    if (id != probeId) return;

                    host.BeginInvoke(new MethodInvoker(delegate
                    {
                        ShowButton(hit, pt);
                    }));
                }
                catch
                {
                }
            });
        }

        /// <summary>Diagnostic hook: show the pill for a sample text at the cursor.</summary>
        internal void DebugPill()
        {
            SelectionHit hit = new SelectionHit();
            hit.Text = "\u8C03\u8BD5\uFF1A\u9884\u89C8\u836F\u4E38\u5916\u89C2\u7528\u7684\u4E00\u6BB5\u6587\u5B57";
            ShowButton(hit, Cursor.Position);
        }

        /// <summary>Diagnostic hook: place the pill as if <paramref name="rect"/> were the last selected rect.</summary>
        internal void DebugPillAt(Rectangle rect)
        {
            SelectionHit hit = new SelectionHit();
            hit.HasRect = true;
            hit.Rect = rect;
            hit.Text = "debug";
            shownTick = Environment.TickCount;
            button.ShowNearSelection(hit, Cursor.Position);
        }
        /// <summary>Diagnostic hook: read the current selection without any mouse work.</summary>
        internal void TestProbe()
        {
            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                SelectionHit hit = SelectionReader.ReadHit();
                string got = hit.Text;
                int len = got == null ? -1 : got.Length;
                string head = len > 0 ? got.Substring(0, Math.Min(40, got.Length)) : "";
                Log("test read " + len + " chars" + (hit.HasRect ? " rect=" + hit.Rect.ToString() : " rect=none") +
                    ": " + head.Replace("\n", " ").Replace("\r", " "));
            });
        }

        private void ShowButton(SelectionHit hit, Point pt)
        {
            Log("show " + (hit.Text == null ? 0 : hit.Text.Length) + " chars");
            text = hit.Text;
            shownTick = Environment.TickCount;
            button.ShowNearSelection(hit, pt);
        }

        private void HideButton()
        {
            text = "";
            button.Dismiss();
        }

        private void OnButtonClicked(object sender, EventArgs e)
        {
            string got = text;
            HideButton();
            if (string.IsNullOrEmpty(got)) return;
            Action<string> handler = QuoteRequested;
            if (handler != null) handler(got);
        }
    }
}
