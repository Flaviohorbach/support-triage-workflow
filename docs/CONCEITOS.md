# Conceitos do módulo 9, explicados pelo projeto

Guia de estudo em português: como montar um fluxo automático com IA que continua funcionando quando alguma peça falha.

## 1. Workflow, não agente

No módulo 8, um agente decidia os próximos passos. Aqui, a ordem é fixa: receber, classificar, responder, criar o card e alertar. O modelo faz uma única coisa: dar um rótulo à mensagem.

Isso é um **workflow com IA**. Ele é mais barato, porque gasta 1 chamada por mensagem, é previsível e dá para testar cada caminho. Quando os passos são conhecidos de antemão, um agente só acrescenta custo e risco.

## 2. O modelo rotula, o código decide e escreve

Veja `src/triage/route.ts`. O modelo devolve categoria, urgência e tema de resposta pronta. Depois disso, tudo é código:

- **Quem recebe resposta automática:** só uma dúvida com tema conhecido. A regra está em `planFor`.
- **O texto que o cliente lê:** um modelo de mensagem ou uma resposta escrita por pessoas (`src/triage/faq.ts`). Nenhuma frase gerada chega ao cliente, então não há o que inventar. É a lição da frigideira do módulo 8.

**O que a avaliação mostrou:** o modelo anexou uma resposta pronta a 7 mensagens que não eram dúvidas, como "cadê meu pedido???", que recebeu o tema "rastreio". A regra ignorou esse campo e mandou as 7 para a equipe. Se a decisão fosse do modelo, 7 clientes com problema teriam recebido um texto pronto.

**Rede de segurança:** `applySafetyNet` marca como urgente qualquer mensagem com "Procon", "advogado" ou "fraude", mesmo que o modelo diga o contrário. Perder um caso urgente custa muito mais do que um alarme falso.

## 3. Fila: responder rápido, trabalhar depois

O Telegram reenvia uma mensagem se não receber resposta em poucos segundos. Por isso, `src/app/api/telegram/route.ts` só grava a mensagem e responde "ok". O trabalho roda em seguida, com `after()` do Next.js.

A fila é a própria tabela `messages`, com status, número de tentativas e horário da próxima tentativa. Não precisa de Redis nem de RabbitMQ para este volume.

**`FOR UPDATE SKIP LOCKED`** (em `claimNext`): duas execuções ao mesmo tempo nunca pegam a mesma mensagem. Cada uma trava a sua e pula as travadas.

**Lock com prazo:** se o processo morrer no meio, a mensagem fica "processando". Depois de 2 minutos, outra execução assume. Sem isso, uma queda deixaria a mensagem parada para sempre.

## 4. Idempotência: o mesmo efeito, mesmo repetindo

Há três lugares onde uma repetição poderia causar estrago:

| Repetição | Proteção |
| --- | --- |
| O Telegram entrega a mesma mensagem duas vezes | `UNIQUE (source, external_id)` com o `update_id` |
| Uma nova tentativa depois de uma falha | A tabela `steps`: cada passo concluído é gravado e não roda de novo |
| O card foi criado, mas o processo caiu antes de gravar | Antes de criar, o código procura no Trello um card com a marca `triage:<id>` |

O Trello não tem chave de idempotência, então a busca pela marca faz esse papel. O Telegram não tem nada parecido: se o processo cair entre enviar e gravar, o cliente pode receber a mesma resposta duas vezes. Isso se chama entrega **pelo menos uma vez** (*at-least-once*), e é o normal em sistemas distribuídos.

## 5. Erro temporário e erro permanente

Em `src/lib/errors.ts`:

- **Temporário:** queda de rede, tempo esgotado, 429 ou 5xx. Esperar e tentar de novo resolve.
- **Permanente:** token inválido (401) ou lista inexistente (404). Repetir só gasta tentativas.

O erro temporário ganha novas tentativas com **espera crescente** (*backoff*): 30 s, 2 min e 10 min. Isso dá tempo para o serviço se recuperar sem ser bombardeado. O permanente vai direto para a **fila de falhas** (*dead-letter queue*), onde uma pessoa corrige a causa e devolve a mensagem.

## 6. Degradar em vez de parar

Se o modelo falha ou a cota do dia acaba, a mensagem é classificada por palavras-chave (`classifyWithKeywords`). O cliente continua recebendo resposta, só que com uma triagem pior, e o painel mostra quantas foram classificadas assim.

**Quanto pior?** A avaliação mediu: as palavras-chave acertam o encaminhamento em 23 de 30 casos, e o modelo, em 30 de 30. O pior erro delas é dar resposta pronta para quem tem um problema ("Como faço pra rastrear? O pedido devia ter chegado semana passada"). Essa é a resposta para "quando vale usar IA?": aqui, ela evita respostas erradas para clientes com problema real.

## 7. Sem servidor ligado o tempo todo

O plano gratuito da Vercel não tem um processo rodando sem parar, e o agendamento roda só uma vez por dia. Então a fila anda de três jeitos:

1. Logo depois de cada mensagem nova (`after()`).
2. Enquanto o painel está aberto, que chama `/api/queue/tick`.
3. A cada 10 minutos, por um agendamento do GitHub Actions (`.github/workflows/queue-tick.yml`).

É uma solução de demo, e o README diz isso. Em produção, entraria um worker de verdade ou um serviço de fila.

## 8. Limites deste projeto, para dizer em entrevista

- **Pelo menos uma vez no Telegram:** uma resposta pode chegar duplicada se o processo cair no momento exato.
- **O painel é público:** quem tem o link vê as mensagens. Em produção, precisaria de login.
- **30 casos de avaliação**, escritos por quem escreveu o prompt. É pouco para afirmar que o modelo acerta sempre.
- **Limites em memória:** o limite por IP vale por instância do servidor.

## Exercícios

1. **Tire a regra das respostas prontas.** Faça `planFor` responder sozinho sempre que `faqTopic` não for "nenhum". Rode `npm run eval -- --keywords`: quantas respostas erradas aparecem?
2. **Quebre a idempotência.** Apague a busca pela marca em `createTrello` e pense: em que momento exato uma queda cria um card duplicado?
3. **Backoff com variação.** Por que sistemas grandes somam um valor aleatório à espera (*jitter*)? O que acontece quando mil mensagens falham no mesmo segundo?
4. **Prioridade.** Como fazer mensagens urgentes passarem na frente na fila? Basta mudar o `ORDER BY` de `claimNext`?
