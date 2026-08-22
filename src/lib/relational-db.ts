import { AsyncLocalStorage } from "node:async_hooks";
import pg, { type PoolClient, type QueryResult } from "pg";

// Preserve the row shapes used by the application while PostgreSQL becomes the
// only production relational authority. Domain code still receives ISO strings,
// JSON strings and 0/1 booleans, so the storage cutover cannot silently alter
// authorization or usage comparisons.
pg.types.setTypeParser(16, (value) => value === "t" ? 1 : 0);
pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1114, (value) => value);
pg.types.setTypeParser(1184, (value) => value);
pg.types.setTypeParser(3802, (value) => value);

type RelationalGlobal = typeof globalThis & { scenelithRelationalPool?: pg.Pool };
const shared = globalThis as RelationalGlobal;

function connectionString() {
  const value = process.env.DATABASE_URL || process.env.COLLABORATION_DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not configured");
  return value;
}

export function relationalPool() {
  if (!shared.scenelithRelationalPool) {
    shared.scenelithRelationalPool = new pg.Pool({
      connectionString: connectionString(),
      max: Math.min(40, Math.max(4, Number(process.env.DATABASE_POOL_SIZE || 12))),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      maxUses: 10_000,
      allowExitOnIdle: process.env.NODE_ENV !== "production",
    });
  }
  return shared.scenelithRelationalPool;
}

const transactionClient = new AsyncLocalStorage<PoolClient>();

function appendConflictDoNothing(sql: string) {
  const trimmed = sql.trim().replace(/;$/, "");
  const returning = trimmed.match(/\s+RETURNING\s+[\s\S]+$/i);
  if (!returning) return `${trimmed} ON CONFLICT DO NOTHING`;
  return `${trimmed.slice(0, returning.index)} ON CONFLICT DO NOTHING${returning[0]}`;
}

function normalizeSql(source: string, params: unknown[] | Record<string, unknown>) {
  let sql = source.trim();
  const values: unknown[] = [];
  if (Array.isArray(params)) {
    let index = 0;
    sql = sql.replace(/\?/g, () => {
      values.push(params[index]);
      index += 1;
      return `$${index}`;
    });
    if (index !== params.length) throw new Error(`SQL parameter mismatch: expected ${index}, received ${params.length}`);
  } else {
    const indexes = new Map<string, number>();
    sql = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
      let index = indexes.get(name);
      if (!index) {
        if (!(name in params)) throw new Error(`Missing SQL parameter: ${name}`);
        values.push(params[name]);
        index = values.length;
        indexes.set(name, index);
      }
      return `$${index}`;
    });
  }
  if (/^INSERT\s+OR\s+IGNORE\s+/i.test(sql)) {
    sql = appendConflictDoNothing(sql.replace(/^INSERT\s+OR\s+IGNORE\s+/i, "INSERT "));
  }
  sql = sql.replace(/\bMAX\(0\s*,/gi, "GREATEST(0,");
  return { sql, values };
}

async function execute(source: string, params: unknown[] | Record<string, unknown>): Promise<QueryResult> {
  const normalized = normalizeSql(source, params);
  const client = transactionClient.getStore();
  return client
    ? client.query(normalized.sql, normalized.values)
    : relationalPool().query(normalized.sql, normalized.values);
}

type RunResult = { changes: number };

function argsToParams(args: unknown[]): unknown[] | Record<string, unknown> {
  return args.length === 1 && args[0] !== null && !Array.isArray(args[0]) && typeof args[0] === "object"
    ? args[0] as Record<string, unknown>
    : args;
}

export const relationalDb = {
  prepare(source: string) {
    return {
      async get(...args: unknown[]) {
        const result = await execute(source, argsToParams(args));
        return result.rows[0];
      },
      async all(...args: unknown[]) {
        const result = await execute(source, argsToParams(args));
        return result.rows;
      },
      async run(...args: unknown[]): Promise<RunResult> {
        const result = await execute(source, argsToParams(args));
        return { changes: result.rowCount || 0 };
      },
    };
  },
  transaction<TArgs extends unknown[], TResult>(operation: (...args: TArgs) => Promise<TResult>) {
    return async (...args: TArgs) => {
      const nested = transactionClient.getStore();
      if (nested) return operation(...args);
      const client = await relationalPool().connect();
      try {
        await client.query("BEGIN");
        const result = await transactionClient.run(client, () => operation(...args));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
  },
};

export async function closeRelationalPool() {
  const pool = shared.scenelithRelationalPool;
  shared.scenelithRelationalPool = undefined;
  if (pool) await pool.end();
}

export async function relationalDatabaseReady() {
  const result = await relationalPool().query("SELECT 1 AS ok");
  return Number(result.rows[0]?.ok) === 1;
}
