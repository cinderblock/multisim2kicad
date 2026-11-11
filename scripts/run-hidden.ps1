<#
.SYNOPSIS
  Run a command on a private, never-shown Windows desktop.

.DESCRIPTION
  kicad-cli (and pcbnew) can raise wx warning dialogs even in CLI mode. Run
  normally, those land on the user's screen and steal focus. This wrapper
  creates a fresh desktop object (CreateDesktop) that is never switched to
  (no SwitchDesktop call), starts the command there, and watches it from a
  thread bound to that same desktop:

  - every top-level window that appears is logged to stderr as
    "[run-hidden] dialog: <title> | <text...>" and then closed (WM_CLOSE),
    so a modal popup can't hang the run;
  - the command is killed after -TimeoutSec.

  The command's stdout/stderr are redirected to files and replayed on this
  process's stdout/stderr when it exits. Exit code is the command's, or 124
  on timeout.

.EXAMPLE
  pwsh -NoProfile -File scripts/run-hidden.ps1 -- "C:\Program Files\KiCad\10.0\bin\kicad-cli.exe" sch erc out\X.kicad_sch
#>
# No param() block on purpose: the wrapped command's own flags (e.g. a child
# `-Command`) must not be bound as ours. Parse argv by hand: our options come
# first, then `--`, then the command verbatim.
$ErrorActionPreference = 'Stop'
$TimeoutSec = 300
$i = 0
while ($i -lt $args.Count -and $args[$i] -ne '--') {
  if ($args[$i] -eq '-TimeoutSec') { $TimeoutSec = [int]$args[$i + 1]; $i += 2 }
  else { break }
}
if ($i -lt $args.Count -and $args[$i] -eq '--') { $i++ }
$Command = @($args | Select-Object -Skip $i)
if ($Command.Count -eq 0) { [Console]::Error.WriteLine('usage: run-hidden.ps1 [-TimeoutSec N] -- <exe> [args...]'); exit 2 }

if (-not ('EwConv.HiddenRunner' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace EwConv {
public static class HiddenRunner {
  const uint GENERIC_ALL = 0x10000000;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const int STARTF_USESTDHANDLES = 0x100;
  const uint WAIT_TIMEOUT = 0x102;
  const uint WM_CLOSE = 0x0010;
  const int UOI_NAME = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder sb, int len, out int needed);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
      uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa,
      uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static string Text(IntPtr w) { var sb = new StringBuilder(1024); GetWindowText(w, sb, sb.Capacity); return sb.ToString(); }
  static string Cls(IntPtr w) { var sb = new StringBuilder(256); GetClassName(w, sb, sb.Capacity); return sb.ToString(); }

  static IntPtr OpenOut(string path) {
    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
    // GENERIC_WRITE, FILE_SHARE_READ|WRITE, CREATE_ALWAYS, NORMAL
    IntPtr h = CreateFile(path, 0x40000000, 3, ref sa, 2, 0x80, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile " + path);
    return h;
  }

  public static List<string> Dialogs = new List<string>();

  // Returns exit code (124 on timeout). Dialog descriptions are collected in Dialogs.
  public static int Run(string commandLine, string cwd, string stdoutPath, string stderrPath, int timeoutMs, int closeAfterMs) {
    Dialogs.Clear();
    var ws = new StringBuilder(256); int needed;
    GetUserObjectInformation(GetProcessWindowStation(), UOI_NAME, ws, ws.Capacity, out needed);
    string deskName = "ewconv-hidden-" + Guid.NewGuid().ToString("N").Substring(0, 12);
    IntPtr desk = CreateDesktop(deskName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desk == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop");

    IntPtr hOut = OpenOut(stdoutPath), hErr = OpenOut(stderrPath);
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = ws.ToString() + "\\" + deskName;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = hOut; si.hStdError = hErr; si.hStdInput = IntPtr.Zero;
    PROCESS_INFORMATION pi;
    bool ok = CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(hOut); CloseHandle(hErr);
    if (!ok) { CloseDesktop(desk); throw new Win32Exception(err, "CreateProcess"); }

    // Watcher thread: bind to the private desktop (a fresh thread owns no
    // windows, so SetThreadDesktop succeeds), log + close any window.
    var seen = new Dictionary<IntPtr, DateTime>();
    bool stop = false;
    var watcher = new Thread(() => {
      if (!SetThreadDesktop(desk)) { lock (Dialogs) Dialogs.Add("(watcher could not bind to desktop: " + Marshal.GetLastWin32Error() + ")"); return; }
      while (!Volatile.Read(ref stop)) {
        EnumDesktopWindows(desk, (w, l) => {
          if (!IsWindowVisible(w)) return true;
          // Windows creates these UAC input-indicator overlays on every new
          // desktop; they are not the child's and are harmless.
          if (Cls(w).StartsWith("UAC")) return true;
          if (!seen.ContainsKey(w)) {
            seen[w] = DateTime.UtcNow;
            var parts = new List<string>();
            EnumChildWindows(w, (c, l2) => { var t = Text(c); if (t.Length > 0) parts.Add(t.Replace("\r", " ").Replace("\n", " ")); return true; }, IntPtr.Zero);
            lock (Dialogs) Dialogs.Add("[" + Cls(w) + "] " + Text(w) + " | " + string.Join(" | ", parts));
          } else if ((DateTime.UtcNow - seen[w]).TotalMilliseconds >= closeAfterMs) {
            PostMessage(w, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
          }
          return true;
        }, IntPtr.Zero);
        Thread.Sleep(100);
      }
    });
    watcher.IsBackground = true;
    watcher.Start();

    uint code;
    if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) == WAIT_TIMEOUT) {
      TerminateProcess(pi.hProcess, 124);
      WaitForSingleObject(pi.hProcess, 5000);
      code = 124;
    } else {
      GetExitCodeProcess(pi.hProcess, out code);
    }
    Volatile.Write(ref stop, true);
    watcher.Join(2000);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    CloseDesktop(desk);
    return (int)code;
  }
}
}
'@
}

function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  # Windows argv quoting: backslashes before a quote are doubled.
  $s = [regex]::Replace($a, '(\\*)"', { param($m) ($m.Groups[1].Value * 2) + '\"' })
  $s = [regex]::Replace($s, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
  return '"' + $s + '"'
}

$cmdLine = ($Command | ForEach-Object { Quote-Arg $_ }) -join ' '
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'run-hidden-' + [guid]::NewGuid().ToString('N'))
$outFile = "$tmp.out"; $errFile = "$tmp.err"
try {
  $code = [EwConv.HiddenRunner]::Run($cmdLine, (Get-Location).Path, $outFile, $errFile, $TimeoutSec * 1000, 1500)
  if (Test-Path $outFile) { Get-Content -Raw $outFile | ForEach-Object { [Console]::Out.Write($_) } }
  if (Test-Path $errFile) { Get-Content -Raw $errFile | ForEach-Object { [Console]::Error.Write($_) } }
  foreach ($d in [EwConv.HiddenRunner]::Dialogs) { [Console]::Error.WriteLine("[run-hidden] dialog: $d") }
  if ($code -eq 124) { [Console]::Error.WriteLine("[run-hidden] timed out after $TimeoutSec s; killed") }
  exit $code
} finally {
  Remove-Item -ErrorAction SilentlyContinue $outFile, $errFile
}
