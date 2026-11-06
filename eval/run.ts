// Classifies 30 labeled messages with the model and with keywords, then compares.
//   npm run eval                 model + keywords (spends about 30 model calls)
//   npm run eval -- --keywords   keywords only, no quota
// Resumable: model results are saved after each case, and a rerun skips them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createShopModel } from "../src/lib/model";
import { applySafetyNet, classifyWithKeywords, classifyWithModel, type Category, type Classification } from "../src/triage/classify";
import { planFor, type Resolution } from "../src/triage/route";

interface Case {
  id: string;
  text: string;
  category: Category;
  urgent: boolean;
  resolution: Resolution;
}

interface Run {
  classification: Classification;
  forcedUrgent: boolean;
  resolution: Resolution;
}

const RESULTS = "eval/results.json";
const cases: Case[] = JSON.parse(readFileSync("eval/cases.json", "utf8"));
const saved: Record<string, { model?: Run; modelMs?: number }> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")).runs : {};
const keywordsOnly = process.argv.includes("--keywords");

function run(c: Case, raw: Classification): Run {
  const { classification, forcedUrgent } = applySafetyNet(raw, c.text);
  return { classification, forcedUrgent, resolution: planFor(classification, c.id).resolution };
}

if (!keywordsOnly) {
  const model = createShopModel();
  for (const c of cases) {
    if (saved[c.id]?.model) continue;
    const start = performance.now();
    try {
      const classification = await classifyWithModel(model, c.text);
      saved[c.id] = { model: run(c, classification), modelMs: Math.round(performance.now() - start) };
      process.stdout.write(".");
    } catch (error) {
      console.error(`\n${c.id}: ${(error as Error).message.slice(0, 120)}. Run again later to resume.`);
      break;
    }
    writeFileSync(RESULTS, JSON.stringify({ runs: saved }, null, 1));
  }
  console.log();
}

function score(name: string, pick: (c: Case) => Run | undefined) {
  const done = cases.filter((c) => pick(c));
  const rows = done.map((c) => ({ c, r: pick(c)! }));
  const urgentCases = rows.filter(({ c }) => c.urgent);
  const flagged = rows.filter(({ r }) => r.classification.urgent);
  const result = {
    name,
    cases: done.length,
    category: rows.filter(({ c, r }) => r.classification.category === c.category).length,
    resolution: rows.filter(({ c, r }) => r.resolution === c.resolution).length,
    urgentCaught: urgentCases.filter(({ r }) => r.classification.urgent).length,
    urgentTotal: urgentCases.length,
    falseAlarms: flagged.filter(({ c }) => !c.urgent).length,
    // The worst mistake: a canned answer to someone who has a real problem.
    wrongAutoAnswers: rows.filter(({ c, r }) => r.resolution === "auto_answered" && c.resolution !== "auto_answered").map(({ c }) => c.id),
    missedUrgent: urgentCases.filter(({ r }) => !r.classification.urgent).map(({ c }) => c.id),
    savedBySafetyNet: rows.filter(({ r }) => r.forcedUrgent).map(({ c }) => c.id),
    // A ready answer attached to something that is not a question. The routing rule ignores it.
    blockedByRule: rows.filter(({ r }) => r.classification.faqTopic !== "nenhum" && r.classification.category !== "duvida").map(({ c }) => c.id),
    wrong: rows.filter(({ c, r }) => r.resolution !== c.resolution || r.classification.category !== c.category).map(({ c, r }) => `${c.id}: ${r.classification.category}/${r.resolution} (expected ${c.category}/${c.resolution})`),
  };
  console.log(`\n${name}: ${result.cases} cases`);
  console.log(`  category right     ${result.category}/${result.cases}`);
  console.log(`  routing right      ${result.resolution}/${result.cases}`);
  console.log(`  urgent caught      ${result.urgentCaught}/${result.urgentTotal}, false alarms ${result.falseAlarms}`);
  console.log(`  wrong auto-answers ${result.wrongAutoAnswers.length} ${result.wrongAutoAnswers.join(", ")}`);
  console.log(`  saved by the net   ${result.savedBySafetyNet.join(", ") || "none"}`);
  console.log(`  blocked by a rule  ${result.blockedByRule.length} ${result.blockedByRule.join(", ")}`);
  for (const line of result.wrong) console.log(`    ✗ ${line}`);
  return result;
}

const keywords = score("keywords", (c) => run(c, classifyWithKeywords(c.text)));
const model = score("model", (c) => saved[c.id]?.model);
const times = Object.values(saved).flatMap((s) => (s.modelMs ? [s.modelMs] : [])).sort((a, b) => a - b);
const at = (q: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))]! : null);
const latency = { p50: at(0.5), p90: at(0.9), max: at(1) };
if (times.length) console.log(`\nmodel latency over ${times.length} calls: median ${latency.p50} ms, p90 ${latency.p90} ms, max ${latency.max} ms`);
writeFileSync(RESULTS, JSON.stringify({ summary: { keywords, model, modelLatencyMs: latency }, runs: saved }, null, 1));
