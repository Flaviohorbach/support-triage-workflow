import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createShopModel } from "@/lib/model";
import { applySafetyNet, classifyWithKeywords, classifyWithModel } from "@/triage/classify";
import { planFor } from "@/triage/route";

const BodySchema = z.object({ id: z.string().min(1).max(100), text: z.string().trim().min(1).max(600) });

function authorized(request: Request): boolean {
  const expected = process.env.CLASSIFY_TOKEN;
  const received = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The same classification and rules as the queue, for the n8n version of the
 * workflow. n8n orchestrates; this decides. Off unless CLASSIFY_TOKEN is set,
 * because every call spends the model quota.
 */
export async function POST(request: Request) {
  if (!process.env.CLASSIFY_TOKEN) return Response.json({ error: "Desligado." }, { status: 404 });
  if (!authorized(request)) return Response.json({ error: "Token inválido." }, { status: 401 });
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Envie id e text." }, { status: 400 });

  let method: "model" | "keywords" = "model";
  let raw;
  try {
    raw = await classifyWithModel(createShopModel(), body.data.text);
  } catch {
    method = "keywords";
    raw = classifyWithKeywords(body.data.text);
  }
  const { classification, forcedUrgent } = applySafetyNet(raw, body.data.text);
  return Response.json({ classification, method, forcedUrgent, plan: planFor(classification, body.data.id) });
}
