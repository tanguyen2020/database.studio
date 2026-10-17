// Save a text export: a real Save dialog in the desktop app (WebView2 cannot do a
// browser download), a browser download elsewhere.
import { IS_TAURI } from '$lib/demo'
import * as ipc from '$lib/ipc'
import { download } from '$lib/export/rows'

export async function saveText(filename: string, content: string, ext: string, mime: string): Promise<boolean> {
  if (IS_TAURI) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    if (!path) return false
    await ipc.writeTextFile(path, content)
    return true
  }
  download(filename, content, mime)
  return true
}
