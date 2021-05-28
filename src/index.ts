import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { performance } from 'perf_hooks';
import { Client, ClientConfig, native, Pool, QueryConfig, QueryResult } from 'pg';
import { createDb, migrate } from 'postgres-migrations';
export { QueryResult };

export default fp<FastifyPgOptions>(async function fastifyPg(app, connectionOptions) {
  const logger = app.log.child({ plugin: 'fastify-pg' });
  const pg = native
    ? (logger.info('using native libpq bindings'), native)
    : (logger.info('using JavaScript bindings'), { Pool, Client });
  await initializeDatabase(pg.Client, connectionOptions, logger);
  const pool = new pg.Pool({ ...connectionOptions, log: logger.info.bind(logger) });
  const database = new Database(pool, logger);
  app.decorate('database', database);
  app.addHook('onClose', async () => (logger.info('closing database pool ...'), await pool.end()));
});

class Database {
  query: QueryFunction;
  constructor(private pool: Pool, private logger: Logger) {
    this.query = attachLogger(pool.query.bind(pool), logger);
  }

  async transaction(): Promise<Transaction>;
  async transaction(callback: (query: QueryFunction) => Promise<void>): Promise<void>;
  async transaction(callback?: (query: QueryFunction) => Promise<void>): Promise<Transaction | void> {
    const { query, close } = await this.connection();
    const commit = () => query('COMMIT').then(close);
    const rollback = () => query('ROLLBACK').then(close);
    await query('BEGIN');
    if (!callback) return { query, commit, rollback };
    try {
      await callback(query);
      await commit();
    } catch (error) {
      await rollback();
      throw error;
    }
  }

  async connection() {
    const connection = await this.pool.connect();
    return {
      query: attachLogger(connection.query.bind(connection), this.logger),
      close: () => connection.release(),
    };
  }
}

async function initializeDatabase(
  pgClient: typeof Client,
  { migrationsDirectory, database, ...connectionOptions }: FastifyPgOptions,
  fastifyLogger: Logger,
) {
  let client: Client | undefined;
  const logger = fastifyLogger.info.bind(fastifyLogger);
  try {
    client = new pgClient(connectionOptions);
    await client.connect();
    await createDb(database, { client }, { logger });
    if (migrationsDirectory !== undefined) {
      await client.end();
      client = new pgClient({ database, ...connectionOptions });
      await client.connect();
      await migrate({ client }, migrationsDirectory, { logger });
    }
  } catch (error) {
    fastifyLogger.error(error, 'failed to initialize database');
    throw error;
  } finally {
    await client?.end();
  }
}

function attachLogger(query: QueryFunction, logger: Logger) {
  return function (...args: Parameters<QueryFunction>) {
    const t0 = performance.now();
    let { text, values } = (args[0] as unknown) as QueryConfig;
    if (!text) [text, values] = args;
    return ((query(...args) as unknown) as Promise<QueryResult>)
      .then(res => {
        logger.info({ text, values, duration: performance.now() - t0, resultsSize: res.rowCount }, 'database query');
        return res;
      })
      .catch(error => {
        logger.error({ text, values, duration: performance.now() - t0, error }, 'database query failed');
        throw error;
      });
  } as QueryFunction;
}

declare module 'fastify' {
  interface FastifyInstance {
    database: Database;
  }
}

export type FastifyPgOptions = DatabaseConnectionOptions & Partial<MigrationsOptions>;

type DatabaseConnectionOptions = Required<Pick<ClientConfig, 'host' | 'port' | 'user' | 'password' | 'database'>>;

type MigrationsOptions = { migrationsDirectory: string };

type Logger = FastifyInstance['log'];

type QueryFunction = Pool['query'];

interface Transaction {
  query: QueryFunction;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}
