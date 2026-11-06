import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createRateLimiter } from "@/lib/rate-limit";
import { DAILY_MESSAGE_LIMIT, drainAfterResponse, getRepo, telegram } from "@/lib/runtime";

const perChat = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });

const UpdateSchema = z.object({
  update_id: z.number(),
  message: z.object({ chat: z.object({ id: z.number() }), text: z.string().optional() }).optional(),
});

const WELCOME = `Este é o bot de demonstração de uma loja fictícia. Escreva como se fosse um cliente: uma dúvida, um atraso, uma troca ou uma reclamação.

Sua mensagem aparece no painel público do projeto e é apagada em 7 dias. Não escreva dados pessoais.`;

/** Telegram signs nothing; the secret set with the webhook is how a request proves it came from Telegram. */
function fromTelegram(request: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Answers fast and works later: Telegram resends an update when it does not
 * get a 200 in time, and the unique (source, update_id) makes that harmless.
 */
export async function POST(request: Request) {
  if (!fromTelegram(request)) return new Response("unauthorized", { status: 401 });
  const update = UpdateSchema.safeParse(await request.json().catch(() => null));
  const message = update.success ? update.data.message : undefined;
  if (!update.success || !message) return new Response("ok"); // other update types: nothing to do

  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";
  const bot = telegram();
  const reply = (body: string) => bot.send(chatId, body).catch((error) => console.warn("telegram reply failed:", error.message));

  if (text === "") {
    await reply("Por enquanto eu só leio texto.");
    return new Response("ok");
  }
  if (text.startsWith("/start") || text.startsWith("/help")) {
    await reply(WELCOME);
    return new Response("ok");
  }
  if (!perChat(chatId).allowed) {
    await reply("Recebi muitas mensagens suas em pouco tempo. Tente de novo em alguns minutos.");
    return new Response("ok");
  }

  const repo = await getRepo();
  if ((await repo.countSince(24)) >= DAILY_MESSAGE_LIMIT) {
    await reply("O limite de mensagens de hoje da demonstração acabou. Volte amanhã.");
    return new Response("ok");
  }
  await repo.purgeOld();
  await repo.insert({ id: randomUUID(), source: "telegram", externalId: String(update.data.update_id), chatId, text: text.slice(0, 600), simulate: null });
  drainAfterResponse();
  return new Response("ok");
}
