// src/computer_use_helper/ComputerUseHelper.cs
// Switchyard Computer Use helper - Windows desktop automation.
//
// Protocol: newline-delimited JSON on stdin/stdout, one request per line.
//   in : {"id":1,"cmd":"tree","params":{"window":1234}}
//   out: {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}
//
// It is a persistent server (not one-shot) so UI Automation element indexes stay
// valid between an observation and the action that follows it. src/computer_tools.js
// spawns it once per session and kills it on idle timeout or parent exit.
//
// Capabilities: window enumeration, foreground activation, occlusion-tolerant capture
// (PrintWindow with PW_RENDERFULLCONTENT, screen BitBlt fallback), accessibility tree
// with stable indexes, SendInput mouse/keyboard, Unicode text entry, and UI Automation
// patterns (invoke / value / selection / toggle / expand-collapse).
//
// Compiled on demand by src/computer_tools.js via compile.ps1.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public static class CuHelper
{
    const string Version = "1.0.0";

    // ---------------------------------------------------------------- Win32
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint ME_MOVE = 0x0001, ME_LEFTDOWN = 0x0002, ME_LEFTUP = 0x0004,
               ME_RIGHTDOWN = 0x0008, ME_RIGHTUP = 0x0010,
               ME_MIDDLEDOWN = 0x0020, ME_MIDDLEUP = 0x0040,
               ME_WHEEL = 0x0800, ME_HWHEEL = 0x0100,
               ME_ABSOLUTE = 0x8000, ME_VIRTUALDESK = 0x4000;
    const uint KE_KEYUP = 0x0002, KE_UNICODE = 0x0004;
    const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_APPWINDOW = 0x00040000;
    const int DWMWA_CLOAKED = 14;

    // ---------------------------------------------------------------- state
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly Dictionary<int, AutomationElement> Elements = new Dictionary<int, AutomationElement>();
    static long ElementsHwnd = 0;
    static bool CompactFormat = false;
    static readonly object Sync = new object();

    // ---------------------------------------------------------------- entry
    public static int Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }

        long parentPid = 0;
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "--parent-pid") long.TryParse(args[i + 1], out parentPid);
        if (parentPid > 0) StartParentWatchdog((int)parentPid);

        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> request = null;
            object response;
            string cmd = "";
            try
            {
                request = Json.Deserialize<Dictionary<string, object>>(line);
                cmd = Str(request, "cmd");
                var p = request.ContainsKey("params") ? request["params"] as Dictionary<string, object> : null;
                if (p == null) p = new Dictionary<string, object>();
                object result;
                lock (Sync) { result = Dispatch(cmd, p); }
                response = new Dictionary<string, object> {
                    { "id", request.ContainsKey("id") ? request["id"] : null },
                    { "ok", true },
                    { "result", result }
                };
            }
            catch (Exception ex)
            {
                response = new Dictionary<string, object> {
                    { "id", request != null && request.ContainsKey("id") ? request["id"] : null },
                    { "ok", false },
                    { "error", ex.GetType().Name + ": " + ex.Message }
                };
            }
            stdout.WriteLine(Json.Serialize(response));
            if (cmd == "exit") return 0;
        }
        return 0;
    }

    static void StartParentWatchdog(int pid)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(2000);
                try { if (Process.GetProcessById(pid).HasExited) Environment.Exit(0); }
                catch { Environment.Exit(0); }
            }
        }) { IsBackground = true };
        thread.Start();
    }

    static object Dispatch(string cmd, Dictionary<string, object> p)
    {
        switch (cmd)
        {
            case "info": return Info();
            case "windows": return Windows(p);
            case "focus": return FocusCmd(p);
            case "capture": return Capture(p);
            case "tree": return Tree(p);
            case "click": return Click(p);
            case "type": return TypeCmd(p);
            case "key": return KeyCmd(p);
            case "scroll": return Scroll(p);
            case "drag": return Drag(p);
            case "set_value": return SetValue(p);
            case "invoke": return InvokeCmd(p);
            case "launch": return Launch(p);
            case "probe_input": return ProbeInput(p);
            case "selftest": return SelfTest();
            case "exit": return new Dictionary<string, object> { { "bye", true } };
            default: throw new ArgumentException("unknown command: " + cmd);
        }
    }

    // ---------------------------------------------------------------- params
    static string Str(Dictionary<string, object> d, string key, string fallback = "")
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
        return Convert.ToString(d[key]);
    }

    static int Int(Dictionary<string, object> d, string key, int fallback)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
        try { return Convert.ToInt32(d[key]); } catch { return fallback; }
    }

    static bool Bool(Dictionary<string, object> d, string key, bool fallback)
    {
        if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
        try { return Convert.ToBoolean(d[key]); } catch { return fallback; }
    }

    static bool Has(Dictionary<string, object> d, string key)
    {
        return d != null && d.ContainsKey(key) && d[key] != null;
    }

    static string Clip(string value, int max)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var flat = value.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
        return flat.Length <= max ? flat : flat.Substring(0, max) + "...";
    }

    // ---------------------------------------------------------------- windows
    static bool IsCloaked(IntPtr hwnd)
    {
        try
        {
            int cloaked;
            if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0) return cloaked != 0;
        }
        catch { }
        return false;
    }

    static string TitleOf(IntPtr h)
    {
        try
        {
            int len = GetWindowTextLength(h);
            var sb = new StringBuilder(Math.Max(len + 1, 2));
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }
        catch { return ""; }
    }

    static string ProcessOf(IntPtr h)
    {
        try
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return "";
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch { return ""; }
    }

    static object Info()
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        bool uia = false;
        try { uia = AutomationElement.RootElement != null; } catch { }
        bool elevated = false;
        try
        {
            using (var identity = WindowsIdentity.GetCurrent())
                elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch { }
        int monitors = 1;
        try { monitors = Screen.AllScreens.Length; } catch { }
        return new Dictionary<string, object> {
            { "version", Version },
            { "os", Environment.OSVersion.VersionString },
            { "session_id", Process.GetCurrentProcess().SessionId },
            { "interactive", Environment.UserInteractive },
            { "elevated", elevated },
            { "uia_available", uia },
            { "monitor_count", monitors },
            { "virtual_screen", new Dictionary<string, object> {
                { "x", vx }, { "y", vy }, { "width", vw }, { "height", vh } } }
        };
    }

    static object Windows(Dictionary<string, object> p)
    {
        bool visibleOnly = Bool(p, "visible_only", true);
        bool includeCloaked = Bool(p, "include_cloaked", false);
        bool includeToolWindows = Bool(p, "include_tool_windows", false);
        var foreground = GetForegroundWindow();
        var list = new List<Dictionary<string, object>>();

        EnumWindows((h, l) =>
        {
            if (visibleOnly && !IsWindowVisible(h)) return true;
            if (!includeCloaked && IsCloaked(h)) return true;

            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            var clsName = cls.ToString();
            if (clsName == "Progman" || clsName == "WorkerW" || clsName == "Shell_TrayWnd") return true;

            if (!includeToolWindows)
            {
                int ex = GetWindowLong(h, GWL_EXSTYLE);
                bool tool = (ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0;
                if (tool) return true;
            }

            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            bool minimized = IsIconic(h);
            if (minimized)
            {
                // Minimized windows report the -32000 sentinel rect; normal placement is usable.
                var placement = new WINDOWPLACEMENT();
                placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (GetWindowPlacement(h, ref placement)) r = placement.rcNormalPosition;
            }
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (w <= 0 || hh <= 0) return true;

            uint pid;
            GetWindowThreadProcessId(h, out pid);

            list.Add(new Dictionary<string, object> {
                { "hwnd", h.ToInt64() },
                { "pid", pid },
                { "process", ProcessOf(h) },
                { "title", TitleOf(h) },
                { "class", clsName },
                { "x", r.Left }, { "y", r.Top },
                { "width", w }, { "height", hh },
                { "minimized", minimized },
                { "foreground", h == foreground }
            });
            return true;
        }, IntPtr.Zero);

        // Foreground first, then title, so the likely target is at the top of the list.
        list.Sort((a, b) =>
        {
            bool fa = (bool)a["foreground"], fb = (bool)b["foreground"];
            if (fa != fb) return fa ? -1 : 1;
            return string.Compare(Convert.ToString(a["title"]), Convert.ToString(b["title"]), StringComparison.OrdinalIgnoreCase);
        });

        return new Dictionary<string, object> { { "count", list.Count }, { "windows", list } };
    }

    static IntPtr ResolveWindow(Dictionary<string, object> p, bool required = true)
    {
        if (!Has(p, "window") && Has(p, "window_title"))
        {
            var copy = new Dictionary<string, object>(p);
            copy["window"] = p["window_title"];
            p = copy;
        }
        if (!Has(p, "window"))
        {
            if (required) throw new ArgumentException("window is required (hwnd number or title substring)");
            return IntPtr.Zero;
        }

        var raw = p["window"];
        long hwnd = 0;
        if (raw is int) hwnd = Convert.ToInt64(raw);
        else if (raw is long) hwnd = (long)raw;
        else if (raw is decimal) hwnd = (long)(decimal)raw;
        else
        {
            var s = Convert.ToString(raw).Trim();
            long parsed;
            if (long.TryParse(s, out parsed)) hwnd = parsed;
        }

        if (hwnd != 0)
        {
            var handle = new IntPtr(hwnd);
            if (!IsWindow(handle)) throw new ArgumentException("no such window handle: " + hwnd + " (list windows with computer_windows)");
            return handle;
        }

        var needle = Convert.ToString(raw).Trim();
        if (needle.Length == 0) throw new ArgumentException("window selector is empty");
        var matches = new List<KeyValuePair<IntPtr, string>>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h) || IsCloaked(h)) return true;
            var title = TitleOf(h);
            if (title.Length == 0) return true;
            bool hit = title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0 ||
                       ProcessOf(h).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!hit) return true;
            matches.Add(new KeyValuePair<IntPtr, string>(h, title));
            return true;
        }, IntPtr.Zero);

        if (matches.Count == 0)
            throw new ArgumentException("no visible window matched '" + needle + "' (list windows with computer_windows)");
        if (matches.Count > 1)
            throw new ArgumentException("ambiguous window '" + needle + "': " +
                string.Join(" | ", matches.Take(6).Select(m => "[" + m.Key.ToInt64() + "] " + m.Value)) +
                (matches.Count > 6 ? " | ..." : "") + "\nPass the hwnd from computer_windows instead.");
        return matches[0].Key;
    }

    static bool Activate(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        if (GetForegroundWindow() == h) return true;
        if (IsIconic(h)) ShowWindow(h, 9);
        ShowWindow(h, 5);

        // SetForegroundWindow is refused unless this process owns the foreground or
        // produced the last input event. Attach to the foreground thread first, then
        // fall back to an Alt tap and finally a topmost toggle.
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
        uint self = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != self)
            attached = AttachThreadInput(self, foregroundThread, true);
        try
        {
            BringWindowToTop(h);
            SetForegroundWindow(h);
            SetFocus(h);
        }
        finally
        {
            if (attached) AttachThreadInput(self, foregroundThread, false);
        }

        if (GetForegroundWindow() != h)
        {
            KeyDown(0x12);
            KeyUp(0x12);
            Thread.Sleep(40);
            SetForegroundWindow(h);
        }
        if (GetForegroundWindow() != h)
        {
            SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetForegroundWindow(h);
        }
        Thread.Sleep(150);
        return GetForegroundWindow() == h;
    }

    static object FocusCmd(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p);
        var foreground = Activate(h);
        return new Dictionary<string, object> {
            { "hwnd", h.ToInt64() },
            { "title", TitleOf(h) },
            { "activated", foreground },
            { "foreground", foreground }
        };
    }

    // ---------------------------------------------------------------- capture
    static Bitmap CaptureScreen(out int ox, out int oy)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        ox = vx;
        oy = vy;
        return CaptureScreenRegion(vx, vy, vw, vh);
    }

    static Bitmap CaptureScreenRegion(int x, int y, int w, int h)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        return bmp;
    }

    static bool LooksBlank(Bitmap bmp)
    {
        try
        {
            var seen = new HashSet<int>();
            int stepX = Math.Max(1, bmp.Width / 12), stepY = Math.Max(1, bmp.Height / 12);
            for (int y = 0; y < bmp.Height; y += stepY)
                for (int x = 0; x < bmp.Width; x += stepX)
                {
                    seen.Add(bmp.GetPixel(x, y).ToArgb());
                    if (seen.Count > 2) return false;
                }
            return seen.Count <= 1;
        }
        catch { return false; }
    }

    static Bitmap CaptureWindow(IntPtr h, out int ox, out int oy)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) throw new ArgumentException("could not read the window rectangle");
        if (IsIconic(h))
            throw new ArgumentException("window is minimized; call computer_focus first, or capture with mode=screen");
        int w = Math.Max(1, r.Right - r.Left), hh = Math.Max(1, r.Bottom - r.Top);
        ox = r.Left;
        oy = r.Top;

        var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
        bool printed = false;
        try
        {
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                try { printed = PrintWindow(h, hdc, 2); }
                finally { g.ReleaseHdc(hdc); }
            }
        }
        catch { printed = false; }

        // PW_RENDERFULLCONTENT covers DWM-composited windows, but a few surfaces come
        // back blank. Fall back to a screen copy, which needs the window unoccluded.
        if (!printed || LooksBlank(bmp))
        {
            bmp.Dispose();
            return CaptureScreenRegion(ox, oy, w, hh);
        }
        return bmp;
    }

    static object Capture(Dictionary<string, object> p)
    {
        var outPath = Str(p, "out");
        if (string.IsNullOrEmpty(outPath)) throw new ArgumentException("out (png path) is required");
        var mode = Str(p, "mode", "window").ToLowerInvariant();
        int maxDim = Int(p, "max_dim", 0);

        Bitmap bmp;
        int ox, oy;
        IntPtr h = IntPtr.Zero;
        if (mode == "screen")
        {
            bmp = CaptureScreen(out ox, out oy);
        }
        else
        {
            h = ResolveWindow(p);
            bmp = CaptureWindow(h, out ox, out oy);
        }

        double scale = 1.0;
        if (maxDim > 0 && (bmp.Width > maxDim || bmp.Height > maxDim))
        {
            scale = (double)maxDim / Math.Max(bmp.Width, bmp.Height);
            int nw = Math.Max(1, (int)Math.Round(bmp.Width * scale));
            int nh = Math.Max(1, (int)Math.Round(bmp.Height * scale));
            var scaled = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(bmp, 0, 0, nw, nh);
            }
            bmp.Dispose();
            bmp = scaled;
        }

        var dir = Path.GetDirectoryName(outPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        bmp.Save(outPath, ImageFormat.Png);

        var result = new Dictionary<string, object> {
            { "path", outPath },
            { "width", bmp.Width },
            { "height", bmp.Height },
            { "origin_x", ox },
            { "origin_y", oy },
            { "scale", Math.Round(scale, 4) },
            { "mode", mode },
            { "window", h == IntPtr.Zero ? (object)null : h.ToInt64() },
            { "taken_at", DateTime.UtcNow.ToString("o") }
        };
        bmp.Dispose();
        return result;
    }

    // ---------------------------------------------------------------- UI Automation
    static object Tree(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p);
        int maxNodes = Math.Min(Math.Max(Int(p, "max_nodes", 350), 1), 3000);
        int maxDepth = Math.Min(Math.Max(Int(p, "max_depth", 10), 1), 24);
        bool includeOffscreen = Bool(p, "include_offscreen", false);
        bool compact = Bool(p, "compact", false);

        var root = AutomationElement.FromHandle(h);
        if (root == null) throw new ArgumentException("UI Automation could not attach to hwnd " + h.ToInt64());

        // Compact mode reports the page content root instead of the window chrome,
        // which is the difference between a one-item snapshot and fifty nodes.
        AutomationElement start = root;
        if (compact)
        {
            try
            {
                var condition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
                var document = root.FindFirst(TreeScope.Descendants, condition);
                if (document != null) start = document;
            }
            catch { }
        }
        CompactFormat = compact;

        lock (Sync)
        {
            Elements.Clear();
            ElementsHwnd = h.ToInt64();
        }

        int count = 0;
        var lines = new List<string>();
        Walk(start, 0, maxDepth, maxNodes, includeOffscreen, ref count, lines);

        string focused = "";
        try
        {
            var f = AutomationElement.FocusedElement;
            if (f != null && IsDescendant(root, f)) focused = Describe(f, -1);
        }
        catch { }

        string docText = "";
        try { docText = ReadDocumentText(root); } catch { }

        return new Dictionary<string, object> {
            { "hwnd", h.ToInt64() },
            { "title", TitleOf(h) },
            { "node_count", count },
            { "compact", compact },
            { "content_root", start == root ? "window" : "document" },
            { "tree", string.Join("\n", lines) },
            { "focused", focused },
            { "document_text", docText.Length > 20000 ? docText.Substring(0, 20000) + "\n<truncated>" : docText },
            { "truncated", count >= maxNodes }
        };
    }

    static void Walk(AutomationElement el, int depth, int maxDepth, int maxNodes, bool includeOffscreen, ref int count, List<string> lines)
    {
        if (el == null || count >= maxNodes || depth > maxDepth) return;

        AutomationElement child = null;
        try
        {
            var current = el.Current;
            int index = count;
            var line = Describe(el, index);
            if (line.Length > 0)
            {
                Elements[index] = el;
                count++;
                if (includeOffscreen || !current.IsOffscreen)
                    lines.Add(new string(' ', Math.Min(depth, 20) * 2) + line);
            }
            child = TreeWalker.ControlViewWalker.GetFirstChild(el);
        }
        catch (ElementNotAvailableException) { return; }
        catch (Exception) { return; }

        while (child != null && count < maxNodes)
        {
            AutomationElement next = null;
            try { next = TreeWalker.ControlViewWalker.GetNextSibling(child); }
            catch { next = null; }
            Walk(child, depth + 1, maxDepth, maxNodes, includeOffscreen, ref count, lines);
            child = next;
        }
    }

    static string Describe(AutomationElement el, int index)
    {
        string name = "", type = "Unknown", value = "";
        bool enabled = true, offscreen = false;
        double x = 0, y = 0, w = 0, h = 0;
        try
        {
            var c = el.Current;
            name = c.Name ?? "";
            type = (c.ControlType == null ? "ControlType.Unknown" : c.ControlType.ProgrammaticName).Replace("ControlType.", "");
            enabled = c.IsEnabled;
            offscreen = c.IsOffscreen;
            var r = c.BoundingRectangle;
            x = r.X; y = r.Y; w = r.Width; h = r.Height;
        }
        catch { return ""; }

        var caps = new List<string>();
        try
        {
            object pattern;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                value = ((ValuePattern)pattern).Current.Value ?? "";
                caps.Add("value");
            }
        }
        catch { }
        try { object pattern; if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) caps.Add("invoke"); } catch { }
        try { object pattern; if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) caps.Add("toggle"); } catch { }
        try { object pattern; if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) caps.Add("select"); } catch { }
        try { object pattern; if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) caps.Add("expand"); } catch { }
        try { object pattern; if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) caps.Add("scroll"); } catch { }

        var sb = new StringBuilder();
        if (CompactFormat) sb.Append("@e").Append(index).Append(' ');
        else sb.Append('[').Append(index).Append("] ");
        sb.Append(type);
        if (name.Length > 0) sb.Append(" \"").Append(Clip(name, 120)).Append('"');
        if (value.Length > 0) sb.Append(" value=\"").Append(Clip(value, 120)).Append('"');
        if (caps.Count > 0) sb.Append(" {").Append(string.Join(",", caps)).Append('}');
        sb.Append(" (").Append((int)x).Append(',').Append((int)y).Append(',')
          .Append((int)w).Append(',').Append((int)h).Append(')');
        if (!enabled) sb.Append(" disabled");
        if (offscreen) sb.Append(" offscreen");
        return sb.ToString();
    }

    static bool IsDescendant(AutomationElement root, AutomationElement node)
    {
        try
        {
            var walker = TreeWalker.ControlViewWalker;
            var current = node;
            for (int i = 0; i < 200 && current != null; i++)
            {
                if (System.Windows.Automation.Automation.Compare(current, root)) return true;
                current = walker.GetParent(current);
            }
        }
        catch { }
        return false;
    }

    static string ReadDocumentText(AutomationElement root)
    {
        try
        {
            object pattern;
            if (root.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                return ((TextPattern)pattern).DocumentRange.GetText(-1) ?? "";
        }
        catch { }

        // Bounded search for a Document control that exposes TextPattern.
        try
        {
            var condition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
            var doc = root.FindFirst(TreeScope.Descendants, condition);
            if (doc != null)
            {
                object pattern;
                if (doc.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                    return ((TextPattern)pattern).DocumentRange.GetText(-1) ?? "";
            }
        }
        catch { }
        return "";
    }

    static AutomationElement ElementAt(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p);
        int index = Int(p, "element_index", -1);
        if (index < 0) throw new ArgumentException("element_index is required (run computer_ui_tree first)");
        if (ElementsHwnd != h.ToInt64() || Elements.Count == 0)
            throw new ArgumentException("no accessibility observation for this window; run computer_ui_tree or computer_observe first");
        AutomationElement el;
        if (!Elements.TryGetValue(index, out el))
            throw new ArgumentException("element_index " + index + " is not in the latest observation; re-observe before acting");
        return el;
    }

    static POINT ClickablePoint(AutomationElement el)
    {
        try
        {
            var pt = el.GetClickablePoint();
            return new POINT { X = (int)Math.Round(pt.X), Y = (int)Math.Round(pt.Y) };
        }
        catch
        {
            var r = el.Current.BoundingRectangle;
            if (r.Width <= 0 || r.Height <= 0)
                throw new ArgumentException("element has no clickable point and an empty bounding rectangle");
            return new POINT { X = (int)(r.X + r.Width / 2), Y = (int)(r.Y + r.Height / 2) };
        }
    }

    // ---------------------------------------------------------------- input
    static uint MouseMove(int x, int y)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        long nx = ((long)x - vx) * 65535 / Math.Max(1, vw - 1);
        long ny = ((long)y - vy) * 65535 / Math.Max(1, vh - 1);
        var inputs = new INPUT[] {
            new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT {
                dx = (int)nx, dy = (int)ny,
                dwFlags = ME_MOVE | ME_ABSOLUTE | ME_VIRTUALDESK } } }
        };
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(25);
        return sent;
    }

    static void MouseButton(string button, bool down)
    {
        uint flag;
        var b = (button ?? "left").ToLowerInvariant();
        if (b == "right" || b == "r") flag = down ? ME_RIGHTDOWN : ME_RIGHTUP;
        else if (b == "middle" || b == "m") flag = down ? ME_MIDDLEDOWN : ME_MIDDLEUP;
        else flag = down ? ME_LEFTDOWN : ME_LEFTUP;
        var inputs = new INPUT[] {
            new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT { dwFlags = flag } } }
        };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Wheel(int delta, bool horizontal)
    {
        var inputs = new INPUT[] {
            new INPUT { type = INPUT_MOUSE, u = new INPUTUNION { mi = new MOUSEINPUT {
                mouseData = unchecked((uint)delta),
                dwFlags = horizontal ? ME_HWHEEL : ME_WHEEL } } }
        };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static void KeyDown(ushort vk)
    {
        var inputs = new INPUT[] {
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk } } }
        };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(12);
    }

    static void KeyUp(ushort vk)
    {
        var inputs = new INPUT[] {
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, dwFlags = KE_KEYUP } } }
        };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(12);
    }

    static uint SendUnicode(string text)
    {
        // KEYEVENTF_UNICODE delivers text independent of keyboard layout.
        uint accepted = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            var down = new INPUT[] {
                new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT {
                    wVk = 0, wScan = ch, dwFlags = KE_UNICODE } } }
            };
            var up = new INPUT[] {
                new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT {
                    wVk = 0, wScan = ch, dwFlags = KE_UNICODE | KE_KEYUP } } }
            };
            accepted += SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
            accepted += SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
            if ((i & 31) == 31) Thread.Sleep(10);
        }
        return accepted;
    }

    static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>
    {
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 },
        { "win", 0x5B }, { "meta", 0x5B }, { "lwin", 0x5B }, { "rwin", 0x5C },
        { "esc", 0x1B }, { "escape", 0x1B },
        { "enter", 0x0D }, { "return", 0x0D },
        { "tab", 0x09 }, { "space", 0x20 },
        { "backspace", 0x08 }, { "back", 0x08 },
        { "delete", 0x2E }, { "del", 0x2E },
        { "insert", 0x2D }, { "ins", 0x2D },
        { "home", 0x24 }, { "end", 0x23 },
        { "pageup", 0x21 }, { "prior", 0x21 },
        { "pagedown", 0x22 }, { "next", 0x22 },
        { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "capslock", 0x14 }, { "printscreen", 0x2C }, { "snapshot", 0x2C },
        { "apps", 0x5D }, { "menu", 0x5D },
        { "pause", 0x13 }, { "numlock", 0x90 }, { "scrolllock", 0x91 }
    };

    static bool KeyToken(string token, out ushort vk, out bool needsShift)
    {
        vk = 0;
        needsShift = false;
        var t = (token ?? "").Trim().ToLowerInvariant();
        if (t.Length == 0) return false;
        if (KeyMap.TryGetValue(t, out vk)) return true;
        int n;
        if (t.Length >= 2 && t[0] == 'f' && int.TryParse(t.Substring(1), out n) && n >= 1 && n <= 24)
        {
            vk = (ushort)(0x70 + (n - 1));
            return true;
        }
        if (t.Length == 1)
        {
            short scan = VkKeyScan(t[0]);
            if (scan == -1) return false;
            vk = (ushort)(scan & 0xFF);
            needsShift = ((scan >> 8) & 1) == 1;
            return true;
        }
        return false;
    }

    static object Click(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p, required: false);
        int count = Math.Min(Math.Max(Int(p, "count", 1), 1), 3);
        var button = Str(p, "button", "left");

        int x, y;
        if (Has(p, "element_index"))
        {
            var el = ElementAt(p);
            var pt = ClickablePoint(el);
            x = pt.X;
            y = pt.Y;
            try { el.SetFocus(); } catch { }
        }
        else
        {
            if (!Has(p, "x") || !Has(p, "y"))
                throw new ArgumentException("provide element_index, or x and y (screen coordinates)");
            x = Int(p, "x", 0);
            y = Int(p, "y", 0);
        }

        if (h != IntPtr.Zero) Activate(h);
        MouseMove(x, y);
        for (int i = 0; i < count; i++)
        {
            MouseButton(button, true);
            Thread.Sleep(20);
            MouseButton(button, false);
            if (i < count - 1) Thread.Sleep(70);
        }
        Thread.Sleep(60);
        return new Dictionary<string, object> {
            { "clicked", true }, { "x", x }, { "y", y },
            { "button", button }, { "count", count }
        };
    }

    static object TypeCmd(Dictionary<string, object> p)
    {
        var text = Str(p, "text");
        if (text.Length == 0) throw new ArgumentException("text is required");

        if (Has(p, "element_index"))
        {
            var el = ElementAt(p);
            try { el.SetFocus(); } catch { }
            Thread.Sleep(80);
            try
            {
                object pattern;
                if (Bool(p, "replace", false) && el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    ((ValuePattern)pattern).SetValue(text);
                    return new Dictionary<string, object> { { "typed", text.Length }, { "mode", "value_pattern" } };
                }
            }
            catch { }
        }
        else
        {
            var h = ResolveWindow(p, required: false);
            if (h != IntPtr.Zero) Activate(h);
        }

        SendUnicode(text);
        Thread.Sleep(50);
        return new Dictionary<string, object> { { "typed", text.Length }, { "mode", "sendinput_unicode" } };
    }

    static object KeyCmd(Dictionary<string, object> p)
    {
        var keys = Str(p, "keys");
        if (keys.Length == 0) throw new ArgumentException("keys is required, for example ctrl+s");

        var h = ResolveWindow(p, required: false);
        if (h != IntPtr.Zero) Activate(h);

        var parts = keys.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
        if (parts.Count == 0) throw new ArgumentException("keys is empty");

        var downOrder = new List<ushort>();
        foreach (var part in parts)
        {
            ushort vk;
            bool needsShift;
            if (!KeyToken(part, out vk, out needsShift)) throw new ArgumentException("unknown key name: " + part);
            if (needsShift) downOrder.Add(0x10);
            downOrder.Add(vk);
        }
        foreach (var vk in downOrder) KeyDown(vk);
        for (int i = downOrder.Count - 1; i >= 0; i--) KeyUp(downOrder[i]);
        Thread.Sleep(50);
        return new Dictionary<string, object> { { "pressed", keys } };
    }

    static object Scroll(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p, required: false);
        if (h != IntPtr.Zero) Activate(h);
        int x = Int(p, "x", 0), y = Int(p, "y", 0);
        var direction = Str(p, "direction", "down").ToLowerInvariant();
        int pages = Math.Min(Math.Max(Int(p, "pages", 1), 1), 20);
        int amount = Int(p, "amount", 0);

        MouseMove(x, y);
        int magnitude = amount != 0 ? Math.Abs(amount) : pages * 3 * 120;
        bool vertical = direction == "up" || direction == "down" || direction == "u" || direction == "d";
        if (vertical)
        {
            int delta = (direction == "up" || direction == "u") ? magnitude : -magnitude;
            Wheel(delta, false);
        }
        else
        {
            int delta = (direction == "left" || direction == "l") ? -magnitude : magnitude;
            Wheel(delta, true);
        }
        Thread.Sleep(120);
        return new Dictionary<string, object> {
            { "scrolled", true }, { "direction", direction }, { "amount", magnitude }
        };
    }

    static object Drag(Dictionary<string, object> p)
    {
        var h = ResolveWindow(p, required: false);
        if (h != IntPtr.Zero) Activate(h);
        int fromX = Int(p, "from_x", 0), fromY = Int(p, "from_y", 0);
        int toX = Int(p, "to_x", 0), toY = Int(p, "to_y", 0);

        MouseMove(fromX, fromY);
        MouseButton("left", true);
        Thread.Sleep(80);
        const int steps = 14;
        for (int i = 1; i <= steps; i++)
        {
            int x = fromX + (toX - fromX) * i / steps;
            int y = fromY + (toY - fromY) * i / steps;
            MouseMove(x, y);
            Thread.Sleep(16);
        }
        Thread.Sleep(60);
        MouseButton("left", false);
        Thread.Sleep(80);
        return new Dictionary<string, object> {
            { "dragged", true },
            { "from", new Dictionary<string, object> { { "x", fromX }, { "y", fromY } } },
            { "to", new Dictionary<string, object> { { "x", toX }, { "y", toY } } }
        };
    }

    // ---------------------------------------------------------------- patterns
    static object SetValue(Dictionary<string, object> p)
    {
        var el = ElementAt(p);
        var value = Str(p, "value");
        object pattern;
        if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            throw new ArgumentException("this element does not expose the Value pattern; use computer_type instead");
        ((ValuePattern)pattern).SetValue(value);
        return new Dictionary<string, object> { { "set", true }, { "value", value } };
    }

    static object InvokeCmd(Dictionary<string, object> p)
    {
        var el = ElementAt(p);
        object pattern;
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
        {
            ((InvokePattern)pattern).Invoke();
            return new Dictionary<string, object> { { "invoked", true }, { "via", "invoke_pattern" } };
        }
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
        {
            ((TogglePattern)pattern).Toggle();
            return new Dictionary<string, object> { { "invoked", true }, { "via", "toggle_pattern" } };
        }
        if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
        {
            ((SelectionItemPattern)pattern).Select();
            return new Dictionary<string, object> { { "invoked", true }, { "via", "selection_pattern" } };
        }
        if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
        {
            var ec = (ExpandCollapsePattern)pattern;
            if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ec.Expand();
            else ec.Collapse();
            return new Dictionary<string, object> { { "invoked", true }, { "via", "expand_collapse_pattern" } };
        }
        throw new ArgumentException("element exposes no invoke/toggle/select/expand pattern; use computer_click with coordinates");
    }

    // ---------------------------------------------------------------- launch
    static object Launch(Dictionary<string, object> p)
    {
        var path = Str(p, "path");
        if (path.Length == 0) throw new ArgumentException("path is required");
        if (path.IndexOfAny(new[] { '&', '|', '>', '<', '"', ';' }) >= 0)
            throw new ArgumentException("path must not contain shell metacharacters");

        var psi = new ProcessStartInfo(path) { UseShellExecute = true };
        var extra = Str(p, "args");
        if (extra.Length > 0) psi.Arguments = extra;
        var workdir = Str(p, "workdir");
        if (workdir.Length > 0) psi.WorkingDirectory = workdir;

        var proc = Process.Start(psi);
        Thread.Sleep(Math.Min(Math.Max(Int(p, "wait_ms", 900), 0), 15000));
        return new Dictionary<string, object> {
            { "launched", true }, { "path", path },
            { "pid", proc == null ? 0 : proc.Id }
        };
    }

    // ---------------------------------------------------------------- probe
    static object ProbeInput(Dictionary<string, object> p)
    {
        int dx = Int(p, "dx", 40), dy = Int(p, "dy", 0);
        POINT before, after;
        GetCursorPos(out before);
        uint accepted = MouseMove(before.X + dx, before.Y + dy);
        Thread.Sleep(80);
        GetCursorPos(out after);
        SetCursorPos(before.X, before.Y);
        return new Dictionary<string, object> {
            { "cursor_before", new Dictionary<string, object> { { "x", before.X }, { "y", before.Y } } },
            { "cursor_after", new Dictionary<string, object> { { "x", after.X }, { "y", after.Y } } },
            { "mouse_sendinput_accepted", accepted },
            { "moved", after.X == before.X + dx && after.Y == before.Y + dy },
            { "foreground_hwnd", GetForegroundWindow().ToInt64() }
        };
    }

    // ---------------------------------------------------------------- selftest
    static Form _testForm;
    static TextBox _testBox;
    static volatile bool _testPressed;

    static object SelfTest()
    {
        var report = new Dictionary<string, object>();
        var ready = new ManualResetEventSlim(false);
        Exception failure = null;

        var thread = new Thread(() =>
        {
            try
            {
                _testBox = new TextBox { Left = 20, Top = 20, Width = 360 };
                var button = new Button { Left = 20, Top = 60, Width = 120, Height = 32, Text = "Press" };
                button.Click += (s, e) => { _testPressed = true; };
                _testForm = new Form {
                    Text = "Switchyard computer-use self-test",
                    Width = 420, Height = 200, StartPosition = FormStartPosition.CenterScreen,
                    TopMost = true
                };
                _testForm.Controls.Add(_testBox);
                _testForm.Controls.Add(button);
                _testForm.Shown += (s, e) =>
                {
                    try { _testForm.Activate(); _testBox.Focus(); } catch { }
                    ready.Set();
                };
                Application.Run(_testForm);
            }
            catch (Exception ex) { failure = ex; ready.Set(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();

        if (!ready.Wait(6000)) throw new Exception("self-test window did not appear");
        if (failure != null) throw failure;
        Thread.Sleep(400);

        IntPtr hwnd = IntPtr.Zero;
        _testForm.Invoke(new Action(() => { hwnd = _testForm.Handle; }));
        report["hwnd"] = hwnd.ToInt64();

        Activate(hwnd);
        Thread.Sleep(250);
        if (GetForegroundWindow() != hwnd) Activate(hwnd);
        report["foreground"] = GetForegroundWindow() == hwnd;

        int ox, oy;
        var bmp = CaptureWindow(hwnd, out ox, out oy);
        report["capture_width"] = bmp.Width;
        report["capture_height"] = bmp.Height;
        bool blank = LooksBlank(bmp);
        report["capture_blank"] = blank;
        bmp.Dispose();

        var root = AutomationElement.FromHandle(hwnd);
        int count = 0;
        var lines = new List<string>();
        Elements.Clear();
        ElementsHwnd = hwnd.ToInt64();
        Walk(root, 0, 8, 100, false, ref count, lines);
        report["uia_nodes"] = count;

        _testForm.Invoke(new Action(() => { _testBox.Focus(); }));
        Thread.Sleep(150);
        Activate(hwnd);
        _testForm.Invoke(new Action(() => { _testBox.Focus(); }));
        Thread.Sleep(120);
        uint accepted = SendUnicode("cu-selftest");
        report["sendinput_chars_accepted"] = accepted;
        report["foreground_before_typing"] = GetForegroundWindow() == hwnd;
        Thread.Sleep(350);

        string boxText = "";
        _testForm.Invoke(new Action(() => { boxText = _testBox.Text; }));
        report["typed_value"] = boxText;
        report["type_ok"] = boxText == "cu-selftest";

        bool clicked = false;
        int clickX = 0, clickY = 0;
        try
        {
            var condition = new PropertyCondition(AutomationElement.NameProperty, "Press");
            var button = root.FindFirst(TreeScope.Descendants, condition);
            if (button != null)
            {
                var pt = ClickablePoint(button);
                clickX = pt.X;
                clickY = pt.Y;
                // A click on a window that is not truly the active window is consumed by
                // activation, so retry once after re-activating on the UI thread.
                for (int attempt = 0; attempt < 2 && !_testPressed; attempt++)
                {
                    Activate(hwnd);
                    try { _testForm.Invoke(new Action(() => { _testForm.Activate(); })); } catch { }
                    Thread.Sleep(150);
                    MouseMove(pt.X, pt.Y);
                    Thread.Sleep(60);
                    MouseButton("left", true);
                    Thread.Sleep(40);
                    MouseButton("left", false);
                    Thread.Sleep(400);
                }
                clicked = true;
            }
        }
        catch (Exception ex) { report["click_error"] = ex.Message; }
        report["click_point"] = new Dictionary<string, object> { { "x", clickX }, { "y", clickY } };
        report["foreground_at_click"] = GetForegroundWindow() == hwnd;
        report["click_dispatched"] = clicked;
        report["click_ok"] = _testPressed;

        try { _testForm.Invoke(new Action(() => { _testForm.TopMost = false; _testForm.Close(); })); } catch { }
        thread.Join(3000);

        report["passed"] = !blank && (boxText == "cu-selftest") && _testPressed;
        return report;
    }
}
