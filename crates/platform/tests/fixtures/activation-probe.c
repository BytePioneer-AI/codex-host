/* Disposable MSIX fixture: validate Job membership in an imported DLL's
   process-attach callback, before the executable's TLS/CRT/main can spawn. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
static int checked = 0;
__declspec(dllexport) int codexhost_probe_ran(void) { return checked; }
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    const wchar_t *marker;
    wchar_t name[80] = L"Local\\codexhost-activation-";
    const wchar_t *prefix = L"--codexhost-activation=";
    HANDLE job;
    BOOL member = FALSE;
    size_t index, offset;
    UNREFERENCED_PARAMETER(instance);
    UNREFERENCED_PARAMETER(reserved);
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    checked = 1;
    marker = wcsstr(GetCommandLineW(), prefix);
    if (!marker) return TRUE; /* independent package activation remains normal */
    marker += wcslen(prefix);
    if (wcslen(marker) < 32) ExitProcess(196);
    offset = wcslen(name);
    for (index = 0; index < 32; index++) name[offset + index] = marker[index];
    job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name);
    if (!job || !IsProcessInJob(GetCurrentProcess(), job, &member) || !member) ExitProcess(196);
    CloseHandle(job);
    return TRUE;
}
