// CloudyMouse — two small Windows helpers in one exe.
//
//   1. click watcher   CloudyMouse.exe
//      Installs a low-level mouse hook (WH_MOUSE_LL) and prints one line per
//      button-down:  ready / L 1043 512
//
//   2. topmost guard   CloudyMouse.exe --topmost <hwnd> [--interval <ms>]
//      Watches for foreground changes with a WinEvent hook and re-asserts the
//      given window as topmost on every change plus on a timer. This exists
//      because a JS-timer + setAlwaysOnTop() call is not enough against a
//      fullscreen browser in kiosk mode: the flag can be cleared by the shell
//      and the call can be a no-op when the flag is already set.
//
// Nothing here injects into another process, reads its memory or sends it
// messages. It only asks the window manager to put our own window in front.
//
// Cheap by design: one SetWindowPos per event, and the mouse hook returns
// immediately for everything except button-down.

#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

HWND g_target = nullptr;
UINT g_interval = 50;
bool g_mouse_mode = true;

// ---------------------------------------------------------------- topmost guard

void Raise()
{
  if (!g_target) return;
  if (!IsWindow(g_target)) {
    std::fflush(stdout);
    ExitProcess(0);
  }

  const LONG_PTR style = GetWindowLongPtrW(g_target, GWL_EXSTYLE);
  if (style & WS_EX_TOPMOST) {
    // Already topmost: HWND_TOP moves it to the top of the topmost band, which
    // is what wins the race against another always-on-top window.
    SetWindowPos(g_target, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  } else {
    // The flag was cleared (by the shell, a fullscreen app, or DWM resetting it).
    // Set it again rather than assuming it survived.
    SetWindowPos(g_target, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }
}

void CALLBACK OnForeground(HWINEVENTHOOK, DWORD event, HWND, LONG, LONG, DWORD, DWORD)
{
  if (event == EVENT_SYSTEM_FOREGROUND) Raise();
}

// ---------------------------------------------------------------- click watcher

const char* ButtonName(WPARAM message)
{
  switch (message) {
    case WM_LBUTTONDOWN: return "L";
    case WM_RBUTTONDOWN: return "R";
    case WM_MBUTTONDOWN: return "M";
    case WM_XBUTTONDOWN: return "X";
    default: return nullptr;
  }
}

LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam)
{
  if (code == HC_ACTION) {
    if (const char* name = ButtonName(wParam)) {
      const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
      std::printf("%s %ld %ld\n", name, info->pt.x, info->pt.y);
      std::fflush(stdout);
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

}  // namespace

int main(int argc, char** argv)
{
  UINT intervalFromArgs = 0;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--topmost") == 0 && i + 1 < argc) {
      g_target = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::strtoull(argv[++i], nullptr, 0)));
      g_mouse_mode = false;
    } else if (std::strcmp(argv[i], "--interval") == 0 && i + 1 < argc) {
      intervalFromArgs = static_cast<UINT>(std::atoi(argv[++i]));
    }
  }
  if (intervalFromArgs) g_interval = intervalFromArgs;

  HHOOK hook = nullptr;

  if (g_mouse_mode) {
    hook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, GetModuleHandleW(nullptr), 0);
    if (!hook) {
      std::fprintf(stderr, "hook-failed %lu\n", GetLastError());
      return 2;
    }
    std::printf("ready\n");
    std::fflush(stdout);
  } else {
    if (!g_target || !IsWindow(g_target)) {
      std::fprintf(stderr, "bad-window\n");
      return 2;
    }
    HWINEVENTHOOK watcher = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, OnForeground, 0, 0,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    SetTimer(nullptr, 0, g_interval, [](HWND, UINT, UINT_PTR, DWORD) { Raise(); });
    Raise();
    std::printf("ready\n");
    std::fflush(stdout);
    (void)watcher;  // lives for the process lifetime
  }

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (hook) UnhookWindowsHookEx(hook);
  return 0;
}
