import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegram, createTrello } from "../src/lib/channels";
import { httpError, PermanentError, TransientError } from "../src/lib/errors";
import { applySafetyNet, classifyWithKeywords } from "../src/triage/classify";
import { planFor } from "../src/triage/route";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("errors", () => {
  it("retries rate limits and server errors, not bad requests", () => {
    expect(httpError("X", 429, "")).toBeInstanceOf(TransientError);
    expect(httpError("X", 503, "")).toBeInstanceOf(TransientError);
    expect(httpError("X", 401, "")).toBeInstanceOf(PermanentError);
    expect(httpError("X", 404, "")).toBeInstanceOf(PermanentError);
  });
});

describe("Trello", () => {
  const trello = () => createTrello({ key: "KEY123", token: "SECRET456", listId: "list" });

  it("reuses the card a previous attempt already created", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([{ desc: "texto\n\ntriage:m1", shortUrl: "https://trello.com/c/old" }]));
    vi.stubGlobal("fetch", fetch);
    const card = await trello().createCard({ title: "T", description: "D", urgent: false, marker: "triage:m1" });
    expect(card).toEqual({ simulated: false, url: "https://trello.com/c/old", reused: true });
    expect(fetch).toHaveBeenCalledTimes(1); // no POST
  });

  it("creates the card with the marker, and sends the token in a header, not the URL", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ shortUrl: "https://trello.com/c/new", desc: "" }));
    vi.stubGlobal("fetch", fetch);
    const card = await trello().createCard({ title: "T", description: "D", urgent: true, marker: "triage:m2" });
    expect(card.url).toBe("https://trello.com/c/new");
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).not.toContain("SECRET456");
    expect(init.headers.Authorization).toContain("SECRET456");
    expect(JSON.parse(init.body)).toMatchObject({ idList: "list", desc: "D\n\ntriage:m2", pos: "top" });
  });

  it("turns a timeout into a transient error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation was aborted due to timeout")));
    await expect(trello().createCard({ title: "T", description: "D", urgent: false, marker: "m" })).rejects.toBeInstanceOf(TransientError);
  });

  it("is simulated when not configured", async () => {
    const card = await createTrello({}).createCard({ title: "T", description: "D", urgent: false, marker: "m" });
    expect(card.simulated).toBe(true);
  });
});

describe("Telegram", () => {
  it("treats a bad token as permanent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ok: false, description: "Unauthorized" }, 401)));
    await expect(createTelegram("bad").send("1", "oi")).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("rules in code", () => {
  it("classifies by keywords, as the free baseline", () => {
    expect(classifyWithKeywords("Meu pedido ainda não chegou").category).toBe("atraso");
    expect(classifyWithKeywords("Veio com defeito, quero devolver").category).toBe("troca");
    expect(classifyWithKeywords("Vocês aceitam boleto?")).toMatchObject({ category: "duvida", faqTopic: "formas_pagamento" });
    expect(classifyWithKeywords("Fui cobrado duas vezes, isso é fraude").category).toBe("reclamacao_grave");
  });

  it("never lets an urgent term go unflagged", () => {
    const calm = { category: "troca" as const, urgent: false, faqTopic: "nenhum" as const, summary: "" };
    expect(applySafetyNet(calm, "Meu advogado vai entrar em contato").forcedUrgent).toBe(true);
    expect(applySafetyNet(calm, "Quero trocar a cor").forcedUrgent).toBe(false);
  });

  it("answers automatically only a question with a ready answer", () => {
    expect(planFor({ category: "duvida", urgent: false, faqTopic: "rastreio", summary: "" }, "id").resolution).toBe("auto_answered");
    expect(planFor({ category: "duvida", urgent: false, faqTopic: "nenhum", summary: "" }, "id").resolution).toBe("to_team");
    expect(planFor({ category: "duvida", urgent: true, faqTopic: "rastreio", summary: "" }, "id").resolution).toBe("urgent");
  });
});
