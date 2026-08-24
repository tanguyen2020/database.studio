// Monaco ships its basic-language definitions as plain .js with no types. We
// import three of them to build dialect-flavoured SQL highlighting (see
// $lib/editor/monarch), so declare exactly the two exports they carry.
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.js' {
  import type * as monaco from 'monaco-editor'
  export const conf: monaco.languages.LanguageConfiguration
  export const language: monaco.languages.IMonarchLanguage & { keywords?: string[] }
}

declare module 'monaco-editor/esm/vs/basic-languages/mysql/mysql.js' {
  import type * as monaco from 'monaco-editor'
  export const conf: monaco.languages.LanguageConfiguration
  export const language: monaco.languages.IMonarchLanguage & { keywords?: string[] }
}

declare module 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js' {
  import type * as monaco from 'monaco-editor'
  export const conf: monaco.languages.LanguageConfiguration
  export const language: monaco.languages.IMonarchLanguage & { keywords?: string[] }
}

// Side-effect-only modules (contributions + the editor bundle). They are imported
// dynamically for their registration, never for a value.
declare module 'monaco-editor/esm/vs/editor/editor.all.js'
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
declare module 'monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js'
declare module 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution.js'
declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
