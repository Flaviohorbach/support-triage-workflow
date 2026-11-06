import { CATEGORY_LABELS, type Classification } from "./classify";
import { FAQ } from "./faq";

/** The side effects a message can have, in the order they run. */
export const STEPS = ["reply", "card", "alert"] as const;
export type Step = (typeof STEPS)[number];

export type Resolution = "auto_answered" | "to_team" | "urgent";

export interface Plan {
  resolution: Resolution;
  steps: Step[];
  reply: string;
  card: { title: string; urgent: boolean } | null;
}

/** Short protocol a customer can quote. Derived from the id, so a retry shows the same one. */
export const protocolOf = (messageId: string) => messageId.replace(/-/g, "").slice(0, 8).toUpperCase();

/**
 * The model labels, this code decides. Every text the customer reads is a
 * template or a human-written answer: no generated sentence reaches them.
 */
export function planFor(classification: Classification, messageId: string): Plan {
  const protocol = protocolOf(messageId);
  const label = CATEGORY_LABELS[classification.category];

  if (classification.urgent) {
    return {
      resolution: "urgent",
      steps: ["reply", "card", "alert"],
      reply: `Recebemos sua mensagem e ela foi marcada como prioridade. Uma pessoa da equipe vai falar com você em até 2 horas úteis. Protocolo ${protocol}.`,
      card: { title: `URGENTE · ${label}: ${classification.summary}`, urgent: true },
    };
  }

  if (classification.category === "duvida" && classification.faqTopic !== "nenhum") {
    return {
      resolution: "auto_answered",
      steps: ["reply"],
      reply: `${FAQ[classification.faqTopic]} Se isso não responder, é só escrever de novo que uma pessoa da equipe continua daqui.`,
      card: null,
    };
  }

  return {
    resolution: "to_team",
    steps: ["reply", "card"],
    reply: `Recebemos sua mensagem sobre ${label}. Uma pessoa da equipe responde em até 1 dia útil. Protocolo ${protocol}.`,
    card: { title: `${label[0]!.toUpperCase()}${label.slice(1)}: ${classification.summary}`, urgent: false },
  };
}
