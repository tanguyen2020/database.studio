import { expect, test, type Page } from '@playwright/test'
import { APP_URL, blockRemoteFonts, openDatabaseNode } from './helpers'

// Generate Scripts must carry every index of a table: the PRIMARY KEY and UNIQUE
// constraints inside CREATE TABLE, every other index as CREATE INDEX right after
// the tables (before the foreign keys that may need them). The demo answers
// list_index_ddl with the shapes a PostgreSQL catalog returns.

async function openWizard(page: Page, query = '') {
  await blockRemoteFonts(page)
  await page.goto(APP_URL + query)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByRole('treeitem', { name: /public/ }).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Generate Scripts…' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Generate Scripts' })
  await expect(dialog.getByRole('group', { name: 'Tables' })).toBeVisible()
  return dialog
}

async function generate(page: Page, dialog: ReturnType<Page['getByRole']>): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Generate', exact: true }).click()])
  const fs = await import('node:fs')
  return fs.readFileSync((await dl.path())!, 'utf8')
}

/** The CREATE TABLE statement of one table, up to its closing `);`. */
function createOf(sql: string, table: string): string {
  const i = sql.indexOf(`CREATE TABLE "public"."${table}"`)
  expect(i, `CREATE TABLE ${table} in the script`).toBeGreaterThanOrEqual(0)
  return sql.slice(i, sql.indexOf(');', i) + 2)
}

test('structure: PRIMARY KEY / UNIQUE inside CREATE TABLE, every other index after the tables', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const dialog = await openWizard(page)
  const sql = await generate(page, dialog)

  const students = createOf(sql, 'students')
  expect(students).toContain('CONSTRAINT students_pkey PRIMARY KEY (id)')
  expect(students).toContain('CONSTRAINT students_email_key UNIQUE (email)')
  // the key is the catalog's clause — no second, inline PRIMARY KEY
  expect(students.match(/PRIMARY KEY/g)?.length).toBe(1)

  // a key over two columns: one table-level clause
  expect(createOf(sql, 'enrollments')).toContain('CONSTRAINT enrollments_pkey PRIMARY KEY (student_id, course_id)')

  // every other index, exactly as the catalog states it (DESC, expression, WHERE, INCLUDE)
  const statements = [
    'CREATE INDEX idx_students_gpa ON public.students USING btree (gpa DESC NULLS LAST);',
    'CREATE INDEX idx_students_name_lower ON public.students USING btree (lower((last_name)::text)) WHERE is_active;',
    'CREATE INDEX idx_enrollments_course ON public.enrollments USING btree (course_id) INCLUDE (grade);',
  ]
  const lastCreate = sql.lastIndexOf('CREATE TABLE')
  const firstFk = sql.indexOf('FOREIGN KEY')
  for (const s of statements) {
    const at = sql.indexOf(s)
    expect(at, s).toBeGreaterThan(lastCreate)
    expect(at, `${s} before the foreign keys`).toBeLessThan(firstFk)
  }
  expect(errors).toEqual([])
})

test('data only: no index statements', async ({ page }) => {
  const dialog = await openWizard(page)
  await dialog.getByRole('radiogroup', { name: 'Script content' }).getByRole('radio', { name: /Data only/ }).click()
  const sql = await generate(page, dialog)
  expect(sql).not.toContain('CREATE INDEX')
  expect(sql).not.toContain('PRIMARY KEY')
})

test('indexes that cannot be read are reported, never silently dropped', async ({ page }) => {
  const dialog = await openWizard(page, '?indexesFail=1')
  const sql = await generate(page, dialog)
  expect(sql).toContain('-- WARNING: the indexes of public could not be read')
  expect(sql).toContain('WITHOUT their indexes')
  await expect(page.getByText(/Indexes could not be read/).first()).toBeVisible()
})

test('table context menu: Generate Scripts → Structure Only carries the indexes too', async ({ page }) => {
  await blockRemoteFonts(page)
  await page.goto(APP_URL)
  await page.waitForSelector('#app > *', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Postgres/ }).first().click()
  await page.waitForTimeout(500)
  await openDatabaseNode(page)
  await page.getByText('public', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('Tables', { exact: true }).first().dblclick()
  await page.waitForTimeout(300)
  await page.getByText('students').first().click({ button: 'right' })
  await page.getByText('Generate Scripts', { exact: true }).first().hover()
  await page.getByText('Structure Only').first().click()
  await expect(page.getByRole('tab', { name: /students · scripts/ }).first()).toBeVisible()

  type Ed = { getModel: () => { getValue: () => string } | null }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const eds = ((window as unknown as { __dsEditors?: Ed[] }).__dsEditors ?? []).filter((e) => e.getModel())
        return eds[eds.length - 1]?.getModel()?.getValue() ?? ''
      }),
    )
    .toContain('CREATE INDEX idx_students_gpa ON public.students USING btree (gpa DESC NULLS LAST);')
  const text = await page.evaluate(() => {
    const eds = ((window as unknown as { __dsEditors?: Ed[] }).__dsEditors ?? []).filter((e) => e.getModel())
    return eds[eds.length - 1]?.getModel()?.getValue() ?? ''
  })
  expect(text).toContain('CONSTRAINT students_pkey PRIMARY KEY (id)')
  expect(text).toContain('CONSTRAINT students_email_key UNIQUE (email)')
  expect(text).toContain('CREATE INDEX idx_students_name_lower')
  // other tables' indexes do not leak into this table's script
  expect(text).not.toContain('idx_enrollments_course')
})
