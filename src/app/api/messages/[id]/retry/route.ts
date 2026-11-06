import { drainAfterResponse, getRepo } from "@/lib/runtime";

/** A person sends a message from the failure queue back to the queue. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requeued = await (await getRepo()).requeue(id);
  if (!requeued) return Response.json({ error: "Esta mensagem não está na fila de falhas." }, { status: 409 });
  drainAfterResponse();
  return Response.json({ ok: true }, { status: 202 });
}
