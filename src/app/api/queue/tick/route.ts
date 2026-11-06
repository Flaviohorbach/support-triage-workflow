import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { workerDeps } from "@/lib/runtime";
import { drain } from "@/triage/worker";

const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

/**
 * Runs due messages: retries whose wait is over, and runs that crashed.
 * Called by the open panel and by a scheduled GitHub Action. Public on
 * purpose: it only works on what is already queued, in a bounded batch.
 */
export async function POST(request: Request) {
  if (!limiter(clientIp(request)).allowed) return Response.json({ error: "Muitas chamadas." }, { status: 429 });
  const outcomes = await drain(await workerDeps());
  return Response.json({ outcomes }, { headers: { "cache-control": "no-store" } });
}
