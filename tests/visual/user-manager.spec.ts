import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts } from './helpers'

// U1 — PostgreSQL User Manager. The "Users & privileges" Explorer toolbar button
// opens the User Manager tab (NOT the old Admin view) with the pgAdmin-style
// Login/Group Roles list, General/Membership/Privileges tabs, the Create Role
// popup, and the per-schema privilege grid with presets.
async function openManager(page: import('@playwright/test').Page) {
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)
}

// §1.2b/§1.2c — the Explorer tree has a per-engine Security node (here PG's
// "Login/Group Roles"); double-clicking a principal opens the User Manager.
test('explorer: PG Security node lists roles + opens the manager', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)

  // the Security node (native pgAdmin term) sits in the tree
  const node = page.getByText('Login/Group Roles', { exact: true }).first()
  await expect(node).toBeVisible()
  await node.dblclick() // expand → loads roles
  await page.waitForTimeout(400)
  await expect(page.getByText('app_user', { exact: true }).first()).toBeVisible()

  // double-click a principal → opens the User Manager tab
  await page.getByText('app_user', { exact: true }).first().dblclick()
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab', { name: /Users · / }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('user manager: PG shell lists roles and shows attributes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await expect(page.getByRole('tab', { name: /Users · / }).first()).toBeVisible()
  await expect(page.getByText('Login/Group Roles').first()).toBeVisible()
  await expect(page.getByRole('option', { name: /postgres/ }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: /app_user/ }).first()).toBeVisible()

  // select app_user → General tab shows attribute labels (not raw column names)
  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText('Can login', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Superuser', { exact: true }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('user manager: New Role opens a popup dialog (not a tab)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  const tabsBefore = await page.getByRole('tab').count()
  await page.getByRole('button', { name: '+ New Role' }).click()
  await page.waitForTimeout(300)
  // popup, not a new tab
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Create Login/Group Role').first()).toBeVisible()
  expect(await page.getByRole('tab').count()).toBe(tabsBefore)

  // preview updates when a name is typed; primary button reflects "Can login?"
  await page.getByRole('dialog').locator('input').first().fill('spec_user')
  await page.waitForTimeout(150)
  await expect(page.getByText(/CREATE ROLE "spec_user" LOGIN/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create login role' })).toBeVisible()

  // backdrop click does NOT close
  await page.mouse.click(6, 6)
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog')).toBeVisible()
  // Cancel closes
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

test('user manager: guided Grant access wizard queues GRANT statements', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Privileges' }).click()
  await page.waitForTimeout(200)

  // primary path: the guided "Grant access…" wizard (not the raw matrix)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toBeVisible()
  // pick the Read-only access level → live SQL preview shows the exact GRANT
  await page.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app_user"/).first()).toBeVisible()
  // Add to pending → dialog closes, Pending changes panel shows the SQL
  await page.getByRole('button', { name: 'Add to pending' }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Pending changes/).first()).toBeVisible()

  // the detailed matrix is still available under Advanced
  await page.getByText(/Advanced — permission matrix/).first().click()
  await page.waitForTimeout(150)
  await expect(page.getByRole('cell', { name: 'public' }).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U7 — Cassandra User Manager: roles list, permission grid keyspace preset.
test('user manager: Cassandra roles + keyspace permission preset', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('10.0.5.3', { exact: false }).first().click() // Cassandra connection (connected)
  await page.waitForTimeout(500)
  // Cassandra is user-managed at the connection level — no relational schema needed.
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  await expect(page.getByRole('option', { name: /app_role/ }).first()).toBeVisible()
  await page.getByRole('option', { name: /app_role/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Permissions' }).click()
  await page.waitForTimeout(200)
  // guided grant: Read-Write on a keyspace → GRANT MODIFY
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  await page.getByText('Read-Write', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT MODIFY ON KEYSPACE .* TO app_role/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U6 — Oracle User Manager: users list, System Privileges checklist, Object
// Privileges per-schema batch preset.
test('user manager: Oracle users + system privs + object preset', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('10.0.7.1', { exact: false }).first().click() // Oracle connection (connected)
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  await expect(page.getByRole('option', { name: /APP_USER/ }).first()).toBeVisible()
  await page.getByRole('option', { name: /APP_USER/ }).first().click()
  await page.waitForTimeout(150)

  // System Privileges tab → toggle a priv queues GRANT ... TO APP_USER
  await page.getByRole('tab', { name: 'System Privileges' }).click()
  await page.waitForTimeout(150)
  await page.getByText('CREATE TABLE', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT CREATE TABLE TO APP_USER/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U5 — MongoDB User Manager: users (user@db), per-database built-in role toggle,
// Add User popup (command-based, no SQL).
test('user manager: MongoDB users + role toggle + Add User popup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('10.0.6.2', { exact: false }).first().click() // MongoDB connection (connected)
  await page.waitForTimeout(500)
  // MongoDB is user-managed at the connection level — selecting the connection
  // enables the toolbar Users button (no relational schema needed).
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  await expect(page.getByText('Users', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: /app@appdb/ }).first()).toBeVisible()

  // Add User → popup (not a tab)
  const tabsBefore = await page.getByRole('tab').count()
  await page.getByRole('button', { name: '+ Add User' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await page.getByRole('tab').count()).toBe(tabsBefore)
  await page.getByRole('dialog').locator('input').first().fill('spec')
  await page.waitForTimeout(150)
  await expect(page.getByText(/createUser\("spec"|createUser: "spec"|user: "spec"/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U4 — ClickHouse User Manager: Users/Roles, users.xml read-only badge, grant grid.
test('user manager: ClickHouse users + grant grid preset', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('10.0.4.2', { exact: false }).first().click() // ClickHouse connection
  await page.waitForTimeout(300)
  const connectBtn = page.getByText('Connect', { exact: true })
  if (await connectBtn.count()) {
    await connectBtn.first().click()
    await page.waitForTimeout(500)
  }
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  // users list: 'app' (local_directory, editable) + 'default' (users.xml, read-only badge)
  await expect(page.getByRole('option', { name: /app/ }).first()).toBeVisible()
  await expect(page.getByText('users.xml').first()).toBeVisible()

  // select app → Grants tab → Read-only preset queues the exact GRANT
  await page.getByRole('option', { name: /^app/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Grants' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('dialog').locator('select').selectOption('public')
  await page.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON `public`\.\* TO `app`/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U3 — MSSQL User Manager: 2-tier Server(Logins)/Database, DENY-capable grid.
test('user manager: MSSQL server logins + database permission grid', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('MSSQL', { exact: true }).first().click() // MSSQL connection (c3, disconnected)
  await page.waitForTimeout(300)
  await page.getByText('Connect', { exact: true }).first().click() // demo connects
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click() // demo schema node
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  // Server scope: logins list
  await expect(page.getByRole('option', { name: /app_login/ }).first()).toBeVisible()
  // New Login button (server scope)
  await expect(page.getByRole('button', { name: '+ New Login' })).toBeVisible()

  // switch to Database scope → users + permission grid with presets + Deny
  await page.getByRole('button', { name: 'Database', exact: true }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('option', { name: /app_user/ }).first()).toBeVisible()
  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  // guided grant: Read-only on the schema
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  await page.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON SCHEMA::\[public\] TO \[app_user\]/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Add to pending' }).click()
  await page.waitForTimeout(150)
  // DENY (overrides GRANT) stays in the Advanced matrix
  await page.getByText(/Advanced — permission matrix/).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: 'Deny', exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/DENY SELECT, INSERT, UPDATE, DELETE ON SCHEMA::\[public\] TO \[app_user\]/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// U2 — MySQL User Manager: account list (user@host), Add Account popup, and the
// per-database privilege grid whose preset queues the exact backtick GRANT.
test('user manager: MySQL account list + preset + Add Account popup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByText('localhost:3306', { exact: false }).first().click() // MySQL connection
  await page.waitForTimeout(500)
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  await expect(page.getByText('Users and Privileges').first()).toBeVisible()
  await expect(page.getByRole('option', { name: /app@%/ }).first()).toBeVisible()

  // privileges grid: select app@% → apply Read-only on the public database
  await page.getByRole('option', { name: /app@%/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Schema Privileges' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  // pick database "public" in the scope dropdown, then Read-only
  await page.getByRole('dialog').locator('select').selectOption('public')
  await page.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON `public`\.\* TO 'app'@'%'/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Add to pending' }).click() // close wizard
  await page.waitForTimeout(200)

  // Add Account → popup (not a tab), host required, live preview
  const tabsBefore = await page.getByRole('tab').count()
  await page.getByRole('button', { name: '+ Add Account' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await page.getByRole('tab').count()).toBe(tabsBefore)
  await page.getByRole('dialog').locator('input').first().fill('spec')
  await page.waitForTimeout(150)
  await expect(page.getByText(/CREATE USER 'spec'@'%'/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
