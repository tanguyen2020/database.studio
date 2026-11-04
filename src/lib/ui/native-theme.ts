// Keep the native window's theme in step with the app's Light/Dark choice.
//
// Native pieces are drawn by the OS, not by CSS: the <select> dropdown list
// (a GTK popover on Linux, an NSMenu on macOS), the title bar and the window
// chrome. They follow the WINDOW's appearance, which otherwise stays on the OS
// setting — so a dark app on a light desktop showed a light dropdown list.
// Tauri maps this to GTK's prefer-dark variant (Linux), NSAppearance (macOS)
// and the immersive dark title bar (Windows).
import { IS_TAURI } from '$lib/demo'

export function syncNativeTheme(theme: 'dark' | 'light'): void {
  if (!IS_TAURI) return
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch(() => {
      /* older WebKitGTK / missing permission — CSS still themes the page */
    })
}
