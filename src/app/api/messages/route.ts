import { randomUUID } from "node:crypto";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { DAILY_MESSAGE_LIMIT, drainAfterResponse, getRepo } from "@/lib/runtime";

const limiter = createRateLimiter({ limit: 4, windowMs: 10 * 60_000 });

const BodySchema = z.object({
  text: z.string().trim().min(3).max(600),
  simulate: z.enum(["transient", "permanent"]).nullable().default(null),
});

export async function POST(request: Request) {
  const { allowed, retryAfterMs } = limiter(clientIp(request));
  if (!allowed) return Response.json({ error: "Muitas mensagens em pouco tempo. Tente de novo em alguns minutos." }, { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } });

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Escreva uma mensagem de 3 a 600 caracteres." }, { status: 400 });

  const repo = await getRepo();
  if ((await repo.countSince(24)) >= DAILY_MESSAGE_LIMIT) return Response.json({ error: "O limite de mensagens de hoje acabou. Volte amanhã." }, { status: 429 });
  await repo.purgeOld();

  const id = randomUUID();
  await repo.insert({ id, source: "web", externalId: id, chatId: null, text: body.data.text, simulate: body.data.simulate });
  drainAfterResponse();
  return Response.json({ id }, { status: 202 });
}

/** The panel: metrics and the latest messages. Chat ids never leave the server. */
export async function GET() {
  const repo = await getRepo();
  const [metrics, recent] = await Promise.all([repo.metrics(), repo.recent(30)]);
  const messages = recent.map((m) => ({
    id: m.id,
    source: m.source,
    text: m.text,
    status: m.status,
    attempts: m.attempts,
    nextAttemptAt: m.next_attempt_at,
    lastError: m.last_error,
    category: m.category,
    urgent: m.urgent,
    method: m.method,
    resolution: m.resolution,
    createdAt: m.created_at,
  }));
  return Response.json({ metrics, messages }, { headers: { "cache-control": "no-store" } });
}
