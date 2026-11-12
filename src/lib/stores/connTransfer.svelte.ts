// Export / Import Connections dialogs (one of them open at a time).

class ConnTransferStore {
  mode = $state<'export' | 'import' | null>(null)
  /** Export: connections ticked when the dialog opens (empty = all). */
  preselect = $state<string[]>([])

  openExport(ids: string[] = []) {
    this.preselect = ids
    this.mode = 'export'
  }

  openImport() {
    this.preselect = []
    this.mode = 'import'
  }

  close() {
    this.mode = null
  }
}

export const connTransfer = new ConnTransferStore()
