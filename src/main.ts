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

// dark theme is the default; ui store re-applies the persisted choice on boot
document.documentElement.classList.add('dark')

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
