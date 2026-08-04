import { mount } from 'svelte'
// Self-hosted JetBrains Mono (DataGrip's grid/editor font) — bundled by Vite so
// the Result Grid & code editor render in it regardless of what's installed
// locally. Weights match `.mono` usage (values 400/500, headers 600/700).
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './app.css'
import App from './App.svelte'
import { IS_TAURI } from '$lib/demo'
import { installNativeMenuGuard } from '$lib/ui/native-menu'
import { installWebViewKeyGuard } from '$lib/ui/webview-keys'

// Apply the persisted theme BEFORE first paint (no flash). localStorage is
// synchronous and survives restart in both the desktop WebView and the browser,
// so the chosen Light/Dark shows immediately; the ui store later reconciles with
// the backend app_state. Dark is the default when nothing was saved.
document.documentElement.classList.toggle('dark', localStorage.getItem('theme') !== 'light')

// Desktop only: kill the WebView's browser page menu (Back/Refresh/Save as/Print/…)
// so right-click shows the app's own menus. The browser build (demo + Playwright)
// keeps the native menu; `?lockMenu=1` is a test seam so Playwright can prove the
// app's own right-click menus still open with the guard installed.
if (IS_TAURI || location.search.includes('lockMenu=1')) installNativeMenuGuard()

// Browser-chrome shortcuts (Ctrl+R / F5 reload, Ctrl+S save-as, Ctrl+P print,
// Ctrl+U view-source, F12 devtools) — blocked in the RELEASE desktop build only, so
// `tauri dev` keeps Ctrl+R reload for the dev loop. `?lockKeys=1` is a test seam that
// lets the browser build exercise the same guard (see webview-keys.spec.ts).
if ((IS_TAURI && import.meta.env.PROD) || location.search.includes('lockKeys=1')) {
  installWebViewKeyGuard()
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
