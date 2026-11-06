"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Metrics } from "@/lib/db";
import { SCENARIOS } from "@/lib/scenarios";

interface Channels {
  telegramBot: string | null;
  telegram: boolean;
  trello: boolean;
  alerts: boolean;
}

interface MessageSummary {
  id: string;
  source: "web" | "telegram";
  text: string;
  status: "queued" | "processing" | "retry" | "done" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  category: string | null;
  urgent: boolean | null;
  method: string | null;
  resolution: string | null;
  createdAt: string;
}

interface Detail extends Omit<MessageSummary, "category" | "urgent" | "method"> {
  simulate: string | null;
  steps: { step: string; result: Record<string, unknown>; at: string }[];
  events: { kind: string; detail: string | null; at: string }[];
}

const CATEGORY: Record<string, string> = { troca: "Troca", atraso: "Atraso", duvida: "Dúvida", reclamacao_grave: "Reclamação grave", outro: "Outro" };
const PENDING = new Set(["queued", "processing", "retry"]);

function statusOf(m: Pick<MessageSummary, "status" | "resolution" | "nextAttemptAt">): { label: string; tone: string } {
  if (m.status === "queued") return { label: "Na fila", tone: "border-line text-muted" };
  if (m.status === "processing") return { label: "Processando", tone: "border-accent text-accent" };
  if (m.status === "retry") return { label: `Nova tentativa às ${new Date(m.nextAttemptAt).toLocaleTimeString("pt-BR")}`, tone: "border-warn text-warn" };
  if (m.status === "dead") return { label: "Fila de falhas", tone: "border-danger text-danger" };
  if (m.resolution === "auto_answered") return { label: "Resolvida sozinha", tone: "border-ok text-ok" };
  if (m.resolution === "urgent") return { label: "Urgente, com a equipe", tone: "border-danger text-danger" };
  return { label: "Com a equipe", tone: "border-ok text-ok" };
}

const decimal = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const seconds = (value: number | null) => (value === null ? "–" : value < 60 ? `${decimal(value)} s` : `${decimal(value / 60)} min`);
const percent = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const since = (start: string, at: string) => `+${decimal((new Date(at).getTime() - new Date(start).getTime()) / 1000)} s`;

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${ok ? "border-ok text-ok" : "border-line text-muted"}`}>{children}</span>;
}

export function TriageDesk({ channels }: { channels: Channels }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState(SCENARIOS[0]!.text);
  const [simulate, setSimulate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const selectedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/messages", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { metrics: Metrics; messages: MessageSummary[] };
      setMetrics(data.metrics);
      setMessages(data.messages);
      setLoadError(false);
      const id = selectedRef.current;
      if (id) {
        const one = await fetch(`/api/messages/${id}`, { cache: "no-store" });
        if (one.ok && selectedRef.current === id) setDetail(await one.json());
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  const tick = useCallback(() => fetch("/api/queue/tick", { method: "POST" }).catch(() => undefined), []);

  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      setSelected(id);
      setDetail(null);
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("msg", id);
      else url.searchParams.delete("msg");
      window.history.replaceState(null, "", url);
      void load();
    },
    [load],
  );

  // First load: open the message in the URL, and move anything that is due.
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("msg");
    selectedRef.current = id;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the URL once, on mount
    setSelected(id);
    void tick().then(load);
  }, [load, tick]);

  // Keep the screen current: messages also arrive from Telegram and other visitors.
  // While something is in the queue, check more often and move whatever is due.
  const pending = messages.some((m) => PENDING.has(m.status));
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (document.visibilityState !== "visible") return;
        const due = messages.some((m) => m.status === "queued" || ((m.status === "retry" || m.status === "processing") && new Date(m.nextAttemptAt).getTime() <= Date.now()));
        void (due ? tick().then(load) : load());
      },
      pending ? 4000 : 15000,
    );
    return () => clearInterval(timer);
  }, [pending, messages, load, tick]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, simulate }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Não foi possível enviar.");
      select(data.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function requeue(id: string) {
    const response = await fetch(`/api/messages/${id}/retry`, { method: "POST" });
    if (!response.ok) setError((await response.json()).error);
    await load();
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-labelledby="send-title" className="min-w-0">
        <h2 id="send-title" className="font-display text-lg font-semibold">Escreva como um cliente</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setText(s.text);
                setSimulate(s.simulate);
              }}
              aria-pressed={text === s.text && simulate === s.simulate}
              className="rounded-lg border border-line bg-surface p-2 text-left text-sm hover:border-accent aria-pressed:border-accent aria-pressed:bg-accent-soft"
            >
              <span className="block font-medium">{s.label}</span>
              <span className="block text-xs text-muted">{s.hint}</span>
            </button>
          ))}
        </div>
        <form onSubmit={send} className="mt-3">
          <label htmlFor="text" className="text-sm font-medium">
            Mensagem
          </label>
          <textarea
            id="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={600}
            className="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-sm"
          />
          {simulate && (
            <p className="mt-1 text-xs text-warn">
              {simulate === "transient" ? "Simulação: a criação do card falha na 1ª tentativa." : "Simulação: o Trello recusa o token, um erro que repetir não resolve."}{" "}
              <button type="button" className="underline" onClick={() => setSimulate(null)}>
                Desligar
              </button>
            </p>
          )}
          <button type="submit" disabled={busy || text.trim().length < 3} className="mt-2 w-full rounded-lg bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-60">
            {busy ? "Enviando…" : "Enviar"}
          </button>
          {error && (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          )}
        </form>
        <div className="mt-5 rounded-xl border border-line bg-surface p-3 text-sm">
          <p className="font-medium">Canais</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill ok={channels.telegram}>Telegram {channels.telegram ? "real" : "simulado"}</Pill>
            <Pill ok={channels.trello}>Trello {channels.trello ? "real" : "simulado"}</Pill>
            <Pill ok={channels.alerts}>Alertas {channels.alerts ? "reais" : "simulados"}</Pill>
          </div>
          {channels.telegramBot && (
            <p className="mt-2 text-muted">
              Ou escreva para{" "}
              <a className="text-accent underline" href={`https://t.me/${channels.telegramBot}`} target="_blank" rel="noreferrer">
                @{channels.telegramBot}
              </a>{" "}
              no Telegram.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="queue-title" className="min-w-0">
        <h2 id="queue-title" className="sr-only">
          Métricas e fila
        </h2>
        {loadError && <p className="mb-3 text-sm text-danger">Não foi possível carregar o painel. Tentando de novo…</p>}
        {metrics && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Mensagens" value={metrics.total} note={`${metrics.pending} na fila`} />
            <Tile label="Resolvidas sozinhas" value={percent(metrics.autoAnswered, metrics.done)} note={`${metrics.autoAnswered} de ${metrics.done} concluídas`} />
            <Tile label="1ª resposta (mediana)" value={seconds(metrics.replySeconds.p50)} note={`90% em até ${seconds(metrics.replySeconds.p90)}`} />
            <Tile label="Urgentes" value={metrics.urgent} note={`${metrics.toTeam} outras para a equipe`} />
            <Tile label="Novas tentativas" value={metrics.retries} />
            <Tile label="Fila de falhas" value={metrics.dead} />
            <Tile label="Sem o modelo" value={metrics.byKeywords} note="classificadas por palavras-chave" />
            <Tile label="Por assunto" value={metrics.categories[0] ? CATEGORY[metrics.categories[0].category] ?? "–" : "–"} note={metrics.categories.map((c) => `${CATEGORY[c.category] ?? c.category} ${c.count}`).join(" · ")} />
          </div>
        )}

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Últimas mensagens</h3>
            {messages.length === 0 && metrics && <p className="mt-2 text-sm text-muted">Nenhuma mensagem ainda. Envie uma ao lado.</p>}
            <ul className="mt-2 space-y-2">
              {messages.map((m) => {
                const status = statusOf(m);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => select(m.id)}
                      aria-current={m.id === selected}
                      className="w-full rounded-lg border border-line bg-surface p-2.5 text-left text-sm hover:border-accent aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft"
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${status.tone}`}>{status.label}</span>
                        {m.category && <span className="text-xs text-muted">{CATEGORY[m.category] ?? m.category}</span>}
                        {m.method === "keywords" && <span className="text-xs text-warn">sem modelo</span>}
                        <span className="ml-auto text-xs text-muted">{m.source === "telegram" ? "Telegram" : "Formulário"}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 block break-words">{m.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-w-0" aria-live="polite">
            <h3 className="text-sm font-medium">O que aconteceu</h3>
            {!selected && <p className="mt-2 text-sm text-muted">Escolha uma mensagem para ver cada passo, cada tentativa e o motivo.</p>}
            {selected && !detail && <p className="mt-2 text-sm text-muted">Carregando…</p>}
            {detail && (
              <div className="mt-2 rounded-xl border border-line bg-surface p-3 text-sm">
                <p className="break-words">“{detail.text}”</p>
                <ol className="mt-3 space-y-2 border-l border-line pl-3">
                  {detail.events.map((e, i) => (
                    <li key={i} className={e.kind === "dead" ? "text-danger" : e.kind === "retry_scheduled" ? "text-warn" : ""}>
                      <span className="mr-2 font-mono text-xs text-muted">{since(detail.createdAt, e.at)}</span>
                      {e.detail}
                    </li>
                  ))}
                  {PENDING.has(detail.status) && <li className="text-muted">{statusOf(detail).label}…</li>}
                </ol>
                {detail.steps
                  .filter((s) => s.step !== "classify")
                  .map((s) => (
                    <div key={s.step} className="mt-3 rounded-lg bg-surface-2 p-2.5">
                      <p className="text-xs font-medium text-muted">
                        {s.step === "reply" ? (s.result.channel === "web" ? "Resposta ao cliente (mostrada aqui)" : "Resposta enviada no Telegram") : s.step === "card" ? "Card no Trello" : "Alerta para a equipe"}
                        {(s.result.simulated === true || s.result.channel === "simulated") && " · simulado"}
                      </p>
                      {typeof s.result.text === "string" && <p className="mt-1 whitespace-pre-line break-words">{s.result.text}</p>}
                      {s.step === "card" && typeof s.result.url === "string" && <p className="mt-1 text-muted">Card criado no quadro privado da equipe.</p>}
                    </div>
                  ))}
                {detail.steps.some((s) => s.step === "classify") && <ClassifyBox result={detail.steps.find((s) => s.step === "classify")!.result} />}
                {detail.status === "dead" && (
                  <button type="button" onClick={() => requeue(detail.id)} className="mt-3 rounded-lg border border-accent px-3 py-1.5 text-accent hover:bg-accent-soft">
                    Corrigido? Devolver à fila
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function ClassifyBox({ result }: { result: Record<string, unknown> }) {
  const c = result.classification as { category: string; urgent: boolean; faqTopic: string; summary: string };
  return (
    <details className="mt-3 rounded-lg border border-line p-2.5">
      <summary className="cursor-pointer text-xs font-medium text-muted">
        Classificação {result.method === "model" ? "do modelo" : "por palavras-chave"} · {result.modelCalls === 1 ? "1 chamada de modelo" : `${result.modelCalls as number} chamadas de modelo`}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Assunto</dt>
        <dd>{CATEGORY[c.category] ?? c.category}</dd>
        <dt className="text-muted">Urgente</dt>
        <dd>{c.urgent ? `sim${result.forcedUrgent ? " (por regra em código)" : ""}` : "não"}</dd>
        <dt className="text-muted">Resposta pronta</dt>
        <dd>{c.faqTopic === "nenhum" ? "nenhuma" : c.faqTopic}</dd>
        <dt className="text-muted">Resumo</dt>
        <dd className="break-words">{c.summary}</dd>
        {typeof result.fallbackReason === "string" && (
          <>
            <dt className="text-muted">Por quê</dt>
            <dd className="text-warn">{result.fallbackReason}</dd>
          </>
        )}
      </dl>
    </details>
  );
}
