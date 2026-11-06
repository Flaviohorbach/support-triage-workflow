import type { Board, Messenger } from "../lib/channels";
import type { MessageRow, Repository } from "../lib/db";
import { errorMessage, isPermanent, PermanentError, TransientError } from "../lib/errors";
import { applySafetyNet, CATEGORY_LABELS, classifyWithKeywords, type Classification, type ClassifyResult } from "./classify";
import { planFor, protocolOf, type Plan, type Step } from "./route";

export interface WorkerDeps {
  repo: Repository;
  /** The model classifier. It may throw: the worker then falls back to keywords instead of failing. */
  classify: (text: string) => Promise<Classification>;
  /** Model classifications per day, to keep the free quota for the visitors who come later. */
  dailyModelLimit: number;
  telegram: Messenger;
  trello: Board;
  opsChatId?: string;
}

/** After the last one, the message goes to the failure queue for a person. */
export const MAX_ATTEMPTS = 4;
/** Wait before attempts 2, 3 and 4. Growing waits give a struggling service room to recover. */
export const BACKOFF_SECONDS = [30, 120, 600] as const;
export const backoffSeconds = (attempt: number) => BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1]!;

export interface StoredClassification extends ClassifyResult {
  forcedUrgent: boolean;
}

/**
 * The model when it can, keywords when it cannot. A broken classifier should
 * make the triage worse, not stop it: the message still gets an answer.
 */
async function classifyMessage(deps: WorkerDeps, text: string): Promise<StoredClassification> {
  let result: ClassifyResult;
  if ((await deps.repo.modelClassificationsToday()) >= deps.dailyModelLimit) {
    result = { classification: classifyWithKeywords(text), method: "keywords", modelCalls: 0, fallbackReason: "limite diário do modelo atingido" };
  } else {
    try {
      result = { classification: await deps.classify(text), method: "model", modelCalls: 1 };
    } catch (error) {
      result = { classification: classifyWithKeywords(text), method: "keywords", modelCalls: 1, fallbackReason: `modelo indisponível (${errorMessage(error).slice(0, 80)})` };
    }
  }
  const { classification, forcedUrgent } = applySafetyNet(result.classification, text);
  return { ...result, classification, forcedUrgent };
}

async function runStep(deps: WorkerDeps, message: MessageRow, plan: Plan, step: Step, done: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
  switch (step) {
    case "reply": {
      if (message.source !== "telegram" || !message.chat_id) return { channel: "web", text: plan.reply };
      const sent = await deps.telegram.send(message.chat_id, plan.reply);
      return { channel: sent.simulated ? "simulated" : "telegram", text: plan.reply };
    }
    case "card": {
      // Demo switches: show a retry, or a failure no retry can fix.
      if (message.simulate === "permanent") throw new PermanentError("Simulação: o Trello recusou o token (401)");
      if (message.simulate === "transient" && message.attempts === 1) throw new TransientError("Simulação: o Trello não respondeu (503)");
      const card = await deps.trello.createCard({
        title: plan.card!.title,
        description: `Mensagem do cliente:\n${message.text}\n\nProtocolo ${protocolOf(message.id)} · canal ${message.source}`,
        urgent: plan.card!.urgent,
        marker: `triage:${message.id}`,
      });
      return { ...card };
    }
    case "alert": {
      const cardUrl = (done.get("card")?.url as string | null | undefined) ?? null;
      const text = `Urgente · protocolo ${protocolOf(message.id)}\n${plan.card!.title}${cardUrl ? `\n${cardUrl}` : ""}`;
      if (!deps.opsChatId) return { simulated: true, text };
      const sent = await deps.telegram.send(deps.opsChatId, text);
      return { simulated: sent.simulated, text };
    }
  }
}

const STEP_LABELS: Record<Step, string> = { reply: "Resposta ao cliente", card: "Card no Trello", alert: "Alerta da equipe no Telegram" };

/**
 * Runs what is left for one message. Every finished step is recorded, so a
 * retry skips it: the customer is not answered twice and the model is not
 * called again for a message it already classified.
 */
export async function processMessage(deps: WorkerDeps, message: MessageRow): Promise<string> {
  const { repo } = deps;
  const done = await repo.steps(message.id);

  let stored = done.get("classify") as unknown as StoredClassification | undefined;
  if (!stored) {
    stored = await classifyMessage(deps, message.text);
    await repo.saveStep(message.id, "classify", stored as unknown as Record<string, unknown>);
    await repo.saveClassification(message.id, { category: stored.classification.category, urgent: stored.classification.urgent, method: stored.method });
    const how = stored.method === "model" ? "pelo modelo" : `por palavras-chave: ${stored.fallbackReason}`;
    await repo.event(message.id, "step", `Classificada como ${CATEGORY_LABELS[stored.classification.category]}${stored.classification.urgent ? ", urgente" : ""} ${how}${stored.forcedUrgent ? ". Marcada urgente por regra em código" : ""}`);
  }

  const plan = planFor(stored.classification, message.id);
  for (const step of plan.steps) {
    if (done.has(step)) continue;
    const result = await runStep(deps, message, plan, step, done);
    await repo.saveStep(message.id, step, result);
    done.set(step, result);
    const note = result.simulated || result.channel === "simulated" ? " (simulado: canal não configurado)" : result.reused ? " (já existia: nada foi duplicado)" : "";
    await repo.event(message.id, "step", `${STEP_LABELS[step]}: feito${note}`);
  }
  await repo.finish(message.id, plan.resolution);
  await repo.event(message.id, "done", plan.resolution === "auto_answered" ? "Resolvida automaticamente" : plan.resolution === "urgent" ? "Encaminhada como urgente" : "Encaminhada para a equipe");
  return plan.resolution;
}

export type RunOutcome = "idle" | "done" | "retry" | "dead";

/** Takes one due message from the queue and works on it. */
export async function runNext(deps: WorkerDeps): Promise<RunOutcome> {
  const message = await deps.repo.claimNext();
  if (!message) return "idle";
  await deps.repo.event(message.id, "attempt", `Tentativa ${message.attempts} de ${MAX_ATTEMPTS}`);
  try {
    await processMessage(deps, message);
    return "done";
  } catch (error) {
    const reason = errorMessage(error);
    if (isPermanent(error) || message.attempts >= MAX_ATTEMPTS) {
      await deps.repo.markDead(message.id, reason);
      await deps.repo.event(message.id, "dead", `${reason}. ${isPermanent(error) ? "Erro que repetir não resolve" : "Tentativas esgotadas"}: foi para a fila de falhas`);
      return "dead";
    }
    const wait = backoffSeconds(message.attempts);
    await deps.repo.scheduleRetry(message.id, wait, reason);
    await deps.repo.event(message.id, "retry_scheduled", `${reason}. Nova tentativa em ${wait} s`);
    return "retry";
  }
}

/** Works through due messages, within a budget so one request never runs for too long. */
export async function drain(deps: WorkerDeps, maxMessages = 5): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  while (outcomes.length < maxMessages) {
    const outcome = await runNext(deps);
    if (outcome === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}
