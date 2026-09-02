param(
  [Parameter(Mandatory = $true)]
  [string]$LiteralPath
)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RestartManagerFileOwners
{
    const int ERROR_MORE_DATA = 234;
    const int CCH_RM_SESSION_KEY = 32;

    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(
        uint handle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        IntPtr applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(
        uint handle,
        out uint needed,
        ref uint count,
        [In, Out] RM_PROCESS_INFO[] affectedApps,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint handle);

    public static int[] GetProcessIds(string path)
    {
        uint handle;
        var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
        int result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession failed: " + result);
        try
        {
            result = RmRegisterResources(handle, 1, new[] { path }, 0, IntPtr.Zero, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources failed: " + result);

            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return Array.Empty<int>();
            if (result != ERROR_MORE_DATA) throw new InvalidOperationException("RmGetList failed: " + result);

            var processes = new RM_PROCESS_INFO[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, processes, ref reasons);
            if (result != 0) throw new InvalidOperationException("RmGetList failed: " + result);

            var ids = new List<int>();
            for (int index = 0; index < count; index++) ids.Add(processes[index].Process.dwProcessId);
            return ids.ToArray();
        }
        finally
        {
            RmEndSession(handle);
        }
    }
}
'@

Add-Type -TypeDefinition $source
$ids = [RestartManagerFileOwners]::GetProcessIds(
  [System.IO.Path]::GetFullPath($LiteralPath)
)
ConvertTo-Json -Compress -InputObject @($ids)
