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

// Apply the persisted theme BEFORE first paint (no flash). localStorage is
// synchronous and survives restart in both the desktop WebView and the browser,
// so the chosen Light/Dark shows immediately; the ui store later reconciles with
// the backend app_state. Dark is the default when nothing was saved.
document.documentElement.classList.toggle('dark', localStorage.getItem('theme') !== 'light')

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
