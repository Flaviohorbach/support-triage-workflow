import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Board, Messenger } from "../src/lib/channels";
import { createPglite, createRepository, type Db, type Repository, type Simulate, type Source } from "../src/lib/db";
import { TransientError } from "../src/lib/errors";
import type { Classification } from "../src/triage/classify";
import { drain, MAX_ATTEMPTS, runNext, type WorkerDeps } from "../src/triage/worker";

const question: Classification = { category: "duvida", urgent: false, faqTopic: "formas_pagamento", summary: "Pergunta sobre pagamento" };
const exchange: Classification = { category: "troca", urgent: false, faqTopic: "nenhum", summary: "Quer trocar o tamanho" };

let db: Db;
let repo: Repository;
let sent: { chatId: string; text: string }[];
let cards: string[];
let modelCalls: number;

function deps(overrides: Partial<WorkerDeps> & { label?: Classification | (() => Classification) } = {}): WorkerDeps {
  const { label = exchange, ...rest } = overrides;
  const telegram: Messenger = { configured: true, send: async (chatId, text) => (sent.push({ chatId, text }), { simulated: false }) };
  const trello: Board = { configured: true, createCard: async ({ title }) => (cards.push(title), { simulated: false, url: "https://trello.com/c/abc", reused: false }) };
  return {
    repo,
    classify: async () => {
      modelCalls++;
      return typeof label === "function" ? label() : label;
    },
    dailyModelLimit: 100,
    telegram,
    trello,
    opsChatId: "ops",
    ...rest,
  };
}

async function receive(text: string, options: { source?: Source; simulate?: Simulate } = {}) {
  const id = randomUUID();
  const source = options.source ?? "telegram";
  await repo.insert({ id, source, externalId: id, chatId: source === "telegram" ? "customer" : null, text, simulate: options.simulate ?? null });
  return id;
}

/** Skips the backoff wait, as if the time had passed. */
const makeDue = () => db.query("UPDATE messages SET next_attempt_at = now() WHERE status = 'retry'");

beforeEach(async () => {
  db = await createPglite();
  repo = createRepository(db);
  sent = [];
  cards = [];
  modelCalls = 0;
});

describe("routing", () => {
  it("answers a simple question from the ready answers, with no card", async () => {
    const id = await receive("Vocês aceitam Pix?");
    expect(await runNext(deps({ label: question }))).toBe("done");
    const { message } = (await repo.get(id))!;
    expect(message.resolution).toBe("auto_answered");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Pix, boleto e cartão");
    expect(cards).toHaveLength(0);
  });

  it("sends an exchange to the team with a protocol, and no alert", async () => {
    await receive("Quero trocar o tamanho do tênis");
    await runNext(deps());
    expect(cards).toEqual(["Troca ou devolução: Quer trocar o tamanho"]);
    expect(sent.map((s) => s.chatId)).toEqual(["customer"]);
    expect(sent[0]!.text).toMatch(/Protocolo [0-9A-F]{8}/);
  });

  it("makes a message urgent by rule in code when the model missed it", async () => {
    const id = await receive("Vou abrir uma reclamação no Procon se não trocarem");
    await runNext(deps());
    const { message, events } = (await repo.get(id))!;
    expect(message.resolution).toBe("urgent");
    expect(cards[0]).toMatch(/^URGENTE/);
    expect(sent.map((s) => s.chatId)).toEqual(["customer", "ops"]);
    expect(events.some((e) => e.detail?.includes("regra em código"))).toBe(true);
  });

  it("keeps the answer on the page for a web message, without Telegram", async () => {
    const id = await receive("Quero trocar", { source: "web" });
    await runNext(deps());
    const { steps } = (await repo.get(id))!;
    expect(steps.find((s) => s.step === "reply")!.result.channel).toBe("web");
    expect(sent).toHaveLength(0);
  });
});

describe("failures", () => {
  it("retries a transient failure later and does not repeat what already worked", async () => {
    const id = await receive("Quero trocar", { simulate: "transient" });
    expect(await runNext(deps())).toBe("retry");
    expect((await repo.get(id))!.message.status).toBe("retry");
    expect(await runNext(deps())).toBe("idle"); // not due yet

    await makeDue();
    expect(await runNext(deps())).toBe("done");
    expect(sent).toHaveLength(1); // the customer was answered once
    expect(modelCalls).toBe(1); // and the model was not called again
    expect(cards).toHaveLength(1);
  });

  it("sends a permanent failure straight to the failure queue, and a person can requeue it", async () => {
    const id = await receive("Quero trocar", { simulate: "permanent" });
    expect(await runNext(deps())).toBe("dead");
    expect((await repo.get(id))!.message.attempts).toBe(1);

    expect(await repo.requeue(id)).toBe(true);
    expect(await repo.requeue(id)).toBe(false); // only from the failure queue
    expect(await runNext(deps())).toBe("done");
    expect(cards).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("gives up after the last attempt", async () => {
    const id = await receive("Quero trocar");
    const failing: Board = { configured: true, createCard: async () => Promise.reject(new TransientError("Trello fora do ar")) };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await runNext(deps({ trello: failing }))).toBe(attempt < MAX_ATTEMPTS ? "retry" : "dead");
      await makeDue();
    }
    const { message, events } = (await repo.get(id))!;
    expect(message.status).toBe("dead");
    expect(events.filter((e) => e.kind === "retry_scheduled")).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it("falls back to keywords when the model fails, instead of failing the message", async () => {
    const id = await receive("Meu pedido ainda não chegou");
    const outcome = await runNext(deps({ label: () => { throw new Error("quota"); } }));
    expect(outcome).toBe("done");
    const { message } = (await repo.get(id))!;
    expect(message.method).toBe("keywords");
    expect(message.category).toBe("atraso");
  });

  it("stops calling the model once the daily limit is reached", async () => {
    await receive("Meu pedido ainda não chegou");
    await runNext(deps({ dailyModelLimit: 0 }));
    expect(modelCalls).toBe(0);
  });

  it("takes over a message whose run crashed, once its lock expires", async () => {
    const id = await receive("Quero trocar");
    await repo.claimNext(); // a run takes it and dies
    expect(await repo.claimNext()).toBeNull();
    await db.query("UPDATE messages SET locked_until = now() - interval '1 second' WHERE id = $1", [id]);
    expect((await repo.claimNext())!.id).toBe(id);
  });
});

describe("intake", () => {
  it("ignores a message received twice", async () => {
    const first = await repo.insert({ id: "a", source: "telegram", externalId: "update-1", chatId: "c", text: "oi", simulate: null });
    const again = await repo.insert({ id: "b", source: "telegram", externalId: "update-1", chatId: "c", text: "oi", simulate: null });
    expect(first).toBe("a");
    expect(again).toBeNull();
  });

  it("works through the queue in order and reports metrics", async () => {
    await receive("Aceitam Pix?");
    await receive("Quero trocar");
    let n = 0;
    const outcomes = await drain(deps({ label: () => (n++ === 0 ? question : exchange) }));
    expect(outcomes).toEqual(["done", "done"]);
    const metrics = await repo.metrics();
    expect(metrics).toMatchObject({ total: 2, done: 2, autoAnswered: 1, toTeam: 1, dead: 0, pending: 0 });
    expect(metrics.replySeconds.p50).not.toBeNull();
  });
});
