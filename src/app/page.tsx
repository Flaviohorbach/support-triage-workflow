import { TriageDesk } from "@/components/triage-desk";

export default function Home() {
  // Read on the server: the page only learns whether a channel is real, never its keys.
  const channels = {
    telegramBot: process.env.TELEGRAM_BOT_USERNAME || null,
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    trello: Boolean(process.env.TRELLO_API_KEY && process.env.TRELLO_TOKEN && process.env.TRELLO_LIST_ID),
    alerts: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OPS_CHAT_ID),
  };
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <p className="text-sm font-medium text-accent">Triagem de atendimento</p>
      <h1 className="mt-1 font-display text-3xl font-bold text-balance sm:text-4xl">Cada mensagem de cliente no lugar certo, mesmo quando algo falha</h1>
      <p className="mt-3 max-w-3xl text-muted">
        Mensagens chegam pelo Telegram ou por este formulário e entram numa fila. Um modelo classifica, e o código decide: responder sozinho, criar um card no Trello ou
        alertar a equipe. Falhas viram novas tentativas, e o que não se resolve vai para uma fila de falhas.
      </p>
      <TriageDesk channels={channels} />
      <footer className="mt-12 border-t border-line pt-4 text-sm text-muted">
        Projeto de portfólio, com uma loja fictícia. Mensagens aparecem neste painel público e são apagadas em 7 dias: não escreva dados pessoais.
      </footer>
    </main>
  );
}
