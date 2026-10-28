using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshHud
{
    /// <summary>One snap candidate: a top-level window as it was just before the overlay opened.</summary>
    internal sealed class CaptureTarget
    {
        internal Rectangle Rect;    // screen pixels
        internal string Title;

        internal CaptureTarget(Rectangle rect, string title)
        {
            Rect = rect;
            Title = title;
        }
    }

    /// <summary>
    /// Full-screen picker for the "框选" screenshot key.
    ///
    /// It does not grab the screen itself: the caller freezes the desktop into a bitmap,
    /// hands it over, and this window just paints it. What you see under the overlay is
    /// therefore exactly what gets cropped, with no second capture and no flicker.
    ///
    /// Unit handling: this process is per-monitor DPI aware, and WinForms reports client
    /// sizes in logical units while the desktop bitmap is in physical pixels. Mixing the
    /// two silently produces half-size or 1.5x selections, so everything here - the frozen
    /// bitmap, the selection, the snap candidates, the cursor - stays in PHYSICAL SCREEN
    /// pixels, and the only conversion happens in ScreenToClientRect() at paint time. The
    /// window itself is forced onto the physical virtual screen with SetWindowPos, because
    /// assigning Bounds in logical units lands somewhere else at 150% scaling.
    ///
    /// Hit testing does NOT use WindowFromPoint: the overlay covers every pixel, so
    /// WindowFromPoint would only ever return the overlay. The caller snapshots the window
    /// list first (EnumWindows is top-most first) and this form picks the first rectangle
    /// containing the cursor - what WindowFromPoint would have said.
    ///
    /// Interaction: moving the mouse highlights the window under the cursor (a plain click
    /// captures just that window); dragging any distance switches to a free rectangle;
    /// Esc or right-click cancels.
    /// </summary>
    internal sealed class RegionCaptureForm : Form
    {
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int DWMWA_CLOAKED = 14;
        private const int GWL_EXSTYLE = -20;
        private const long WS_EX_TOOLWINDOW = 0x00000080;

        private const int HWND_TOPMOST = -1;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, int after, int x, int y, int cx, int cy, uint flags);

        private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

        private readonly Bitmap frozen;
        private readonly Rectangle screen;      // virtual screen, physical pixels
        private readonly List<CaptureTarget> targets;

        private Rectangle selection = Rectangle.Empty;   // physical screen pixels
        private string selectionHint = "";
        private bool dragging;
        private Point dragStart;                          // physical screen pixels
        private Rectangle result;

        internal RegionCaptureForm(Bitmap frozen, Rectangle virtualScreen, List<CaptureTarget> targets)
        {
            this.frozen = frozen;
            this.screen = virtualScreen;
            this.targets = targets ?? new List<CaptureTarget>();

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.Black;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
            SetStyle(ControlStyles.AllPaintingInWmPaint, true);
            SetStyle(ControlStyles.UserPaint, true);
            DoubleBuffered = true;
        }

        /// <summary>The chosen rectangle, in physical screen pixels. Valid when ShowDialog returned OK.</summary>
        internal Rectangle SelectedRect
        {
            get { return result; }
        }

        /// <summary>
        /// The virtual desktop rectangle in PHYSICAL pixels.
        ///
        /// SystemInformation.VirtualScreen cannot be used here: in a per-monitor-v2 process
        /// GetSystemMetrics (which backs it) answers for the calling thread's DPI context,
        /// so it reports the 150%-scaled logical size and the overlay would cover only the
        /// top-left two thirds of the screen. Monitor rectangles are always physical.
        /// </summary>
        internal static Rectangle PhysicalVirtualScreen()
        {
            Rectangle union = Rectangle.Empty;
            bool first = true;
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hMonitor, IntPtr hdc, ref RECT r, IntPtr data)
            {
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(hMonitor, ref mi))
                {
                    Rectangle m = Rectangle.FromLTRB(mi.rcMonitor.Left, mi.rcMonitor.Top,
                        mi.rcMonitor.Right, mi.rcMonitor.Bottom);
                    if (first)
                    {
                        union = m;
                        first = false;
                    }
                    else
                    {
                        union = Rectangle.Union(union, m);
                    }
                }
                return true;
            }, IntPtr.Zero);

            if (first)
            {
                // Nothing enumerated (should not happen); fall back to the primary monitor.
                return Screen.PrimaryScreen.Bounds;
            }
            return union;
        }

        /// <summary>Grabs the whole virtual desktop, in physical pixels.</summary>
        internal static Bitmap GrabDesktop(Rectangle virtualScreen)
        {
            Bitmap bmp = new Bitmap(virtualScreen.Width, virtualScreen.Height,
                System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(virtualScreen.X, virtualScreen.Y, 0, 0, virtualScreen.Size,
                    CopyPixelOperation.SourceCopy);
            }
            return bmp;
        }

        /// <summary>
        /// Snapshot of the top-level windows, top-most first, minus our own process, the
        /// shell surfaces and DWM-cloaked ghosts (a UWP window the shell put away still
        /// reports IsWindowVisible and would otherwise swallow the whole screen).
        /// </summary>
        internal static List<CaptureTarget> CollectTargets()
        {
            List<CaptureTarget> list = new List<CaptureTarget>();
            uint self = (uint)Process.GetCurrentProcess().Id;

            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                try
                {
                    if (!IsWindowVisible(h)) return true;

                    long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
                    if ((ex & WS_EX_TOOLWINDOW) != 0) return true;
                    if (IsShellSurface(h)) return true;

                    uint pid;
                    GetWindowThreadProcessId(h, out pid);
                    if (pid == self) return true;
                    if (IsCloaked(h)) return true;

                    StringBuilder sb = new StringBuilder(256);
                    if (GetWindowText(h, sb, sb.Capacity) <= 0) return true;
                    string title = sb.ToString().Trim();
                    if (title.Length == 0) return true;

                    Rectangle r = FrameBounds(h);
                    if (r.Width < 40 || r.Height < 40) return true;

                    list.Add(new CaptureTarget(r, title));
                }
                catch
                {
                }
                return true;
            }, IntPtr.Zero);

            return list;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Force the physical rectangle: a logical-units conversion inside WinForms would
            // otherwise shrink the overlay to the logical screen at 150% scaling.
            SetWindowPos(Handle, HWND_TOPMOST, screen.X, screen.Y, screen.Width, screen.Height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Take the keyboard so Esc works, and seed the highlight at the cursor.
            Activate();
            SetForegroundWindow(Handle);
            SeedFromCursor(Cursor.Position);
            Invalidate();
        }

        private void SeedFromCursor(Point screenPt)
        {
            Rectangle rect;
            string hint;
            CandidateAt(screenPt, out rect, out hint);
            selection = rect;
            selectionHint = hint;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;

            // The frozen desktop, stretched into whatever client rectangle the screen maps
            // to (identity at 100%, a scaled mapping if WinForms' units disagree with ours).
            Rectangle screenInClient = ScreenToClientRect(screen);
            if (frozen != null && screenInClient.Width > 0 && screenInClient.Height > 0)
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                g.DrawImage(frozen, screenInClient);
            }

            Rectangle sel = ScreenToClientRect(selection);
            sel.Intersect(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));
            if (sel.Width > 2 && sel.Height > 2)
            {
                // Veil in four bands around the selection instead of a clipped fill: cheaper
                // on a 2560x1600 backdrop and no aliasing seams along the edges.
                using (SolidBrush veil = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
                {
                    int cw = ClientSize.Width;
                    int ch = ClientSize.Height;
                    g.FillRectangle(veil, 0, 0, cw, sel.Top);
                    g.FillRectangle(veil, 0, sel.Bottom, cw, ch - sel.Bottom);
                    g.FillRectangle(veil, 0, sel.Top, sel.Left, sel.Height);
                    g.FillRectangle(veil, sel.Right, sel.Top, cw - sel.Right, sel.Height);
                }

                using (Pen border = new Pen(Color.FromArgb(59, 130, 246), 2f))
                {
                    g.DrawRectangle(border, sel.X, sel.Y, sel.Width - 1, sel.Height - 1);
                }

                DrawSizeTag(g, sel);
            }

            DrawHint(g);
        }

        private void DrawSizeTag(Graphics g, Rectangle sel)
        {
            string text = selection.Width + " x " + selection.Height;
            if (selectionHint.Length > 0)
            {
                text = selectionHint + "   " + text;
                if (text.Length > 56) text = text.Substring(0, 56) + "\u2026";
            }

            using (Font font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular))
            using (SolidBrush back = new SolidBrush(Color.FromArgb(215, 20, 20, 24)))
            using (SolidBrush fore = new SolidBrush(Color.White))
            {
                Size sz = TextRenderer.MeasureText(text, font);
                int padX = 9;
                int padY = 4;
                int w = sz.Width + padX * 2;
                int h = sz.Height + padY * 2;
                int x = sel.X;
                int y = sel.Top - h - 6;
                if (y < 0) y = sel.Top + 6;
                if (x + w > ClientSize.Width) x = ClientSize.Width - w - 4;
                if (x < 4) x = 4;
                g.FillRectangle(back, x, y, w, h);
                g.DrawString(text, font, fore, x + padX, y + padY);
            }
        }

        private void DrawHint(Graphics g)
        {
            const string hint = "\u5355\u51FB\u7A97\u53E3\u622A\u53D6\u8BE5\u7A97\u53E3 \u00B7 \u62D6\u62FD\u6846\u9009\u4EFB\u610F\u533A\u57DF \u00B7 Esc \u53D6\u6D88";
            using (Font font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular))
            using (SolidBrush back = new SolidBrush(Color.FromArgb(215, 20, 20, 24)))
            using (SolidBrush fore = new SolidBrush(Color.White))
            {
                Size sz = TextRenderer.MeasureText(hint, font);
                int padX = 14;
                int padY = 7;
                int w = sz.Width + padX * 2;
                int h = sz.Height + padY * 2;
                int x = (ClientSize.Width - w) / 2;
                if (x < 4) x = 4;
                int y = 26;
                g.FillRectangle(back, x, y, w, h);
                g.DrawString(hint, font, fore, x + padX, y + padY);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
            {
                selection = Normalize(dragStart, Cursor.Position);
                selectionHint = "\u6846\u9009";
            }
            else
            {
                SeedFromCursor(Cursor.Position);
            }
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right)
            {
                DialogResult = DialogResult.Cancel;
                Close();
                return;
            }
            if (e.Button != MouseButtons.Left) return;

            dragging = true;
            dragStart = Cursor.Position;
            selection = new Rectangle(dragStart, Size.Empty);
            selectionHint = "\u6846\u9009";
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left || !dragging) return;

            dragging = false;
            Point end = Cursor.Position;
            Rectangle dragged = Normalize(dragStart, end);

            Rectangle picked;
            if (dragged.Width < 6 || dragged.Height < 6)
            {
                // A plain click (or a shaky one) means "this window".
                string hint;
                CandidateAt(end, out picked, out hint);
            }
            else
            {
                picked = dragged;
            }

            Rectangle inScreen = picked;
            inScreen.Intersect(screen);
            if (inScreen.Width < 2 || inScreen.Height < 2)
            {
                selection = Rectangle.Empty;
                Invalidate();
                return;
            }

            SelectionWatcher.Log("picker pick " + inScreen.Width + "x" + inScreen.Height +
                " at " + inScreen.X + "," + inScreen.Y);
            result = inScreen;
            DialogResult = DialogResult.OK;
            Close();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                DialogResult = DialogResult.Cancel;
                Close();
            }
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && frozen != null)
            {
                frozen.Dispose();
            }
        }

        /// <summary>
        /// What is under a physical screen point: the top-most snapshotted window containing
        /// it, or the monitor that owns the point when the desktop is empty there.
        /// </summary>
        private void CandidateAt(Point screenPt, out Rectangle rect, out string hint)
        {
            for (int i = 0; i < targets.Count; i++)
            {
                CaptureTarget t = targets[i];
                if (t.Rect.Contains(screenPt))
                {
                    rect = t.Rect;
                    hint = t.Title;
                    return;
                }
            }

            rect = screen;
            hint = "\u5C4F\u5E55";
        }

        /// <summary>
        /// Maps a physical screen rectangle into client pixels through WinForms' own
        /// screen-to-client mapping, so any unit mismatch between its bookkeeping and ours
        /// cancels out instead of skewing the selection.
        /// </summary>
        private Rectangle ScreenToClientRect(Rectangle screenRect)
        {
            Point topLeft = PointToClient(new Point(screenRect.Left, screenRect.Top));
            Point bottomRight = PointToClient(new Point(screenRect.Right, screenRect.Bottom));
            return new Rectangle(topLeft.X, topLeft.Y,
                bottomRight.X - topLeft.X, bottomRight.Y - topLeft.Y);
        }

        /// <summary>
        /// Window rect without the invisible resize border that GetWindowRect reports for
        /// DWM-composited windows; the capture should match what the eye sees.
        /// </summary>
        private static Rectangle FrameBounds(IntPtr hwnd)
        {
            RECT r;
            if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                Rectangle dwm = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
                if (dwm.Width > 2 && dwm.Height > 2) return dwm;
            }

            RECT raw;
            if (GetWindowRect(hwnd, out raw))
            {
                return Rectangle.FromLTRB(raw.Left, raw.Top, raw.Right, raw.Bottom);
            }
            return Rectangle.Empty;
        }

        private static bool IsCloaked(IntPtr hwnd)
        {
            try
            {
                int cloaked;
                if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0)
                {
                    return cloaked != 0;
                }
            }
            catch
            {
            }
            return false;
        }

        private static bool IsShellSurface(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(128);
            if (GetClassName(hwnd, sb, sb.Capacity) <= 0) return false;
            string cls = sb.ToString().ToLowerInvariant();
            return cls == "progman"
                || cls == "workerw"
                || cls == "shell_traywnd"
                || cls == "shell_secondarytraywnd"
                || cls == "desktopwindowxamlsource";
        }

        private static Rectangle Normalize(Point a, Point b)
        {
            int x = Math.Min(a.X, b.X);
            int y = Math.Min(a.Y, b.Y);
            int w = Math.Abs(a.X - b.X);
            int h = Math.Abs(a.Y - b.Y);
            return new Rectangle(x, y, w, h);
        }
    }
}
