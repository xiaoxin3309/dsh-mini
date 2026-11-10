namespace DshHud
{
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/// <summary>
/// The translation desk, in a window of its own.
///
/// The overlay used to live inside the small window, which meant it opened wherever that
/// window happened to be and disappeared with it. A click on the pill now publishes one
/// payload next to the shell's data directory and raises this window; the desk page polls
/// that payload, so this side never has to push megabytes over a JS bridge — the frozen
/// screen stays on disk and is only read again when the user asks for context.
/// </summary>
internal static class DeskShell
{
    private static TranslateWindow window;
    private static int seq;

    internal static void Publish(string text, Rectangle selection)
    {
        if (string.IsNullOrEmpty(text)) return;
        try
        {
            string root = Path.Combine(HudConfig.Dir, "translate");
            string shots = Path.Combine(root, "shots");
            Directory.CreateDirectory(shots);

            string id = Guid.NewGuid().ToString("N").Substring(0, 16);
            Rectangle screen = Rectangle.Empty;
            int shotWidth = 0;
            int shotHeight = 0;

            try
            {
                screen = RegionCaptureForm.PhysicalVirtualScreen();
                using (Bitmap shot = RegionCaptureForm.GrabDesktop(screen))
                {
                    if (shot != null)
                    {
                        shot.Save(Path.Combine(shots, id + ".png"), ImageFormat.Png);
                        shotWidth = shot.Width;
                        shotHeight = shot.Height;
                    }
                }
            }
            catch (Exception ex)
            {
                SelectionWatcher.Log("desk shot failed: " + ex.Message);
            }

            seq++;
            StringBuilder json = new StringBuilder();
            json.Append("{\"seq\":").Append(seq);
            json.Append(",\"id\":\"").Append(id).Append("\"");
            json.Append(",\"text\":\"").Append(Escape(text)).Append("\"");
            json.Append(",\"selection\":").Append(RectJson(selection));
            json.Append(",\"screen\":").Append(RectJson(screen));
            json.Append(",\"shot\":\"").Append(shotWidth > 0 ? Escape(id + ".png") : "").Append("\"");
            json.Append(",\"shotWidth\":").Append(shotWidth);
            json.Append(",\"shotHeight\":").Append(shotHeight);
            json.Append("}");

            string target = Path.Combine(root, "pending.json");
            string tmp = target + ".tmp";
            File.WriteAllText(tmp, json.ToString(), new UTF8Encoding(false));
            try
            {
                if (File.Exists(target)) File.Delete(target);
                File.Move(tmp, target);
            }
            catch
            {
                // A racing reader is fine: the desk will pick it up on the next poll.
                File.WriteAllText(target, json.ToString(), new UTF8Encoding(false));
            }

            SelectionWatcher.Log("desk publish " + text.Length + " chars id=" + id);
            ShowDesk(selection);
        }
        catch (Exception ex)
        {
            SelectionWatcher.Log("desk publish failed: " + ex.Message);
        }
    }

    private static void ShowDesk(Rectangle selection)
    {
        if (window == null || window.IsDisposed)
        {
            window = new TranslateWindow();
            window.ShowNear(selection);
            window.Show();
            return;
        }
        if (!window.Visible) window.Show();
        window.Activate();
    }

    private static string RectJson(Rectangle r)
    {
        return "{\"x\":" + r.X + ",\"y\":" + r.Y + ",\"w\":" + r.Width + ",\"h\":" + r.Height + "}";
    }

    internal static string Escape(string value)
    {
        StringBuilder sb = new StringBuilder(value.Length + 16);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }
}

internal sealed class TranslateWindow : Form
{
    private WebView2 web;
    private bool ready;
    private bool navigated;
    private System.Windows.Forms.Timer urlTimer;

    internal TranslateWindow()
    {
        Text = "\u7FFB\u8BD1";
        FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        MinimizeBox = false;
        Width = 470;
        Height = 560;
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { }

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);

        urlTimer = new System.Windows.Forms.Timer();
        urlTimer.Interval = 500;
        urlTimer.Tick += OnUrlTick;

        Load += delegate { Boot(); };
    }

    internal void ShowNear(Rectangle selection)
    {
        Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
        int x = area.Left + 40;
        int y = area.Top + 40;
        if (selection.Width > 0)
        {
            x = selection.Right + 12;
            y = selection.Bottom + 12;
        }
        else
        {
            x = Cursor.Position.X + 16;
            y = Cursor.Position.Y + 16;
        }
        int maxX = area.Right - Width - 8;
        int maxY = area.Bottom - Height - 8;
        if (x > maxX) x = Math.Max(area.Left + 8, maxX);
        if (y > maxY) y = Math.Max(area.Top + 8, maxY);
        Location = new Point(x, y);
    }

    private async void Boot()
    {
        try
        {
            string udf = Path.Combine(HudConfig.Dir, "webview2-desk");
            Directory.CreateDirectory(udf);
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, udf, null);
            await web.EnsureCoreWebView2Async(env);
            web.CoreWebView2.WebMessageReceived += OnMessage;
            ready = true;
            TryNavigate();
            urlTimer.Start();
        }
        catch (Exception ex)
        {
            SelectionWatcher.Log("desk boot failed: " + ex.Message);
        }
    }

    private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string raw = e.WebMessageAsJson ?? "";
            if (raw.IndexOf("\"close\"", StringComparison.Ordinal) >= 0) Close();
        }
        catch
        {
            // A malformed message must not take the window down.
        }
    }

    private void OnUrlTick(object sender, EventArgs e)
    {
        TryNavigate();
    }

    private void TryNavigate()
    {
        if (!ready || navigated) return;
        try
        {
            string path = Path.Combine(HudConfig.Dir, "translate-url.txt");
            if (!File.Exists(path)) return;
            string url = File.ReadAllText(path, Encoding.UTF8).Trim();
            if (url.Length == 0) return;
            navigated = true;
            urlTimer.Stop();
            web.CoreWebView2.Navigate(url);
        }
        catch (Exception ex)
        {
            SelectionWatcher.Log("desk navigate failed: " + ex.Message);
        }
    }
}

}
