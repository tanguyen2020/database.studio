import { expect, test } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

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
  await openDatabaseNode(page)
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
  await openDatabaseNode(page)

  // the Security node (native pgAdmin term) sits in the tree
  const node = page.getByText('Login/Group Roles', { exact: true }).first()
  await expect(node).toBeVisible()
  await node.dblclick() // expand → loads roles
  await page.waitForTimeout(400)
  await expect(page.getByText('app_user', { exact: true }).first()).toBeVisible()

  // right-click a principal → Drop role… → in-app confirm
  await page.getByText('app_user', { exact: true }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: /Drop (role|user)…/ }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Drop "app_user"\?/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click() // don't actually drop the demo role
  await page.waitForTimeout(150)

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
  // attributes are editable (toggling queues an ALTER ROLE)
  await page.getByRole('checkbox').first().click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/ALTER ROLE "app_user"/).first()).toBeVisible()

  // drop from the list: right-click a role → Drop role… → in-app confirm
  await page.getByRole('option', { name: /app_user/ }).first().click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.getByRole('menuitem', { name: /Drop role…/ }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Drop role .*app_user.* This cannot be undone/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

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
  await page.getByRole('tab', { name: 'Privileges', exact: true }).click()
  await page.waitForTimeout(200)

  // primary path: the guided "Grant access…" wizard (not the raw matrix)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  await expect(page.getByRole('dialog')).toBeVisible()
  // pick a schema (multi-select) then the Read-only access level
  await page.getByRole('dialog').getByText('public', { exact: true }).click()
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

// #1 — creating a role immediately cues the Grant Access wizard on the new
// principal (grant-right-after-create). We name it after an existing demo role
// so the manager's reload surfaces it and the wizard opens automatically.
test('user manager: creating a role opens the Grant access wizard on it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('button', { name: '+ New Role' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('dialog').locator('input').first().fill('app_user')
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: 'Create login role' }).click()
  await page.waitForTimeout(600)

  // the Grant Access wizard auto-opens, scoped to the just-created role
  await expect(page.getByText('Grant access').first()).toBeVisible()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('app_user', { exact: true }).first()).toBeVisible()

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
  // Access tab: effective permissions grouped by resource (keyspace/table)
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/keyspace app_keyspace/).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Permissions' }).click()
  await page.waitForTimeout(200)
  // guided grant: pick keyspace (resource type) → a TABLE resource + Read-Write
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  const cDlg = page.getByRole('dialog')
  await cDlg.locator('label').filter({ hasText: 'public' }).first().click() // keyspace → loads its tables
  await page.waitForTimeout(400)
  await cDlg.getByText('public.students_by_id', { exact: true }).click() // TABLE resource
  await cDlg.getByText('Read-Write', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT MODIFY ON TABLE public\.students_by_id TO app_role/).first()).toBeVisible()

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
  await openDatabaseNode(page) // tree starts collapsed
  await page.getByText('public', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  await expect(page.getByRole('option', { name: /APP_USER/ }).first()).toBeVisible()
  await page.getByRole('option', { name: /APP_USER/ }).first().click()
  await page.waitForTimeout(150)

  // Access tab: system privileges + roles + object privileges by schema
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText('System privileges', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('CREATE SESSION', { exact: true }).first()).toBeVisible()

  // System Privileges tab → toggle a priv queues GRANT ... TO APP_USER
  await page.getByRole('tab', { name: 'System Privileges' }).click()
  await page.waitForTimeout(150)
  await page.getByText('CREATE TABLE', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT CREATE TABLE TO APP_USER/).first()).toBeVisible()

  // Object Privileges: unified Grant access wizard (Schema owner → object → level)
  await page.getByRole('tab', { name: 'Object Privileges' }).click()
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  const oraDlg = page.getByRole('dialog')
  await oraDlg.locator('label').filter({ hasText: 'APP_USER' }).first().click() // pick owner schema
  await page.waitForTimeout(400) // objects load
  await oraDlg.getByText('APP_USER.students', { exact: true }).click()
  await oraDlg.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON APP_USER\.STUDENTS TO APP_USER/).first()).toBeVisible()

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

  // Access tab: roles per database (native Mongo RBAC), with plain-language capability
  await page.getByRole('option', { name: /app@appdb/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText('readWrite', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/read \+ write all non-system collections/).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Roles per Database' }).click()
  await page.waitForTimeout(150)
  // Quick grant: friendly access level → built-in role, applied to many databases
  await expect(page.getByText('＋ Grant access', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Read-Write', exact: true }).click()
  await page.waitForTimeout(100)
  await expect(page.getByText(/Grant readWrite on/).first()).toBeVisible()

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
  // Access tab: per-database access types from system.grants
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText('analytics', { exact: true }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Grants' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  // Database → Table: pick database "public", then whole database (public.*), Read-only
  const chGrant = page.getByRole('dialog')
  await chGrant.locator('label').filter({ hasText: 'public' }).first().click()
  await page.waitForTimeout(400)
  await chGrant.getByText('public.*', { exact: true }).click()
  await chGrant.getByText('Read-only', { exact: true }).first().click()
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
  await openDatabaseNode(page) // tree starts collapsed
  await page.getByText('public', { exact: true }).first().click() // demo schema node
  await page.waitForTimeout(200)
  await page.getByTitle(/Users & privileges: /).click()
  await page.waitForTimeout(500)

  // Server scope: logins list
  await expect(page.getByRole('option', { name: /app_login/ }).first()).toBeVisible()
  // New Login button (server scope)
  await expect(page.getByRole('button', { name: '+ New Login' })).toBeVisible()

  // Access across databases (server scope): db roles + permissions per database
  await page.getByRole('option', { name: /app_login/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: 'Load access' }).click()
  await page.waitForTimeout(400)
  await expect(page.getByText('db_datareader', { exact: true }).first()).toBeVisible()

  // switch to the database level (SSMS: Database → Security → Users). The tab
  // toggle is the first match (a "Database users tab →" link also exists).
  await page.getByRole('button', { name: /Database users/ }).first().click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('option', { name: /app_user/ }).first()).toBeVisible()
  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  // guided grant: grouped by SCHEMA — the "public" schema section lists its
  // objects (+ "*" whole schema). Grant action + whole schema + Read-only.
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(500) // objects load per schema
  const msDlg = page.getByRole('dialog')
  await msDlg.getByText('*', { exact: true }).first().click() // "*" = whole public schema
  await msDlg.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON SCHEMA::\[public\] TO \[app_user\]/).first()).toBeVisible()
  // DENY is now a first-class action (no longer hidden in a right-click)
  await msDlg.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/DENY SELECT ON SCHEMA::\[public\] TO \[app_user\]/).first()).toBeVisible()
  // object-level: pick a specific object in the schema group → grant on OBJECT
  await msDlg.getByRole('button', { name: 'Grant', exact: true }).click()
  await msDlg.getByText('students', { exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON \[public\]\.\[students\] TO \[app_user\]/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Add to pending' }).click()
  await page.waitForTimeout(150)

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
  // Access tab: what the account can access, per database (server-wide grants)
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText('library_db', { exact: true }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Schema Privileges' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  // Database → Table: pick database "public", then whole database (public.*), Read-only
  const myGrant = page.getByRole('dialog')
  await myGrant.locator('label').filter({ hasText: 'public' }).first().click()
  await page.waitForTimeout(400)
  await myGrant.getByText('public.*', { exact: true }).click()
  await myGrant.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/GRANT SELECT ON `public`\.\* TO 'app'@'%'/).first()).toBeVisible()
  // table-level: a specific table → ON `public`.`students`
  await myGrant.getByText('public.students', { exact: true }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/GRANT SELECT ON `public`\.`students` TO 'app'@'%'/).first()).toBeVisible()
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

  // pick a role in the create popup → separate GRANT statement in the preview
  await page.getByRole('dialog').getByPlaceholder('pick roles to grant…').click()
  await page.waitForTimeout(150)
  await page.getByRole('dialog').getByRole('option', { name: 'read_only' }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/GRANT 'read_only' TO 'spec'@'%'/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// Creating a user/role can assign role membership in the SAME popup (real-world
// parity): PostgreSQL folds it into CREATE ROLE (IN ROLE …).
test('user manager: PG create popup assigns role membership (IN ROLE)', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('button', { name: '+ New Role' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('dialog').locator('input').first().fill('spec_user')
  await page.waitForTimeout(150)
  // pick an existing role in "Member of (roles)" → CREATE ROLE … IN ROLE "…"
  await page.getByRole('dialog').getByPlaceholder('grant role membership…').click()
  await page.waitForTimeout(150)
  await page.getByRole('dialog').getByRole('option', { name: 'readonly_group' }).click()
  await page.waitForTimeout(150)
  await expect(page.getByText(/CREATE ROLE "spec_user".*IN ROLE "readonly_group"/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// PG grant wizard can target MULTIPLE databases at once: the same schema grants
// are queued per selected database (run on a sub-connection to each).
test('user manager: PG Grant access spans multiple databases', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Privileges', exact: true }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '＋ Grant access…' }).click()
  await page.waitForTimeout(300)
  const dialog = page.getByRole('dialog')

  // the Databases step is present (current DB "app" pre-selected); also pick "analytics"
  await expect(dialog.getByText('Databases', { exact: false }).first()).toBeVisible()
  await dialog.getByText('analytics', { exact: true }).click()
  await page.waitForTimeout(400)
  // schemas are grouped PER database → analytics' OWN "reporting" schema appears
  // in the analytics group (structure, not a flat union)
  await expect(dialog.getByText('reporting', { exact: true }).first()).toBeVisible()
  // pick analytics' "reporting" schema (unique to that database) + Read-only
  await dialog.getByText('reporting', { exact: true }).click()
  await page.getByText('Read-only', { exact: true }).first().click()
  await page.waitForTimeout(200)

  // preview groups the SQL per database, with reporting under analytics
  await expect(page.getByText(/-- database: analytics/).first()).toBeVisible()
  await expect(page.getByText(/GRANT SELECT ON ALL TABLES IN SCHEMA "reporting" TO "app_user"/).first()).toBeVisible()

  // Add to pending → the non-current DB is tagged in the pending preview
  await page.getByRole('button', { name: 'Add to pending' }).click()
  await page.waitForTimeout(200)
  await expect(page.getByText(/Pending changes/).first()).toBeVisible()
  await expect(page.getByText(/-- database: analytics/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})

// The Access tab shows, for the selected role, every database → schema and the
// concrete privileges it holds there (read from each database).
test('user manager: PG Access tab lists per-database schema privileges', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await blockRemoteFonts(page)
  await openManager(page)

  await page.getByRole('option', { name: /app_user/ }).first().click()
  await page.waitForTimeout(150)
  await page.getByRole('tab', { name: 'Access', exact: true }).click()
  await page.waitForTimeout(500)

  // every database on the server is listed…
  await expect(page.getByText('app', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('analytics', { exact: true }).first()).toBeVisible()
  // …with the schema and the concrete privilege the role holds there
  await expect(page.getByText('public', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/SELECT ×\d+/).first()).toBeVisible()

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([])
})
