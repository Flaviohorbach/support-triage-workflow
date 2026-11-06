import { after } from "next/server";
import { classifyWithModel } from "../triage/classify";
import { drain, type WorkerDeps } from "../triage/worker";
import { createTelegram, createTrello } from "./channels";
import { createPglite, createPostgres, createRepository, findDatabaseUrl, type Repository } from "./db";
import { createShopModel } from "./model";

// On globalThis so a hot reload in development keeps the same database.
const holder = globalThis as unknown as { triageRepo?: Promise<Repository> };

async function connect(): Promise<Repository> {
  const url = findDatabaseUrl(process.env);
  if (url) return createRepository(await createPostgres(url));
  if (process.env.VERCEL) throw new Error("DATABASE_URL não configurada. Conecte um banco Neon ao projeto na Vercel e faça o redeploy.");
  return createRepository(await createPglite(".data"));
}

export function getRepo(): Promise<Repository> {
  // A failed connection must not stay cached, or every later request would fail too.
  holder.triageRepo ??= connect().catch((error) => {
    holder.triageRepo = undefined;
    throw error;
  });
  return holder.triageRepo;
}

export const telegram = () => createTelegram(process.env.TELEGRAM_BOT_TOKEN);

export async function workerDeps(): Promise<WorkerDeps> {
  const model = createShopModel();
  return {
    repo: await getRepo(),
    classify: (text) => classifyWithModel(model, text),
    dailyModelLimit: Number(process.env.DAILY_MODEL_LIMIT ?? 40),
    telegram: telegram(),
    trello: createTrello({ key: process.env.TRELLO_API_KEY, token: process.env.TRELLO_TOKEN, listId: process.env.TRELLO_LIST_ID }),
    opsChatId: process.env.TELEGRAM_OPS_CHAT_ID || undefined,
  };
}

/**
 * Works on the queue after the response is sent, so the sender (a visitor or
 * Telegram) never waits for the model. There is no always-on worker on the
 * free tier: the queue moves on new messages, on the panel and on a schedule.
 */
export function drainAfterResponse() {
  after(async () => {
    try {
      await drain(await workerDeps());
    } catch (error) {
      console.error("queue run failed:", error);
    }
  });
}

/** Messages per day across every visitor, to protect the free model quota and the Trello board. */
export const DAILY_MESSAGE_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT ?? 60);
