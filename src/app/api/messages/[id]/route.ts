import { getRepo } from "@/lib/runtime";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await (await getRepo()).get(id);
  if (!record) return Response.json({ error: "Mensagem não encontrada." }, { status: 404 });
  const { message, steps, events } = record;
  return Response.json(
    {
      id: message.id,
      source: message.source,
      text: message.text,
      status: message.status,
      attempts: message.attempts,
      nextAttemptAt: message.next_attempt_at,
      lastError: message.last_error,
      resolution: message.resolution,
      simulate: message.simulate,
      createdAt: message.created_at,
      steps: steps.map((s) => ({ step: s.step, result: s.result, at: s.created_at })),
      events: events.map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
