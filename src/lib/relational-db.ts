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

type TransactionContext = { client: PoolClient; active: boolean; afterCommit: Array<() => void> };
const transactionClient = new AsyncLocalStorage<TransactionContext>();

// Timers inherit async context. Durable workers must start after admission
// commits, outside its connection, and must never start for rolled-back work.
export function afterDatabaseCommit(callback: () => void) {
  const context = transactionClient.getStore();
  if (context?.active) context.afterCommit.push(callback);
  else transactionClient.exit(callback);
}

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
  const context = transactionClient.getStore();
  return context?.active
    ? context.client.query(normalized.sql, normalized.values)
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
      if (nested?.active) return operation(...args);
      const client = await relationalPool().connect();
      const context: TransactionContext = { client, active: true, afterCommit: [] };
      let result: TResult;
      try {
        await client.query("BEGIN");
        result = await transactionClient.run(context, () => operation(...args));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        context.active = false;
        client.release();
      }
      for (const callback of context.afterCommit) transactionClient.exit(callback);
      return result;
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
