// CloudyMouse — global mouse click watcher.
//
// Prints one line per button-down and nothing else:
//
//   ready
//   L 1043 512
//   R 88 40
//
// The parent process counts clicks and decides what a burst means. Keeping the
// helper dumb means a bug here cannot make the app do something unexpected.
//
// Low-level mouse hook (WH_MOUSE_LL). Requirements this does not change:
//   - the hook only sees input that Windows is willing to route to this
//     integrity level. Clicks aimed at an elevated (admin) window are invisible.
//   - a hook is called on the thread that installed it, so the message loop
//     below is mandatory, not decorative.
//   - the procedure must return fast. It prints only on button-down and ignores
//     every move event, which is what keeps system-wide mouse latency normal.

#include <windows.h>
#include <cstdio>

namespace {

HHOOK g_hook = nullptr;

const char* ButtonName(WPARAM message) {
  switch (message) {
    case WM_LBUTTONDOWN:
      return "L";
    case WM_RBUTTONDOWN:
      return "R";
    case WM_MBUTTONDOWN:
      return "M";
    case WM_XBUTTONDOWN:
      return "X";
    default:
      return nullptr;
  }
}

LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const char* name = ButtonName(wParam);
    if (name) {
      const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
      std::printf("%s %ld %ld\n", name, info->pt.x, info->pt.y);
      std::fflush(stdout);
    }
  }
  return CallNextHookEx(g_hook, code, wParam, lParam);
}

}  // namespace

int main() {
  // stdout is a pipe owned by the app; make sure a closed pipe ends us instead
  // of crashing on a printf.
  SetConsoleOutputCP(CP_UTF8);

  g_hook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, GetModuleHandleW(nullptr), 0);
  if (!g_hook) {
    std::fprintf(stderr, "hook-failed %lu\n", GetLastError());
    return 2;
  }

  std::printf("ready\n");
  std::fflush(stdout);

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  UnhookWindowsHookEx(g_hook);
  return 0;
}
