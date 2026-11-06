export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  source text NOT NULL,
  external_id text NOT NULL,
  chat_id text,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  simulate text,
  category text,
  urgent boolean,
  method text,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS messages_due ON messages (status, next_attempt_at);
CREATE TABLE IF NOT EXISTS steps (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  step text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, step)
);
CREATE TABLE IF NOT EXISTS events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export type Source = "web" | "telegram";
export type Status = "queued" | "processing" | "retry" | "done" | "dead";
export type Simulate = "transient" | "permanent";
export type EventKind = "received" | "attempt" | "step" | "retry_scheduled" | "dead" | "done" | "requeued";

export interface MessageRow {
  id: string;
  source: Source;
  external_id: string;
  chat_id: string | null;
  text: string;
  status: Status;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  simulate: Simulate | null;
  category: string | null;
  urgent: boolean | null;
  method: string | null;
  resolution: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface StepRow {
  step: string;
  result: Record<string, unknown>;
  created_at: Date;
}

export interface EventRow {
  kind: EventKind;
  detail: string | null;
  created_at: Date;
}

/** How long a worker owns a message. A crash leaves it "processing"; after this, another run takes it over. */
export const LOCK_SECONDS = 120;

export function createRepository(db: Db) {
  const repo = {
    /** Returns null for a message already received: Telegram redelivers when it does not get a 200 in time. */
    async insert(m: { id: string; source: Source; externalId: string; chatId: string | null; text: string; simulate: Simulate | null }): Promise<string | null> {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO messages (id, source, external_id, chat_id, text, simulate) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
        [m.id, m.source, m.externalId, m.chatId, m.text, m.simulate],
      );
      if (rows.length === 0) return null;
      await repo.event(m.id, "received", m.source === "telegram" ? "Mensagem recebida pelo Telegram" : "Mensagem recebida pelo formulário");
      return m.id;
    },

    /**
     * Takes the next due message and locks it. SKIP LOCKED lets two runs work
     * side by side without ever taking the same message.
     */
    async claimNext(): Promise<MessageRow | null> {
      const [row] = await db.query<MessageRow>(
        `UPDATE messages SET status = 'processing', attempts = attempts + 1, locked_until = now() + interval '${LOCK_SECONDS} seconds'
         WHERE id = (
           SELECT id FROM messages
           WHERE (status IN ('queued', 'retry') AND next_attempt_at <= now()) OR (status = 'processing' AND locked_until < now())
           ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
      );
      return row ?? null;
    },

    async steps(id: string): Promise<Map<string, Record<string, unknown>>> {
      const rows = await db.query<StepRow>("SELECT step, result FROM steps WHERE message_id = $1", [id]);
      return new Map(rows.map((r) => [r.step, r.result]));
    },

    /** A step is recorded once. Recording it again (a retry racing a slow run) changes nothing. */
    async saveStep(id: string, step: string, result: Record<string, unknown>) {
      await db.query("INSERT INTO steps (message_id, step, result) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING", [id, step, JSON.stringify(result)]);
    },

    async saveClassification(id: string, c: { category: string; urgent: boolean; method: string }) {
      await db.query("UPDATE messages SET category = $2, urgent = $3, method = $4 WHERE id = $1", [id, c.category, c.urgent, c.method]);
    },

    async event(id: string, kind: EventKind, detail?: string) {
      await db.query("INSERT INTO events (message_id, kind, detail) VALUES ($1, $2, $3)", [id, kind, detail ?? null]);
    },

    async finish(id: string, resolution: string) {
      await db.query("UPDATE messages SET status = 'done', resolution = $2, locked_until = NULL, last_error = NULL, finished_at = now() WHERE id = $1", [id, resolution]);
    },

    async scheduleRetry(id: string, delaySeconds: number, error: string) {
      await db.query(
        `UPDATE messages SET status = 'retry', locked_until = NULL, last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
        [id, error, delaySeconds],
      );
    },

    async markDead(id: string, error: string) {
      await db.query("UPDATE messages SET status = 'dead', locked_until = NULL, last_error = $2 WHERE id = $1", [id, error]);
    },

    /** A person sends a failed message back to the queue. Clears the simulated failure, as fixing a token would. */
    async requeue(id: string): Promise<boolean> {
      const rows = await db.query<{ id: string }>(
        "UPDATE messages SET status = 'queued', attempts = 0, simulate = NULL, next_attempt_at = now() WHERE id = $1 AND status = 'dead' RETURNING id",
        [id],
      );
      if (rows.length === 1) await repo.event(id, "requeued", "Devolvida à fila por uma pessoa");
      return rows.length === 1;
    },

    async get(id: string) {
      const [message] = await db.query<MessageRow>("SELECT * FROM messages WHERE id = $1", [id]);
      if (!message) return null;
      const steps = await db.query<StepRow>("SELECT step, result, created_at FROM steps WHERE message_id = $1 ORDER BY created_at", [id]);
      const events = await db.query<EventRow>("SELECT kind, detail, created_at FROM events WHERE message_id = $1 ORDER BY id", [id]);
      return { message, steps, events };
    },

    async recent(limit = 30): Promise<MessageRow[]> {
      return db.query<MessageRow>("SELECT * FROM messages ORDER BY created_at DESC LIMIT $1", [limit]);
    },

    async countSince(hours: number): Promise<number> {
      const [row] = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM messages WHERE created_at > now() - make_interval(hours => $1)`, [hours]);
      return Number(row!.n);
    },

    /** Messages the model classified in the last day: the free quota is per day. */
    async modelClassificationsToday(): Promise<number> {
      const [row] = await db.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM steps WHERE step = 'classify' AND result->>'method' = 'model' AND created_at > now() - interval '1 day'",
      );
      return Number(row!.n);
    },

    async metrics() {
      const [totals] = await db.query<Record<string, string | number | null>>(`
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE status = 'done') AS done,
          count(*) FILTER (WHERE resolution = 'auto_answered') AS auto_answered,
          count(*) FILTER (WHERE resolution = 'to_team') AS to_team,
          count(*) FILTER (WHERE resolution = 'urgent') AS urgent,
          count(*) FILTER (WHERE status = 'dead') AS dead,
          count(*) FILTER (WHERE status IN ('queued', 'retry', 'processing')) AS pending,
          count(*) FILTER (WHERE method = 'keywords') AS by_keywords
        FROM messages`);
      const [timing] = await db.query<{ p50: number | null; p90: number | null }>(`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90
        FROM (SELECT extract(epoch FROM s.created_at - m.created_at) AS secs FROM steps s JOIN messages m ON m.id = s.message_id WHERE s.step = 'reply') t`);
      const [retries] = await db.query<{ n: string | number }>("SELECT count(*) AS n FROM events WHERE kind = 'retry_scheduled'");
      const categories = await db.query<{ category: string; n: string | number }>(
        "SELECT category, count(*) AS n FROM messages WHERE category IS NOT NULL GROUP BY category ORDER BY count(*) DESC",
      );
      const num = (v: unknown) => Number(v ?? 0);
      return {
        total: num(totals!.total),
        done: num(totals!.done),
        autoAnswered: num(totals!.auto_answered),
        toTeam: num(totals!.to_team),
        urgent: num(totals!.urgent),
        dead: num(totals!.dead),
        pending: num(totals!.pending),
        byKeywords: num(totals!.by_keywords),
        retries: num(retries!.n),
        replySeconds: { p50: timing?.p50 === null ? null : num(timing?.p50), p90: timing?.p90 === null ? null : num(timing?.p90) },
        categories: categories.map((c) => ({ category: c.category, count: num(c.n) })),
      };
    },

    /** Visitors' text is not kept for long. */
    async purgeOld(days = 7) {
      await db.query(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [days]);
    },
  };
  return repo;
}
export type Repository = ReturnType<typeof createRepository>;
export type Metrics = Awaited<ReturnType<Repository["metrics"]>>;

/** The Vercel integration can add a prefix to the variable's name. */
export function findDatabaseUrl(env: Record<string, string | undefined>): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const key = Object.keys(env).sort().find((name) => name.endsWith("_DATABASE_URL") && env[name]);
  return key ? env[key] : undefined;
}

export async function createPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  await pg.exec(SCHEMA);
  return { query: async <T>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows };
}

export async function createPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  // Neon closes idle connections. Without a listener, that error would crash the process.
  pool.on("error", (error) => console.warn("idle database connection closed:", error.message));
  await pool.query(SCHEMA);
  return { query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[] };
}
