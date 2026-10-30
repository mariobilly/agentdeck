# Shows the modern Windows folder picker in front of everything and prints the chosen path
# (prints nothing if cancelled). Called by server.js for the "Browse…" button.
param([string]$Start = '')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);

    // The picker opens at its owner's corner; move it to the middle of the given area once it exists.
    public static bool CenterOver(string title, int x, int y, int w, int h) {
        IntPtr d = FindWindow("#32770", title);
        RECT r;
        if (d == IntPtr.Zero || !GetWindowRect(d, out r)) return false;
        int dw = r.Right - r.Left, dh = r.Bottom - r.Top;
        SetWindowPos(d, IntPtr.Zero, x + (w - dw) / 2, y + Math.Max(0, (h - dh) / 2), 0, 0, 0x0001 | 0x0004); // NOSIZE | NOZORDER
        return true;
    }

    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder s, int n);

    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);

    // A Chrome/Edge window titled "AgentDeck" or "(2) AgentDeck".
    static bool IsDeck(IntPtr h) {
        var cls = new System.Text.StringBuilder(64);
        GetClassName(h, cls, 64);
        if (cls.ToString() != "Chrome_WidgetWin_1") return false;
        var t = new System.Text.StringBuilder(256);
        GetWindowText(h, t, 256);
        string title = t.ToString();
        return title == "AgentDeck" || title.EndsWith(") AgentDeck");
    }

    // The AgentDeck window you're using: the one in front, else any that isn't minimized.
    static IntPtr FindDeck() {
        IntPtr fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && IsDeck(fg)) return fg;
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr data) {
            if (IsWindowVisible(h) && !IsIconic(h) && IsDeck(h)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Bounds of the AgentDeck app window, else the window in front.
    public static int[] DeckBounds() {
        IntPtr w = FindDeck();
        if (w == IntPtr.Zero) w = GetForegroundWindow();
        RECT r;
        if (!GetWindowRect(w, out r) || r.Right - r.Left < 200) return null;
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    // A process started in the background may not take the foreground, so borrow the input
    // queue of the window that has it (the AgentDeck window) for a moment.
    public static void BringToFront(IntPtr hwnd) {
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != me && AttachThreadInput(me, fgThread, true);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if (attached) AttachThreadInput(me, fgThread, false);
    }

    public static string Pick(string title, string start, IntPtr owner) {
        IFileDialog dlg = (IFileDialog)new FileOpenDialog();
        dlg.SetOptions(0x20 | 0x40 | 0x800); // pick folders, real file-system paths only, path must exist
        dlg.SetTitle(title);
        dlg.SetOkButtonLabel("Use this folder");
        if (!String.IsNullOrEmpty(start)) {
            try {
                IShellItem folder;
                SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
                dlg.SetFolder(folder);
            } catch { }
        }
        if (dlg.Show(owner) != 0) return "";
        IShellItem result;
        dlg.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
        return path;
    }
}
'@

# An invisible, always-on-top owner window covering the AgentDeck window, so the picker is centred
# over it on the same monitor. Showing it first also uses up the "start hidden" flag Windows can give
# the first window of a background process.
$b = [FolderPicker]::DeckBounds()
if (-not $b) {
    $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $b = @($a.X, $a.Y, $a.Width, $a.Height)
}
$owner = New-Object System.Windows.Forms.Form -Property @{
    TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0
    StartPosition = 'Manual'
    Location = New-Object System.Drawing.Point($b[0], $b[1])
    Size = New-Object System.Drawing.Size($b[2], $b[3])
}
$title = 'Pick the project folder for AgentDeck'
$owner.Show()
[FolderPicker]::BringToFront($owner.Handle)
# Runs inside the picker's message loop: centre the picker as soon as its window exists.
$timer = New-Object System.Windows.Forms.Timer -Property @{ Interval = 15 }
$timer.Add_Tick({ if ([FolderPicker]::CenterOver($title, $b[0], $b[1], $b[2], $b[3])) { $timer.Stop() } })
$timer.Start()
$path = [FolderPicker]::Pick($title, $Start, $owner.Handle)
$timer.Stop()
$owner.Close()
if ($path) { [Console]::Out.Write($path) }
