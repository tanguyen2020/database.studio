import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// dark theme is the default; ui store re-applies the persisted choice on boot
document.documentElement.classList.add('dark')

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
