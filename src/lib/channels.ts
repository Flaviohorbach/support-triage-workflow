import { httpError, PermanentError, TransientError } from "./errors";

export interface SendResult {
  simulated: boolean;
}

/** Sends a Telegram message. Simulated when no bot is configured, so the demo works without one. */
export interface Messenger {
  readonly configured: boolean;
  send(chatId: string, text: string): Promise<SendResult>;
}

export interface CardResult {
  simulated: boolean;
  url: string | null;
  /** True when a retry found the card a previous attempt had already created. */
  reused: boolean;
}

export interface Board {
  readonly configured: boolean;
  /** `marker` must be unique per message: it is how a retry finds a card that was already created. */
  createCard(card: { title: string; description: string; urgent: boolean; marker: string }): Promise<CardResult>;
}

const TIMEOUT_MS = 10_000;

async function call(service: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // Network failure or timeout: the request may or may not have arrived.
    throw new TransientError(`${service} não respondeu: ${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) throw httpError(service, response.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new TransientError(`${service} devolveu uma resposta inválida`);
  }
}

export function createTelegram(token: string | undefined): Messenger {
  if (!token) return { configured: false, send: async () => ({ simulated: true }) };
  return {
    configured: true,
    async send(chatId, text) {
      await call("Telegram", `https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      return { simulated: false };
    },
  };
}

interface TrelloCard {
  desc: string;
  shortUrl: string;
}

export function createTrello(config: { key?: string; token?: string; listId?: string }): Board {
  const { key, token, listId } = config;
  if (!key || !token || !listId) return { configured: false, createCard: async () => ({ simulated: true, url: null, reused: false }) };
  // In a header, not the query string, so the token does not end up in request logs.
  const headers = { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`, "content-type": "application/json" };
  const base = "https://api.trello.com/1";
  return {
    configured: true,
    async createCard({ title, description, urgent, marker }) {
      // Trello has no idempotency key. A crash after creating a card but before
      // recording it would make the retry create a second one, so look first.
      const cards = (await call("Trello", `${base}/lists/${listId}/cards?fields=desc,shortUrl`, { headers })) as TrelloCard[];
      const existing = cards.find((card) => card.desc.includes(marker));
      if (existing) return { simulated: false, url: existing.shortUrl, reused: true };

      const created = (await call("Trello", `${base}/cards`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idList: listId, name: title.slice(0, 200), desc: `${description}\n\n${marker}`, pos: urgent ? "top" : "bottom" }),
      })) as Partial<TrelloCard>;
      if (!created.shortUrl) throw new PermanentError("Trello não devolveu o link do card");
      return { simulated: false, url: created.shortUrl, reused: false };
    },
  };
}
