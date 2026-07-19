<script lang="ts">
  // Guided "Grant access" wizard (UX). Popup shared by every engine's User
  // Manager: shows the selected role, a scope picker, and access-level cards.
  // Picking a level builds the statements (engine callback) and shows a live SQL
  // preview; Apply hands them to the manager's Pending changes (then Execute).
  import { untrack } from 'svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = grantWizard.open
  })

  // Multi-select scopes: granting a user/role commonly spans many databases/
  // schemas, so scope is a checkbox set (not a single dropdown).
  let selected = $state<Set<string>>(new Set())
  let level = $state('')
  let filter = $state('')
  // Optional outer scope (PostgreSQL databases) — a second checkbox set.
  let selected2 = $state<Set<string>>(new Set())

  const hasScope2 = $derived(grantWizard.scope2Label != null && grantWizard.scopes2.length > 0)

  // Inner scopes (schemas). When the engine provides loadScopes, the list is
  // loaded from the selected databases; otherwise it's the static scopes.
  let dynamicScopes = $state<string[] | null>(null)
  let loadingScopes = $state(false)
  const effectiveScopes = $derived(dynamicScopes ?? grantWizard.scopes)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      selected = new Set()
      level = ''
      filter = ''
      selected2 = new Set(grantWizard.scope2Default)
      dynamicScopes = grantWizard.loadScopes ? [] : null
    }
    wasOpen = dlgOpen
  })

  // Refresh the schema list when the database selection changes (per-database
  // schemas). Prune any selected schema that no longer exists in the new list.
  $effect(() => {
    if (!dlgOpen || !grantWizard.loadScopes) return
    const dbs = [...selected2]
    const loader = grantWizard.loadScopes
    loadingScopes = true
    loader(dbs)
      .then((s) => {
        dynamicScopes = s
        untrack(() => (selected = new Set([...selected].filter((x) => s.includes(x)))))
      })
      .catch(() => (dynamicScopes = []))
      .finally(() => (loadingScopes = false))
  })

  const shownScopes = $derived(
    filter.trim() ? effectiveScopes.filter((s) => s.toLowerCase().includes(filter.trim().toLowerCase())) : effectiveScopes,
  )
  const allShownSelected = $derived(shownScopes.length > 0 && shownScopes.every((s) => selected.has(s)))
  function toggleScope(s: string) {
    const next = new Set(selected)
    next.has(s) ? next.delete(s) : next.add(s)
    selected = next
  }
  function toggleAllShown() {
    const next = new Set(selected)
    if (allShownSelected) shownScopes.forEach((s) => next.delete(s))
    else shownScopes.forEach((s) => next.add(s))
    selected = next
  }
  function toggleScope2(s: string) {
    const next = new Set(selected2)
    next.has(s) ? next.delete(s) : next.add(s)
    selected2 = next
  }

  // build one access level across EVERY selected inner scope (schema).
  const statements = $derived.by<string[]>(() => {
    if (!selected.size || !level) return []
    const out: string[] = []
    for (const s of effectiveScopes) {
      if (selected.has(s)) {
        try {
          out.push(...grantWizard.build(level, s))
        } catch {
          /* skip a scope that fails to build */
        }
      }
    }
    return out
  })

  // when an outer scope (databases) is in play, the SAME statements run per
  // selected database (schema-grant SQL carries no database qualifier).
  const groups = $derived.by<{ db: string; statements: string[] }[]>(() =>
    !hasScope2 || !statements.length
      ? []
      : grantWizard.scopes2.filter((d) => selected2.has(d)).map((db) => ({ db, statements })),
  )
  // can apply? (scope2 requires at least one database picked too)
  const canApply = $derived(hasScope2 ? statements.length > 0 && selected2.size > 0 : statements.length > 0)
  // preview text (grouped by database when scope2 is active)
  const previewGrouped = $derived.by<string>(() =>
    groups.map((g) => `-- database: ${g.db}\n${g.statements.map((s) => s + ';').join('\n')}`).join('\n\n'),
  )

  // Warn on broad/destructive grants so a stray click can't over-privilege.
  const warning = $derived.by<string | null>(() => {
    if (!selected.size || !level) return null
    const wide = [...selected].some((s) => /\*|all /i.test(s)) || selected.size >= 5
    if (level === 'revoke-all') return `This removes ALL access on ${selected.size} ${grantWizard.scopeLabel.toLowerCase()}(s).`
    if (level === 'full') return `This grants FULL privileges on ${selected.size} ${grantWizard.scopeLabel.toLowerCase()}(s).`
    if (wide) return `Applies to ${selected.size} ${grantWizard.scopeLabel.toLowerCase()}(s).`
    return null
  })

  function apply() {
    if (!canApply) return
    if (hasScope2 && grantWizard.onApplyGrouped) {
      grantWizard.onApplyGrouped(groups.map((g) => ({ scope2: g.db, statements: g.statements })))
    } else {
      grantWizard.onApply(statements)
    }
    grantWizard.close()
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && grantWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && grantWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">{grantWizard.title}</span>
        <span onclick={() => grantWizard.close()} onkeydown={(e) => e.key === 'Enter' && grantWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-14)">
        <!-- step 1: role (context) -->
        <div style="display:flex;align-items:center;gap:var(--px-8)">
          <span style="font-size:var(--px-11);color:var(--muted);width:var(--px-70)">1 · Role</span>
          <span class="mono" style="font-size:var(--px-13);font-weight:600;color:var(--text);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-10)">{grantWizard.role}</span>
        </div>
        {#if hasScope2}
          <!-- outer scope (databases) — apply to each selected one -->
          <div style="display:flex;flex-direction:column;gap:var(--px-6)">
            <div style="display:flex;align-items:center;gap:var(--px-8)">
              <span style="font-size:var(--px-11);color:var(--muted)">2 · {grantWizard.scope2Label}s</span>
              <span style="font-size:var(--px-11);color:var(--text2)">— pick one or more ({selected2.size} selected)</span>
            </div>
            <div style="max-height:var(--px-120);overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-6) var(--px-8);display:flex;flex-direction:column;gap:var(--px-2)">
              {#each grantWizard.scopes2 as d (d)}
                <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6);cursor:pointer">
                  <input type="checkbox" checked={selected2.has(d)} onchange={() => toggleScope2(d)} /> <span class="mono">{d}</span>
                </label>
              {/each}
            </div>
            <span style="font-size:var(--px-10_5);color:var(--muted)">The same schema grants run in each selected {grantWizard.scope2Label?.toLowerCase()} (via a connection to it).</span>
          </div>
        {/if}
        <!-- scope (multi-select) -->
        <div style="display:flex;flex-direction:column;gap:var(--px-6)">
          <div style="display:flex;align-items:center;gap:var(--px-8)">
            <span style="font-size:var(--px-11);color:var(--muted)">{hasScope2 ? '3' : '2'} · {grantWizard.scopeLabel}s</span>
            <span style="font-size:var(--px-11);color:var(--text2)">— pick one or more ({selected.size} selected)</span>
            <span onclick={toggleAllShown} onkeydown={(e) => e.key === 'Enter' && toggleAllShown()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-11);color:var(--primary);cursor:pointer">{allShownSelected ? 'Clear all' : 'Select all'}</span>
          </div>
          {#if effectiveScopes.length > 6}
            <input bind:value={filter} placeholder="Filter {grantWizard.scopeLabel.toLowerCase()}s…" class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-12)" />
          {/if}
          <div style="max-height:var(--px-180);overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-6) var(--px-8);display:flex;flex-direction:column;gap:var(--px-2)">
            {#each shownScopes as s (s)}
              <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6);cursor:pointer">
                <input type="checkbox" checked={selected.has(s)} onchange={() => toggleScope(s)} /> <span class="mono">{s}</span>
              </label>
            {:else}
              <span style="font-size:var(--px-11_5);color:var(--muted)">{loadingScopes ? 'Loading schemas…' : hasScope2 && !selected2.size ? `Pick a ${grantWizard.scope2Label?.toLowerCase()} first.` : `No ${grantWizard.scopeLabel.toLowerCase()}s.`}</span>
            {/each}
          </div>
        </div>
        <!-- access level cards -->
        <div>
          <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-6)">{hasScope2 ? '4' : '3'} · Access level</div>
          <div style="display:flex;flex-direction:column;gap:var(--px-6)">
            {#each grantWizard.levels as lv (lv.kind)}
              <label style="display:flex;align-items:flex-start;gap:var(--px-8);padding:var(--px-8) var(--px-10);border:var(--px-1) solid {level === lv.kind ? (lv.danger ? 'var(--error)' : 'var(--primary)') : 'var(--border)'};border-radius:var(--px-8);cursor:pointer;background:{level === lv.kind ? 'var(--panel)' : 'transparent'}">
                <input type="radio" name="grant-level" value={lv.kind} bind:group={level} style="margin-top:var(--px-2)" />
                <div style="display:flex;flex-direction:column;gap:var(--px-1)">
                  <span style="font-size:var(--px-13);font-weight:600;color:{lv.danger ? 'var(--error)' : 'var(--text)'}">{lv.label}</span>
                  <span style="font-size:var(--px-11);color:var(--muted)">{lv.desc}</span>
                </div>
              </label>
            {/each}
          </div>
        </div>
        <!-- preview -->
        <div>
          <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-4)">SQL to run</div>
          <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-150);overflow:auto;white-space:pre-wrap">{#if hasScope2}{#if canApply}{#each highlightSql(previewGrouped + '\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{:else}<span style="color:var(--muted)">-- pick {grantWizard.scope2Label?.toLowerCase()}(s), {grantWizard.scopeLabel.toLowerCase()}(s) and an access level</span>{/if}{:else if statements.length}{#each statements as s (s)}{#each highlightSql(s + ';\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{/each}{:else}<span style="color:var(--muted)">-- pick one or more {grantWizard.scopeLabel.toLowerCase()}s and an access level</span>{/if}</pre>
        </div>
      </div>
      {#if warning}
        <div style="flex:none;padding:var(--px-6) var(--px-18);background:var(--panel);border-top:var(--px-1) solid var(--border);color:var(--warn2);font-size:var(--px-11_5)">⚠ {warning}</div>
      {/if}
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => grantWizard.close()} onkeydown={(e) => e.key === 'Enter' && grantWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={apply} onkeydown={(e) => e.key === 'Enter' && apply()} role="button" tabindex="0" aria-disabled={!canApply} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{canApply ? 'pointer' : 'not-allowed'};opacity:{canApply ? 1 : 0.5};font-weight:600">Add to pending</span>
      </div>
    </div>
  </div>
{/if}
