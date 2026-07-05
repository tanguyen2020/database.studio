// Skeleton CREATE statements for the Explorer "Create <type>…" folder actions.
// These open in a SQL editor tab for the user to fill in and run (DataGrip-style
// new-object consoles). Pure + dialect-aware; unit-tested in create-templates.test.ts.

import { quoteIdent, qualified } from './dialect'

export type CreateKind = 'view' | 'procedure' | 'function' | 'trigger' | 'sequence'

/** A qualified object name, honoring SQLite's schemaless `main`. */
function qname(system: string, schema: string, name: string): string {
  if (system === 'sqlite' && (schema === 'main' || !schema)) return quoteIdent(system, name)
  if (!schema) return quoteIdent(system, name)
  return qualified(system, schema, name)
}

/**
 * A ready-to-edit CREATE skeleton for `kind` in `schema`. Systems that don't
 * support a given object type return an explanatory comment instead of DDL.
 */
export function createTemplate(system: string, kind: CreateKind, schema: string): string {
  switch (kind) {
    case 'view': {
      const v = qname(system, schema, 'new_view')
      return `CREATE VIEW ${v} AS\nSELECT * FROM ${qname(system, schema, 'source_table')};`
    }
    case 'sequence': {
      if (system !== 'postgres') return `-- ${label(system)} does not support standalone sequences`
      return `CREATE SEQUENCE ${qname(system, schema, 'new_sequence')}\n  START WITH 1\n  INCREMENT BY 1;`
    }
    case 'procedure':
      return procedureTemplate(system, schema)
    case 'function':
      return functionTemplate(system, schema)
    case 'trigger':
      return triggerTemplate(system, schema)
  }
}

function procedureTemplate(system: string, schema: string): string {
  const p = qname(system, schema, 'new_procedure')
  switch (system) {
    case 'postgres':
      return `CREATE PROCEDURE ${p}()\nLANGUAGE sql\nAS $$\n  -- statements here\n$$;`
    case 'mysql':
    case 'mariadb':
      return `CREATE PROCEDURE ${p}()\nBEGIN\n  -- statements here\nEND;`
    case 'mssql':
      return `CREATE PROCEDURE ${p}\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- statements here\nEND;`
    default:
      return `-- ${label(system)} does not support stored procedures`
  }
}

function functionTemplate(system: string, schema: string): string {
  const f = qname(system, schema, 'new_function')
  switch (system) {
    case 'postgres':
      return `CREATE FUNCTION ${f}()\nRETURNS void\nLANGUAGE sql\nAS $$\n  -- SELECT ...\n$$;`
    case 'mysql':
    case 'mariadb':
      return `CREATE FUNCTION ${f}()\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 0;\nEND;`
    case 'mssql':
      return `CREATE FUNCTION ${f}()\nRETURNS INT\nAS\nBEGIN\n  RETURN 0;\nEND;`
    default:
      return `-- ${label(system)} does not support SQL functions`
  }
}

function triggerTemplate(system: string, schema: string): string {
  const name = qname(system, schema, 'new_trigger')
  const table = qname(system, schema, 'target_table')
  switch (system) {
    case 'postgres':
      // PG triggers call a trigger function — emit both, ready to edit.
      return (
        `CREATE OR REPLACE FUNCTION ${qname(system, schema, 'new_trigger_fn')}()\n` +
        `RETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- NEW / OLD available here\n  RETURN NEW;\nEND;\n$$;\n\n` +
        `CREATE TRIGGER ${quoteIdent(system, 'new_trigger')}\n` +
        `BEFORE INSERT ON ${table}\n` +
        `FOR EACH ROW EXECUTE FUNCTION ${qname(system, schema, 'new_trigger_fn')}();`
      )
    case 'mysql':
    case 'mariadb':
      return (
        `CREATE TRIGGER ${name}\nBEFORE INSERT ON ${table}\nFOR EACH ROW\n` +
        `BEGIN\n  -- SET NEW.col = ...;\nEND;`
      )
    case 'mssql':
      return `CREATE TRIGGER ${name}\nON ${table}\nAFTER INSERT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- statements here\nEND;`
    case 'sqlite':
      return (
        `CREATE TRIGGER ${quoteIdent(system, 'new_trigger')}\n` +
        `AFTER INSERT ON ${quoteIdent(system, 'target_table')}\n` +
        `BEGIN\n  -- statements here\nEND;`
      )
    default:
      return `-- ${label(system)} does not support triggers`
  }
}

function label(system: string): string {
  return system.charAt(0).toUpperCase() + system.slice(1)
}
