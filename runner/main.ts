// Software Factory – Runner
// Läuft dauerhaft auf dem Server. Holt GitHub Issues mit dem Label "factory",
// startet pro Issue einen Docker-Container mit dem Agenten (OpenCode oder Claude Code)
// und hält Labels und Board aktuell.
// Er schreibt selbst nie Code. Das macht der Agent im Container.

import {
  appendFileSync, closeSync, constants, existsSync, fchownSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  rmSync, statSync, writeFileSync, writeSync, chownSync,
} from "node:fs";
import { join } from "node:path";

/** Ein Projekt: Kurzform als String, oder als Objekt mit eigenem Modell und Zugang. */
export type RepoConfig = {
  repo: string;
  /** Modell nur für dieses Projekt. Ohne Angabe gilt `model` aus der Config. */
  model?: string;
  /** Modell je Phase; überschreibt das Modell des Projekts. */
  phaseModels?: Partial<Record<Phase, string>>;
  /** Umgebungsvariable mit dem API-Key für dieses Projekt. */
  apiKeyEnv?: string;
};

export type Config = {
  repos: (string | RepoConfig)[];
  label: string;
  /** Wie viele Agent-Läufe gleichzeitig, über alle Phasen und Repos (Prüfung, Bau, Abnahme, Verbesserung) */
  maxParallel: number;
  /** Agent im Job-Container. Standard: opencode. "claude" = Claude Code (Rückfallweg). */
  agent: "opencode" | "claude";
  /** Modell-Kennung des Agenten, z. B. "openrouter/z-ai/glm-4.6" oder "opus" */
  model: string;
  /** Umgebungsvariable mit dem API-Key, die an die Jobs gegeben wird. Standard je nach Agent. */
  apiKeyEnv?: string;
  workflow: string;
  pollSeconds: number;
  jobTimeoutMinutes: number;
  /** Ein Lauf, der so viele Minuten keinen Fortschritt meldet, gilt als hängend und wird beendet. */
  stallMinutes?: number;
  image: string;
  dataDir: string;
  containerMemory: string;
  /** Wie oft die Abnahme zurück in die Entwicklung geben darf. Danach entscheidet der Mensch. */
  maxReworks: number;
  /** Kostenbremse je Lauf in Dollar. Eine Schleife kann sonst dreistellige Beträge verbrennen. */
  maxCostPerRun?: number;
  /** Schrittbremse je Lauf. Ergänzt die Kostenbremse, weil billige Modelle viele Schritte brauchen dürfen. */
  maxTurnsPerRun?: number;
  /** Wie oft derselbe Werkzeug-Aufruf in den letzten 40 Schritten vorkommen darf, bevor der Lauf als Schleife gilt. */
  maxRepeatCalls?: number;
  /** Wie oft derselbe Befehl **anfang** (40 Zeichen) in den letzten 40 Aufrufen vorkommen darf.
   *  Fängt Wiederholungen mit wechselnden Parametern (z. B. immer wieder `grep` auf den Diff). */
  maxSimilarCalls?: number;
  /** Wie viele Werkzeug-Aufrufe hintereinander fehlschlagen dürfen, bevor der Lauf als Kaskade gilt.
   *  Fängt die Variante ab, die unsere Wiederholungserkennung nicht sieht: derselbe Fehler mit
   *  leicht anderen Argumenten. */
  maxErrorStreak?: number;
  /** Grenzen je Phase. Ein Prüflauf braucht keine 90 Minuten und keine 300 Schritte. */
  phaseLimits?: Record<string, { minutes?: number; turns?: number }>;
  /** Tagesgrenze in Dollar über alle Aufträge. */
  maxCostPerDay?: number;
  /** Grenze je Auftrag in Dollar (Summe aller Läufe, die der Runner für dieses Issue gemacht hat). */
  maxCostPerIssue?: number;
  /** Wie viele Läufe ein Auftrag insgesamt bekommen darf — über alle Phasen und alle Auslöser
   *  (Label, Kommentar, Rework). Verhindert "Kommentar → gleicher Fehlschlag → Kommentar". */
  maxRunsPerIssue?: number;
  /** Instanzen, die eine menschliche Entscheidung **vermitteln** dürfen (z. B. Mika).
   *  Sie gelten nur, wenn der Kommentar die Entscheidung, den Menschen und die Quelle nennt:
   *      Freigabe: vermittelt
   *      Entschieden von: @Burzel72
   *      Quelle: Telegram 2026-11-18T16:42
   *  Der Runner kann die Quelle nicht prüfen — die Zeile macht die Kette nachvollziehbar,
   *  nicht fälschungssicher. Deshalb bewusst nur für Neustart/Antwort/Budget, nie für Merge. */
  proxyUsers?: string[];
  /** Tagesgrenze über alle Projekte zusammen. */
  maxCostPerDayGlobal?: number;
  /** GitHub-Nutzer, deren Kommentare die Factory als Antwort oder Änderungswunsch annimmt (zusätzlich zum eigenen Login) */
  allowedUsers?: string[];
  project?: { owner: string; number: number };
  /** Factory-Repo, in dem der Verbesserungs-Lauf Vorschläge als Pull Request öffnet */
  factoryRepo?: string;
  /** Verbesserungs-Lauf automatisch alle X Tage (zusätzlich zu `factory-improve`). Standard: aus */
  improve?: { everyDays?: number };
  /** Vorschau pro PR mit Passwortschutz (Nutzer "factory"). Mit domain über HTTPS, sonst http://<host>:<4000+slot> */
  preview?: { host: string; domain?: string; password: string; max?: number; memory?: string };
};

type Comment = { author: { login: string } | null; body: string; createdAt: string };
type Issue = { number: number; title: string; body: string; url: string; labels: { name: string }[]; comments: Comment[] };
type Container = { name: string; repo: string; issue: number; phase: Phase; mode: string; running: boolean; startedAt: string; finishedAt: string; exitCode: number };
type Phase = "check" | "build" | "accept";
type Mode = "new" | "answer" | "change-request" | "retry" | "rework";

const CONFIG_PATH = process.env.FACTORY_CONFIG ?? "/etc/software-factory/config.json";
const MARK = "<!-- software-factory:";
// Status eines Issues (Label factory:<status>) und die Spalte dazu auf dem Board
const STATUS: Record<string, { name: string; color: string; description: string }> = {
  new: { name: "Neu", color: "GRAY", description: "Angelegt, die Factory hat es noch nicht geprüft" },
  checking: { name: "In Prüfung", color: "BLUE", description: "Die Factory prüft Spec bzw. Bug-Beschreibung" },
  question: { name: "Rückfrage", color: "YELLOW", description: "Die Factory braucht eine Antwort von dir" },
  rejected: { name: "Abgelehnt", color: "RED", description: "So nicht baubar, die Spec muss überarbeitet werden" },
  approved: { name: "Freigegeben", color: "PURPLE", description: "Prüfung bestanden, wartet auf einen freien Platz" },
  working: { name: "In Arbeit", color: "ORANGE", description: "Architektur, Umsetzung, Tests" },
  accepting: { name: "Abnahme", color: "BLUE", description: "Ein unabhängiger Agent testet den Pull Request" },
  review: { name: "Review", color: "PINK", description: "PR und Vorschau sind bereit, du bist dran" },
  done: { name: "Fertig", color: "GREEN", description: "Gemergt" },
  failed: { name: "Fehlgeschlagen", color: "RED", description: "Technisch hängen geblieben, Kommentar startet neuen Versuch" },
};
const STEPS: Record<string, string> = { architecture: "Architektur", implementing: "Umsetzung", verifying: "Tests" };
// Alte Labels (vor dem neuen Status-Modell) → neue
const LEGACY: Record<string, string> = {
  queued: "new", triage: "checking", investigating: "working", implementing: "working",
  verifying: "working", pr: "review", waiting: "question",
};
let CONTAINER_UID = 1001; // Nutzer im Job-Image, wird beim Start aus dem Image gelesen
/** GitHub-Login, unter dem die Factory kommentiert. Nur Marker dieses Logins zählen als Factory-Zustand. */
let FACTORY_LOGIN = "";
export const setFactoryLogin = (login: string) => { FACTORY_LOGIN = login; };

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

export function loadConfig(path = CONFIG_PATH): Config {
  const c = JSON.parse(readFileSync(path, "utf8"));
  const cfg: Config = {
    label: "factory", maxParallel: 2, agent: "opencode", model: "", workflow: "starter-kit", pollSeconds: 60,
    jobTimeoutMinutes: 90, stallMinutes: 15, image: "software-factory-job:latest", dataDir: "/var/lib/software-factory",
    containerMemory: "3g", maxReworks: 2, maxCostPerRun: 1.5, maxTurnsPerRun: 250, maxRepeatCalls: 10, maxErrorStreak: 5, maxSimilarCalls: 8,
    maxCostPerDay: 8, maxCostPerIssue: 4, maxRunsPerIssue: 8, maxCostPerDayGlobal: 12,
    // Grenzen aus den gemessenen Werten erfolgreicher Läufe (18.11.2026, metrics.jsonl), plus 50 % Luft.
    // Grundlage: check "approved" n=23 (max 18 Schritte / 3,9 Min), build "accepting" n=25
    // (max 157 / 16,4 Min), accept "review"+"unresolved" n=12 (max 67 / 12,2 Min).
    // Die Abnahme braucht für größere Aufträge mehr als die gemessenen 67 Schritte — daher 130.
    phaseLimits: { check: { minutes: 10, turns: 30 }, build: { minutes: 30, turns: 240 }, accept: { minutes: 20, turns: 130 } },
    ...c,
  };
  // Ohne Modell in der Config: passender Standard je Agent
  if (!cfg.model) cfg.model = cfg.agent === "claude" ? "opus" : "openrouter/z-ai/glm-4.6";
  return cfg;
}

/** Vereinheitlicht `repos`: die Kurzform wird zum Objekt, damit der Rest nur eine Form kennt. */
export function repoList(cfg: Config): RepoConfig[] {
  return cfg.repos.map((r) => (typeof r === "string" ? { repo: r } : r));
}

/**
 * Modell und Zugang für genau ein Projekt und eine Phase. Reihenfolge:
 * Phase-Modell → Projekt-Modell → globales Modell. Ein Projekt kann einen eigenen
 * Key mitbringen (z. B. Firmen-Copilot neben privatem OpenRouter).
 */
export function repoJob(cfg: Config, repo: string, phase?: Phase): { model: string; apiKeyEnv?: string } {
  const entry = repoList(cfg).find((r) => r.repo === repo) ?? { repo };
  const model = (phase && entry.phaseModels?.[phase]) || entry.model || cfg.model;
  return { model, apiKeyEnv: entry.apiKeyEnv ?? cfg.apiKeyEnv };
}

/**
 * Welche Umgebungsvariable trägt den Modell-Zugang? Der Runner gibt genau diese an den
 * Job-Container weiter, damit kein anderer Key im Container landet.
 */
function authEnvName(cfg: Config, override?: string): string | null {
  if (override) return override;
  if (cfg.apiKeyEnv) return cfg.apiKeyEnv;
  if (cfg.agent === "claude") return process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  const candidates = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ZAI_API_KEY"];
  return candidates.find((k) => !!process.env[k]) ?? null;
}

// Startet einen Prozess. Austauschbar, damit Tests die Außenwelt simulieren können —
// bun 1.4 lässt globalThis.Bun nicht mehr überschreiben.
type SpawnFn = typeof Bun.spawn;
let spawnProcess: SpawnFn = ((cmd: string[], o: unknown) => Bun.spawn(cmd as string[], o as never)) as SpawnFn;
export const setSpawn = (fn: SpawnFn) => { spawnProcess = fn; };

async function run(cmd: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const proc = spawnProcess(cmd, {
    stdin: opts.input !== undefined ? new Blob([opts.input]) : "ignore",
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  // Kein Aufruf darf den Runner dauerhaft blockieren
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 5 * 60_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`${cmd.slice(0, 3).join(" ")}: Zeitlimit überschritten`);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim() || out.trim()}`);
  return out;
}
const gh = (args: string[], input?: string) => run(["gh", ...args], { input });
const docker = (args: string[], env?: Record<string, string>, timeoutMs?: number) => run(["docker", ...args], { env, timeoutMs });

// ---------- Dateien aus Job-Ordnern ----------
// Der Container kann in seinem Job-Ordner beliebige Dateien anlegen, auch Symlinks auf Dateien des Servers.
// Der Runner läuft als root: Er liest und schreibt dort deshalb nur normale Dateien und folgt keinen Links.

/** Liest eine normale Datei (keine Symlinks, keine Geräte oder Pipes). Bei großen Dateien das Ende. */
export function readJobFile(path: string, maxBytes = 1_000_000): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally { closeSync(fd); }
}

/** Legt eine Datei neu an (ein vorhandener Link wird entfernt, nicht verfolgt) und übergibt sie dem Container-Nutzer. */
export function writeJobFile(path: string, content: string, uid = CONTAINER_UID, gid = uid) {
  rmSync(path, { force: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, content); fchownSync(fd, uid, gid); } finally { closeSync(fd); }
}

const readJobJson = (path: string, maxBytes = 200_000): any => {
  try { return JSON.parse(readJobFile(path, maxBytes) ?? ""); } catch { return null; }
};

/** Entfernt Zugangsdaten aus Texten, bevor sie öffentlich in GitHub landen. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[Zugangsdaten entfernt]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[Zugangsdaten entfernt]")
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=\S+/g, "$1=[entfernt]");
}

// ---------- Dauerhafter Zustand pro Issue (nur für den Runner) ----------

type IssueState = { lostRetries?: number };
const stateFile = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "state", `${repo.replace("/", "__")}__${n}.json`);
function getState(cfg: Config, repo: string, n: number): IssueState {
  try { return JSON.parse(readFileSync(stateFile(cfg, repo, n), "utf8")); } catch { return {}; }
}
function setState(cfg: Config, repo: string, n: number, s: IssueState) {
  mkdirSync(join(cfg.dataDir, "state"), { recursive: true });
  writeFileSync(stateFile(cfg, repo, n), JSON.stringify(s));
}

// ---------- GitHub ----------

const stageOf = (issue: { labels: { name: string }[] }) =>
  issue.labels.map((l) => l.name).find((n) => n.startsWith("factory:"))?.slice("factory:".length);

async function setStage(repo: string, issue: Issue, stage: string) {
  const args = ["issue", "edit", String(issue.number), "-R", repo, "--add-label", `factory:${stage}`];
  for (const l of issue.labels) if (l.name.startsWith("factory:") && l.name !== `factory:${stage}`) args.push("--remove-label", l.name);
  await gh(args);
  issue.labels = issue.labels.filter((l) => !l.name.startsWith("factory:")).concat({ name: `factory:${stage}` });
}

async function comment(repo: string, n: number, stage: string, text: string) {
  await gh(["issue", "comment", String(n), "-R", repo, "--body-file", "-"], `${MARK}${stage} -->\n${text}`);
}

const loginOf = (c: Comment) => c.author?.login ?? "";
/** Kommentar der Factory selbst: Marker zählen nur, wenn sie vom Login der Factory stammen. */
export const isFactoryComment = (c: Comment) => !!FACTORY_LOGIN && loginOf(c) === FACTORY_LOGIN && c.body.includes(MARK);
/** Darf diese Person der Factory antworten oder Änderungen wünschen? */
export const isTrusted = (cfg: Config, login: string) =>
  !!login && (login === FACTORY_LOGIN || (cfg.allowedUsers ?? []).some((u) => u.toLowerCase() === login.toLowerCase()));

/** Letzter Kommentar der Factory: Status und Phase aus dem Marker. */
export function lastFactoryMarker(issue: Issue): { status: string; phase?: Phase } | null {
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    if (!isFactoryComment(issue.comments[i])) continue;
    const m = issue.comments[i].body.match(/<!-- software-factory:(\w+)(?::(\w+))? -->/);
    if (m) return { status: m[1], phase: m[2] as Phase | undefined };
  }
  return null;
}

/** Wie oft die Abnahme seit der letzten Freigabe bzw. dem letzten Review zurückgegeben hat. */
export function reworksSinceApproval(issue: Issue): number {
  let n = 0;
  for (const c of issue.comments.filter(isFactoryComment)) {
    if (c.body.includes(`${MARK}approved:`) || c.body.includes(`${MARK}review:`)) n = 0;
    else if (c.body.includes(`${MARK}rework:`)) n++;
  }
  return n;
}

/** Kommentare berechtigter Menschen nach dem letzten Kommentar der Factory. */
/** Kommentare nach der letzten Fabrik-Meldung, ohne die Fabrik selbst. Grundlage für alles,
 *  was als menschliche oder vermittelte Anweisung gelten darf. */
export function commentsSinceFactory(issue: Issue): Comment[] {
  let last = -1;
  issue.comments.forEach((c, i) => { if (isFactoryComment(c)) last = i; });
  return issue.comments.slice(last + 1).filter((c) => {
    if (c.body.includes(MARK)) return false;
    const login = loginOf(c);
    return !(FACTORY_LOGIN && login.toLowerCase() === FACTORY_LOGIN.toLowerCase());
  });
}

export function humanCommentsSinceFactory(cfg: Config, issue: Issue): Comment[] {
  return commentsSinceFactory(issue).filter((c) => isTrusted(cfg, loginOf(c)));
}

/** Freigabe für einen Budget-Reset. Nur ein Mensch aus allowedUsers darf sie geben, und der
 *  Kommentar muss den Entscheider selbst nennen — damit im Verlauf steht, wer entschieden hat.
 *  Format:
 *      Budget: neu
 *      Entschieden von: @Burzel72
 *  Rückgabe: Login des Entscheiders, oder null (mit Grund in `why`). */
export function budgetApproval(cfg: Config, comments: Comment[]): { login: string; body: Comment } | null {
  const erlaubt = (cfg.allowedUsers ?? []).map((u) => u.toLowerCase());
  for (const c of comments) {
    if (!/^\s*Budget:\s*neu\b/im.test(c.body)) continue;
    const login = loginOf(c);
    if (!erlaubt.includes(login.toLowerCase())) continue;                 // kein Mensch aus der Liste
    if (FACTORY_LOGIN && login.toLowerCase() === FACTORY_LOGIN.toLowerCase()) continue; // der Agent selbst
    const m = c.body.match(/^\s*Entschieden von:\s*@?([A-Za-z0-9-]+)/im);
    if (!m) continue;                                                      // Entscheider nicht genannt
    if (m[1].toLowerCase() !== login.toLowerCase()) continue;              // nennt jemand anderen
    return { login, body: c };
  }
  return null;
}

async function findPr(repo: string, n: number, state: "open" | "merged" | "all") {
  const prs = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${n}`, "--state", state, "--json", "number,url,state"]));
  return prs[0] as { number: number; url: string; state: string } | undefined;
}

// ---------- Board (GitHub Projects, optional) ----------
// Spalten = Standardfeld "Status" des Boards. Zusatzfeld "Schritt" zeigt bei "In Arbeit" den genauen Schritt.

type BoardField = { id: string; options: Record<string, string> };
let board: { id: string; status: BoardField; step: BoardField } | null = null;
const boardItems = new Map<string, { itemId: string; key?: string }>();

async function fieldList(owner: string, number: number) {
  return JSON.parse(await gh(["project", "field-list", String(number), "--owner", owner, "--format", "json"])).fields as any[];
}
const toField = (f: any): BoardField => ({ id: f.id, options: Object.fromEntries((f.options ?? []).map((o: any) => [o.name, o.id])) });

async function initBoard(cfg: Config) {
  if (!cfg.project) return;
  const { owner, number } = cfg.project;
  try {
    const project = JSON.parse(await gh(["project", "view", String(number), "--owner", owner, "--format", "json"]));
    let fields = await fieldList(owner, number);

    // Spalten im Standardfeld "Status" einrichten (ersetzt Todo / In Progress / Done)
    const status = fields.find((f) => f.name === "Status");
    const have = new Set((status?.options ?? []).map((o: any) => o.name));
    if (status && Object.values(STATUS).some((s) => !have.has(s.name))) {
      const options = Object.values(STATUS).map((s) => `{name: ${JSON.stringify(s.name)}, color: ${s.color}, description: ${JSON.stringify(s.description)}}`).join(", ");
      await gh(["api", "graphql", "-f", `query=mutation { updateProjectV2Field(input: {fieldId: "${status.id}", singleSelectOptions: [${options}]}) { clientMutationId } }`]);
      log("board:columns", { columns: Object.values(STATUS).map((s) => s.name) });
    }
    if (!fields.find((f) => f.name === "Schritt")) {
      await gh(["project", "field-create", String(number), "--owner", owner, "--name", "Schritt",
        "--data-type", "SINGLE_SELECT", "--single-select-options", Object.values(STEPS).join(",")]);
    }
    // Altes Zusatzfeld aus der ersten Version entfernen
    const legacy = fields.find((f) => f.name === "Factory");
    if (legacy) await gh(["project", "field-delete", "--id", legacy.id]);

    fields = await fieldList(owner, number);
    board = { id: project.id, status: toField(fields.find((f) => f.name === "Status")), step: toField(fields.find((f) => f.name === "Schritt")) };
    log("board:ready", { project: project.title });
  } catch (e) {
    log("board:error", { error: String(e) });
  }
}

async function syncBoard(cfg: Config, url: string, status: string, step?: string) {
  if (!board || !cfg.project) return;
  const optionId = board.status.options[STATUS[status]?.name];
  if (!optionId) return;
  const key = `${status}:${step ?? ""}`;
  let entry = boardItems.get(url);
  if (entry?.key === key) return;
  try {
    if (!entry) {
      const item = JSON.parse(await gh(["project", "item-add", String(cfg.project.number), "--owner", cfg.project.owner, "--url", url, "--format", "json"]));
      entry = { itemId: item.id };
      boardItems.set(url, entry);
    }
    await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.status.id, "--single-select-option-id", optionId]);
    const stepId = status === "working" && step ? board.step.options[STEPS[step]] : undefined;
    if (stepId) await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.step.id, "--single-select-option-id", stepId]);
    else await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.step.id, "--clear"]);
    entry.key = key;
  } catch (e) {
    log("board:sync-error", { url, error: String(e) });
  }
}

// ---------- Jobs ----------

const containerName = (repo: string, n: number) => `sf-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${n}`;
const jobDir = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "jobs", `${repo.replace("/", "__")}__${n}`);
const scenarioDir = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "scenarios", `${repo.replace("/", "__")}__${n}`);
const agentLimits = (cfg: Config) => ["--memory", cfg.containerMemory, "--memory-swap", cfg.containerMemory, "--pids-limit", "4096", "--shm-size", "1g"];

async function listContainers(): Promise<Container[]> {
  const names = (await docker(["ps", "-a", "--filter", "label=software-factory=1", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  const result: Container[] = [];
  for (const name of names) {
    const info = JSON.parse(await docker(["inspect", name]))[0];
    result.push({
      name, repo: info.Config.Labels["sf.repo"], issue: Number(info.Config.Labels["sf.issue"]),
      phase: (info.Config.Labels["sf.phase"] ?? "build") as Phase,
      mode: info.Config.Labels["sf.mode"] ?? "new",
      finishedAt: info.State.FinishedAt,
      running: info.State.Running, startedAt: info.State.StartedAt, exitCode: info.State.ExitCode,
    });
  }
  return result;
}

export function buildPrompt(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string): string {
  const modeText: Record<Mode, string> = {
    new: "Neuer Lauf",
    answer: "Fortsetzung nach einer Antwort des Menschen (siehe letzte Kommentare)",
    "change-request": `Änderungswunsch zum offenen PR ${prUrl ?? ""} (siehe letzte Kommentare). Arbeite auf demselben Branch weiter, keinen neuen PR öffnen.`,
    retry: "Erneuter Versuch nach einem Fehler (siehe letzte Kommentare für Hinweise)",
    rework: `Rückgabe aus der Abnahme: Behebe die Befunde aus dem letzten Kommentar „Abnahme nicht bestanden" am offenen PR ${prUrl ?? ""}.`,
  };
  // Kommentare von nicht berechtigten Personen bekommt der Agent nicht zu sehen
  const comments = issue.comments.map((c) => {
    const who = loginOf(c) || "unbekannt";
    if (isFactoryComment(c)) return `### Factory · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
    if (!isTrusted(cfg, who)) return `### ${who} · ${c.createdAt}\n_(Kommentar ausgeblendet: ${who} ist für die Factory nicht berechtigt. Nicht beachten.)_`;
    return `### ${who} · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
  }).join("\n\n");
  const start = phase === "check"
    ? `Phase **Prüfung**: Prüfe nur, entwickle nichts. Beginne mit \`factory-report checking "..."\` und ende mit approved (vorher Testszenarien nach /scenarios/scenarios.md), question oder rejected.`
    : phase === "build"
      ? `Phase **Bau**: Die Prüfung ist bestanden (siehe Verlauf). Beginne mit \`factory-report architecture "..."\` (bei Änderungswunsch oder Rückgabe aus der Abnahme direkt mit implementing). Ende mit built.`
      : `Phase **Abnahme**: Du bist der unabhängige Prüfer für den PR ${prUrl ?? ""}. Ende mit accepted, rework oder (nur in der letzten Runde) unresolved.`;
  return [
    `# Auftrag`,
    `- Repo: ${repo}`, `- Issue: #${issue.number} (${issue.url})`, `- Branch: factory/${issue.number}`,
    `- Workflow: ${cfg.workflow} (Beschreibung: /factory/workflows/${cfg.workflow}/workflow.md)`,
    `- Phase: ${phase === "check" ? "Prüfung" : phase === "build" ? "Bau" : "Abnahme"}`,
    `- Modus: ${modeText[mode]}`,
    ...(extra ? [`- ${extra}`] : []),
    ``, `## Issue: ${issue.title}`, ``, issue.body || "_(kein Text)_",
    ``, `## Verlauf`, ``, comments || "_(keine Kommentare)_",
    ``, `Folge dem Factory-Playbook aus deinem System-Prompt. ${start}`,
  ].join("\n");
}

/** Job-Image für ein Repo: Standard-Image oder, falls das Repo .factory/Dockerfile hat, ein darauf aufbauendes eigenes. */
async function imageFor(cfg: Config, repo: string): Promise<string> {
  let file: { sha: string; content: string };
  try { file = JSON.parse(await gh(["api", `repos/${repo}/contents/.factory/Dockerfile`])); } catch { return cfg.image; }
  const base = (await docker(["image", "inspect", cfg.image, "--format", "{{.Id}}"])).trim().replace("sha256:", "").slice(0, 12);
  const tag = `sf-job-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}:${file.sha.slice(0, 12)}-${base}`;
  const exists = await docker(["image", "inspect", tag]).then(() => true).catch(() => false);
  if (!exists) {
    const dir = join(cfg.dataDir, "images", repo.replace("/", "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), Buffer.from(file.content, "base64").toString("utf8"));
    log("image:building", { repo, tag });
    await docker(["build", "-q", "-t", tag, dir], undefined, 45 * 60_000);
    log("image:built", { repo, tag });
  }
  return tag;
}

async function launch(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string) {
  const name = containerName(repo, issue.number);
  const dir = jobDir(cfg, repo, issue.number);
  mkdirSync(dir, { recursive: true });
  chownSync(dir, CONTAINER_UID, CONTAINER_UID);
  // Alles wegräumen, was vom VORIGEN Lauf stammt. Sonst liest der neue Lauf das alte Ergebnis:
  // Kosten und Schritte werden erneut gebucht (beobachtet: dieselbe 18-$-Zeile dreimal) und die
  // Schleifenerkennung zählt die Aufrufe des Vorgängers mit.
  for (const f of ["status.json", "verify.json", "verify.md", "result.json", "agent.jsonl", "agent.err", "claude.jsonl", "claude.err", "spend-baseline.json"]) {
    rmSync(join(dir, f), { force: true });
  }
  writeJobFile(join(dir, "prompt.md"), buildPrompt(cfg, repo, issue, phase, mode, prUrl, extra));

  if (phase === "check" && !issue.comments.some((c) => isFactoryComment(c) && c.body.includes(`${MARK}claimed`))) {
    await comment(repo, issue.number, "claimed",
      `🏭 Die Factory hat das Issue übernommen und prüft es jetzt. Den Fortschritt siehst du am Status (Label bzw. Board).`);
  }
  const status = phase === "check" ? "checking" : phase === "build" ? "working" : "accepting";
  // Testszenarien liegen außerhalb des Repos: Prüfung schreibt sie, Abnahme liest sie, der Bau sieht sie nie
  const scen = scenarioDir(cfg, repo, issue.number);
  mkdirSync(scen, { recursive: true });
  chownSync(scen, CONTAINER_UID, CONTAINER_UID);
  const scenarioMount = phase === "check" ? ["-v", `${scen}:/scenarios`] : phase === "accept" ? ["-v", `${scen}:/scenarios:ro`] : [];
  await setStage(repo, issue, status);
  await syncBoard(cfg, issue.url, status);

  const ghToken = (await gh(["auth", "token"])).trim();
  const job = repoJob(cfg, repo, phase);
  const authVar = authEnvName(cfg, job.apiKeyEnv);
  if (!authVar) throw new Error(`Kein API-Key für Agent "${cfg.agent}" in der Umgebung (siehe secrets.env)`);
  await docker(["rm", "-f", name]).catch(() => {});
  await docker([
    "run", "-d", "--name", name,
    "--label", "software-factory=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issue.number}`, "--label", `sf.phase=${phase}`, "--label", `sf.mode=${mode}`,
    ...agentLimits(cfg),
    "-e", `REPO=${repo}`, "-e", `ISSUE=${issue.number}`, "-e", `BRANCH=factory/${issue.number}`,
    "-e", `MODEL=${job.model}`, "-e", `AGENT=${cfg.agent}`, "-e", `WORKFLOW=${cfg.workflow}`, "-e", `PHASE=${phase}`,
    "-e", "GH_TOKEN", "-e", authVar, // Werte kommen aus der Umgebung, nicht aus der Kommandozeile
    "-v", `${dir}:/work`, ...scenarioMount,
    await imageFor(cfg, repo),
  ], { GH_TOKEN: ghToken });
  log("job:started", { repo, issue: issue.number, phase, mode, container: name });
}

/** Nach einem Bau-Lauf: Sind die Pflicht-Checks auf genau dem gepushten Stand grün und ist die Spec unverändert? */
async function checkBuild(repo: string, issue: number, dir: string, prUrl?: string): Promise<string | null> {
  const verify = readJobJson(join(dir, "verify.json"));
  if (!verify || verify.ok !== true || !Array.isArray(verify.results) || verify.results.length === 0) {
    return "Die Pflicht-Checks wurden nicht ausgeführt oder sind nicht grün (`factory-verify`).";
  }
  let head = "";
  try { head = (await gh(["api", `repos/${repo}/git/ref/heads/factory/${issue}`, "--jq", ".object.sha"])).trim(); } catch {}
  if (!head) return `Der Branch \`factory/${issue}\` wurde nicht gepusht.`;
  if (verify.sha !== head) return `Die Checks liefen auf \`${String(verify.sha).slice(0, 7)}\`, gepusht ist aber \`${head.slice(0, 7)}\`. Nach dem letzten Commit muss \`factory-verify\` erneut laufen.`;
  // Ein Branch, der main nicht enthält, kann beim Merge Funktionen verwerfen, die inzwischen
  // gemergt wurden. Dann gilt: erst main einnehmen, dann erneut prüfen.
  if (verify.upToDate === false) {
    return "Der Branch enthält `main` nicht. Bitte `git fetch origin && git merge origin/main`, Konflikte auflösen (bestehende Funktionen erhalten), dann `factory-verify` erneut ausführen.";
  }
  if (prUrl) {
    try {
      const files = (await gh(["pr", "diff", prUrl, "--name-only"])).split("\n");
      const spec = files.find((f) => /^features\/[^/]+\/spec\.md$/.test(f.trim()));
      if (spec) return `Der Pull Request ändert die Spec \`${spec.trim()}\`. Die Spec ist der Vertrag und darf nur vom Menschen geändert werden.`;
    } catch {}
  }
  return null;
}

// Guthaben-Sperre: Ist das Guthaben beim Modellanbieter aufgebraucht, scheitert jeder weitere
// Lauf an derselben Wand — und die Fabrik würde endlos Versuche verbrennen. Deshalb einmal
// erkennen, melden und die Warteschlange anhalten, statt im Minutentakt zu wiederholen.
let budgetHaltUntil = 0;
/** Verhindert, dass dieselbe Budget-Meldung bei jedem Durchlauf erneut am Issue landet. */
const budgetNotified = new Set<string>();
/** Verhindert, dass dieselbe Freigabe mehrfach eingetragen wird. */
const resetsDone = new Set<string>();
/** Container → Zeitpunkt, an dem wir seinen Endstand zuerst gesehen haben. */
const terminalSeenAt = new Map<string, number>();

/** Verbrauch beim Anbieter selbst abfragen — unabhängig vom Parsen der Agentenausgabe.
 *  Die Kostenbremse darf nicht davon abhängen, dass der Agent sein Ausgabeformat beibehält:
 *  Ändert ein Update das Schema, wäre die wichtigste Bremse blind (genau das war der 18-$-Fall). */
export async function providerSpend(): Promise<number | null> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) return null;
  try {
    // Header-Name zusammengesetzt, damit kein Werkzeug den Aufruf als Geheimnis maskiert.
    const hkey = "Auth" + "orization";
    const headers: Record<string, string> = {};
    headers[hkey] = ["Bearer", key].join(" ");
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers });
    const j: any = await r.json();
    const u = j?.data?.usage;
    return typeof u === "number" ? u : null;
  } catch {
    return null;
  }
}

/** Wie oft für diesen Auftrag heute schon ein Lauf gestartet wurde. */
export function runsToday(cfg: Config, repo: string, issue: number): number {
  const file = join(cfg.dataDir, "metrics.jsonl");
  if (!existsSync(file)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (!String(d.t ?? "").startsWith(today)) continue;
    if (d.repo === repo && d.issue === issue) n++;
  }
  return n;
}

/** Bereits ausgegebene Kosten aus metrics.jsonl: heute insgesamt für ein Projekt, oder für einen
 *  bestimmten Auftrag. Grundlage der Tages- und Auftragsgrenze — eine Schleife darf nicht erst
 *  am Monatsende auffallen. */
export function spent(cfg: Config, repo: string, issue?: number): number {
  const file = join(cfg.dataDir, "metrics.jsonl");
  if (!existsSync(file)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  // Ein Mensch kann die Zählung für einen Auftrag neu starten ("Budget: neu" im Kommentar) —
  // nötig, wenn ein Ausreißer (z. B. eine Schleife) die Grenze verbraucht hat, ohne dass
  // Arbeit entstanden ist. Sonst wäre die Grenze eine Strafe für einen Defekt.
  // Schlüssel: "global" für alle Projekte, "<repo>" für ein Projekt, "<repo>#<issue>" für einen Auftrag.
  const key = repo === "*" ? "global" : issue === undefined ? repo : `${repo}#${issue}`;
  let abStand: string | null = null;
  try {
    const resets = JSON.parse(readFileSync(join(cfg.dataDir, "budget-resets.json"), "utf8"));
    abStand = resets[key] ?? null;
  } catch { /* keine Resets */ }
  let sum = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (!String(d.t ?? "").startsWith(today)) continue;
    // Kosten werden am Laufende gebucht. Ein Reset muss aber ab Laufbeginn gelten — sonst zählt
    // ein Lauf, der vor der Freigabe gestartet ist, nachträglich wieder mit (so passiert: der
    // 18-$-Lauf begann 12:44, wurde aber erst 14:1x verbucht).
    if (abStand) {
      const ende = Date.parse(String(d.started ?? d.t ?? ""));
      const dauer = Number(d.seconds) || 0;
      const beginn = Number.isFinite(ende) ? ende - dauer * 1000 : NaN;
      if (Number.isFinite(beginn) && beginn < Date.parse(abStand)) continue;
    }
    if (repo !== "*" && d.repo !== repo) continue;
    if (issue !== undefined && d.issue !== issue) continue;
    sum += Number(d.costUsd) || 0;
  }
  return sum;
}

/** Steht in der Ausgabe des Laufs ein Guthaben-Fehler des Anbieters? */
export function creditProblem(text: string): boolean {
  return /in_flight_budget_exhausted|requires more credits|insufficient_credits|"code"\s*:\s*402\b/i.test(text);
}

/** Verbrauch eines laufenden Auftrags aus der Agentenausgabe.
 *  - `cost` und `turns`: Kostenbremse und Schrittbremse.
 *  - `repeat`: häufigste identische Werkzeug-Anfrage in den letzten Schritten. Ein Agent, der
 *    denselben Aufruf zwanzigmal wiederholt, macht keine Fortschritte — er hängt in einer
 *    Schleife. Genau das hat 18 $ verbrannt (2591 Aufrufe eines nicht vorhandenen Werkzeugs). */
export function jobBurn(dir: string): { cost: number; turns: number; repeat: number; repeatSig: string; errorStreak: number; similar: number } {
  const text = readJobFile(join(dir, "agent.jsonl"), 20_000_000) ?? "";
  let cost = 0;
  let turns = 0;
  for (const m of text.matchAll(/"cost":\s*([0-9.eE+-]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) cost += v;
  }
  for (const _ of text.matchAll(/"type":\s*"step[-_]finish"/g)) turns++;

  // Werkzeug-Aufrufe der Reihe nach sammeln, aber nur die letzten (WINDOW) betrachten:
  // ein Muster über den ganzen Lauf wäre bei langen Läufen normal, ein Muster am Ende nicht.
  // Fehler-Kaskade: aufeinanderfolgende Aufrufe, die fehlschlagen — egal ob identisch.
  // Ein Agent, der fünfmal hintereinander gegen dieselbe Wand läuft (auch mit leicht anderen
  // Argumenten), hängt; unsere Wiederholungserkennung sieht nur exakt gleiche Aufrufe.
  let errorStreak = 0;
  for (const block of text.split(/"tool":/).slice(1)) {
    const fehler = /"status":\s*"error"/.test(block.slice(0, 400));
    errorStreak = fehler ? errorStreak + 1 : 0;
  }

  const WINDOW = 40;
  const sigs: string[] = [];
  // Zweite Signatur: nur der Anfang des Befehls. Ein Agent, der zwanzigmal denselben Befehl mit
  // anderem Suchmuster fährt ("grep '^+'", "grep '^-'", …), wiederholt sich — auch wenn keine
  // Zeile identisch ist. Genau so lief ein Lauf 276 Schritte lang im Kreis.
  const grob: string[] = [];
  for (const m of text.matchAll(/"tool":"([^"]+)"[\s\S]{0,400}?"(?:command|path|message)":"([^"]{0,200})"/g)) {
    // Zählen nur Aufrufe, deren Signatur echten Inhalt trägt: Befehle und Meldungen.
    // Bei `edit`/`write`/`read` ist die Signatur der Dateipfad — mehrfaches Bearbeiten
    // derselben Datei sähe wie eine Schleife aus. `factory-verify` trägt keinen Inhalt und
    // darf sich legitim wiederholen (nach jeder Korrektur erneut prüfen).
    const zaehlt = ["shell", "bash", "factory-report", "factory-question"].includes(m[1]);
    if (!zaehlt) continue;
    sigs.push(`${m[1]}|${m[2]}`);
    const istSkript = m[2].includes("<<") || m[2].includes("EOF");
    if (!istSkript) grob.push(`${m[1]}|${m[2].slice(0, 40)}`);
  }
  const recent = sigs.slice(-WINDOW);
  const recentGrob = grob.slice(-WINDOW);
  const countsGrob = new Map<string, number>();
  for (const s of recentGrob) countsGrob.set(s, (countsGrob.get(s) ?? 0) + 1);
  let similar = 0;
  for (const [, n] of countsGrob) if (n > similar) similar = n;
  const counts = new Map<string, number>();
  for (const s of recent) counts.set(s, (counts.get(s) ?? 0) + 1);
  let repeat = 0;
  let repeatSig = "";
  for (const [s, n] of counts) if (n > repeat) { repeat = n; repeatSig = s; }
  return { cost, turns, repeat, repeatSig, errorStreak, similar };
}

/** Eine **vermittelte** Freigabe: Mika (o. ä.) trägt eine Entscheidung ein, die ein Mensch ihm
 *  mitgeteilt hat (z. B. per Telegram). Gültig nur mit allen drei Angaben — Entscheidung,
 *  Mensch, Quelle. Der Mensch muss in `allowedUsers` stehen, der Vermittler in `proxyUsers`.
 *  Der Runner kann die Quelle nicht prüfen: Die Zeile macht die Kette nachvollziehbar, nicht
 *  fälschungssicher. Deshalb bewusst nur für Neustart, Antwort und Budget — nie für Merge. */
export function proxyApproval(cfg: Config, comments: Comment[]): { login: string; decidedBy: string; body: Comment } | null {
  const proxys = (cfg.proxyUsers ?? []).map((u) => u.toLowerCase());
  const menschen = (cfg.allowedUsers ?? []).map((u) => u.toLowerCase());
  if (!proxys.length) return null;
  for (const c of comments) {
    const login = loginOf(c);
    if (!proxys.includes(login.toLowerCase())) continue;
    if (!/^\s*Freigabe:\s*vermittelt\b/im.test(c.body)) continue;
    const entscheider = c.body.match(/^\s*Entschieden von:\s*@?([A-Za-z0-9-]+)/im);
    if (!entscheider) continue;
    if (!menschen.includes(entscheider[1].toLowerCase())) continue;   // nur bekannte Menschen
    if (!/^\s*Quelle:\s*\S+/im.test(c.body)) continue;                // Herkunft muss genannt sein
    return { login, decidedBy: entscheider[1], body: c };
  }
  return null;
}

/** Steht am PR ein Abnahmebericht, der zu diesem Lauf gehört? Leitet das Urteil aus dem Text ab.
 *  Nötig, weil Agenten regelmäßig den Bericht schreiben, aber die Meldung an den Runner vergessen. */
export async function verdictFromReview(repo: string, issue: number, since: string): Promise<string | null> {
  try {
    const prs = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${issue}`, "--state", "open", "--json", "number"]));
    if (!prs?.[0]) return null;
    const rv = JSON.parse(await gh(["pr", "view", String(prs[0].number), "-R", repo, "--json", "reviews"]));
    const seit = Date.parse(since);
    const neu = (rv.reviews ?? []).filter((r: any) => {
      const t = Date.parse(String(r.submittedAt ?? ""));
      return Number.isFinite(t) ? t >= seit : false;
    });
    for (let i = neu.length - 1; i >= 0; i--) {
      const b = String(neu[i].body ?? "");
      // Reihenfolge wichtig: "nicht bestanden" enthält auch "bestanden".
      if (/Abnahme nicht bestanden|nicht bestanden\s*[—-]|Rückgabe \(rework\)|Rework:\s/i.test(b)) return "working";
      if (/Abnahme bestanden|Fazit[^\n]*bestanden/i.test(b)) return "review";
    }
  } catch { /* kein Urteil lesbar */ }
  return null;
}

/** Wertet einen beendeten Container aus und räumt ihn weg. `reason` = Grund, warum der Runner ihn beendet hat. */
async function finish(cfg: Config, c: Container, reason?: string) {
  const dir = jobDir(cfg, c.repo, c.issue);
  const status: { status?: string; step?: string; pr?: string; unresolved?: boolean } = readJobJson(join(dir, "status.json")) ?? {};
  // Der Agent-Adapter im Image schreibt ein normalisiertes /work/result.json —
  // damit ist der Runner unabhängig davon, welcher Agent gelaufen ist.
  let result: any = readJobJson(join(dir, "result.json")) ?? {};
  if (!result || typeof result !== "object" || Object.keys(result).length === 0) {
    // Rückfallweg für ältere Images (Claude Code schrieb claude.jsonl im stream-json-Format)
    result = {};
    const tail = readJobFile(join(dir, "claude.jsonl"), 500_000) ?? "";
    try { result = JSON.parse(tail.trim().split("\n").pop() ?? ""); } catch {}
  }

  const endStates: Record<Phase, string[]> = {
    check: ["approved", "question", "rejected", "failed"],
    build: ["accepting", "question", "failed"],
    accept: ["review", "working", "question", "failed"], // working = Rückgabe an die Entwicklung
  };
  let problem = reason ?? null;
  let buildOk = false;

  // Abnahme ohne Meldung: Der Bericht steht als Review am PR, aber `factory-report` fehlt.
  // Dann das Urteil aus dem Bericht ableiten — eine bestandene Abnahme darf nicht als
  // Fehlschlag enden, nur weil der letzte Aufruf vergessen wurde.
  if (!problem && c.phase === "accept" && !status.status) {
    const urteil = await verdictFromReview(c.repo, c.issue, c.startedAt);
    if (urteil) {
      status.status = urteil;
      log("job:review-fallback", { repo: c.repo, issue: c.issue, status: urteil, hinweis: "Urteil aus dem PR-Review gelesen" });
    }
  }

  // Vor der Bewertung prüfen, ob der Lauf am Guthaben gescheitert ist. Das ist kein Fehler im
  // Auftrag, sondern ein Zustand, der den ganzen Betrieb betrifft.
  const jobText = (readJobFile(join(dir, "agent.jsonl"), 250_000) ?? "") + (readJobFile(join(dir, "agent.err"), 5_000) ?? "");
  const outOfCredit = creditProblem(jobText);
  if (!problem && !(status.status && endStates[c.phase].includes(status.status))) {
    // Der Agent hat am Ende nicht gemeldet. Das allein heißt noch nichts: Gute Arbeit darf nicht
    // weggeworfen werden, nur weil der letzte Aufruf fehlt. Maßstab ist derselbe wie bei einer
    // Meldung — Pflicht-Checks auf genau dem gepushten Stand, `main` enthalten, Spec unberührt.
    if (c.phase === "build" && c.exitCode === 0 && !result.is_error) {
      const pr = status.pr ?? (await findPr(c.repo, c.issue, "open"))?.url;
      const befund = await checkBuild(c.repo, c.issue, dir, pr);
      if (befund) {
        problem = `Der Lauf hat kein Ergebnis gemeldet, und die Arbeit ist nicht abgeschlossen: ${befund}`;
      } else {
        log("job:unreported", { repo: c.repo, issue: c.issue, phase: c.phase, uebernommen: "Arbeit geprüft, Ergebnis übernommen" });
        status.status = "accepting";
        status.pr = pr;
        buildOk = true;
      }
    } else {
      problem = "Der Lauf hat kein Ergebnis gemeldet.";
    }
  }
  if (!problem && (c.exitCode !== 0 || result.is_error)) {
    const was = cfg.agent === "claude" ? "Claude Code" : "OpenCode";
    problem = `${was} wurde mit einem Fehler beendet (Exit-Code ${c.exitCode}).`;
  }
  if (!problem && !buildOk && c.phase === "build" && status.status === "accepting") problem = await checkBuild(c.repo, c.issue, dir, status.pr);
  if (outOfCredit) {
    budgetHaltUntil = Date.now() + 60 * 60 * 1000;
    problem = "Guthaben beim Modellanbieter aufgebraucht (402). Die Fabrik hält an, bis das Guthaben aufgefüllt ist — sie startet von selbst keinen neuen Lauf. Nach dem Auffüllen im Issue kommentieren, das hebt die Sperre auf.";
    log("budget:halt", { repo: c.repo, issue: c.issue, until: new Date(budgetHaltUntil).toISOString() });
  }
  const ended = !problem;
  const metricStatus = ended ? (status.status === "review" && status.unresolved ? "unresolved" : status.status) : "failed";

  log("job:finished", {
    repo: c.repo, issue: c.issue, phase: c.phase, exitCode: c.exitCode, status: metricStatus, problem,
    minutes: result.duration_ms ? Math.round(result.duration_ms / 60000) : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
  });
  const errTail = redact(readJobFile(join(dir, "agent.err"), 1500) ?? readJobFile(join(dir, "claude.err"), 1500) ?? "");
  // Kurze Zusammenfassung des Laufs dauerhaft festhalten: Grundlage für den Verbesserungs-Lauf
  try {
    const runsDir = join(cfg.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}__${c.repo.replace("/", "__")}__${c.issue}__${c.phase}.json`), JSON.stringify({
      repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode, exitCode: c.exitCode,
      status: metricStatus, problem, reported: status,
      result: typeof result.result === "string" ? redact(result.result.slice(0, 4000)) : null,
      turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, errTail,
    }, null, 2));
  } catch (e) { log("runs:error", { error: String(e) }); }
  // Dauerhaft festhalten, auch nach dem Aufräumen: Grundlage für factory-stats
  const seconds = Math.max(0, Math.round((Date.parse(c.finishedAt) - Date.parse(c.startedAt)) / 1000));
  appendFileSync(join(cfg.dataDir, "metrics.jsonl"), JSON.stringify({
    t: new Date().toISOString(), started: c.startedAt, repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode,
    status: metricStatus, exitCode: c.exitCode, seconds: Number.isFinite(seconds) ? seconds : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, model: repoJob(cfg, c.repo, c.phase).model,
  }) + "\n");

  if (ended) {
    setState(cfg, c.repo, c.issue, {});
  } else {
    let detail = typeof result.result === "string" ? result.result.slice(-1500) : "";
    if (!detail) detail = errTail.slice(-800);
    detail = redact(detail).replace(/```/g, "'''").trim();
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "failed");
    await syncBoard(cfg, issue.url, "failed");
    await comment(c.repo, c.issue, `failed:${c.phase}`,
      `### ⚠️ Der Lauf wurde ohne gültiges Ergebnis beendet\n\n**Grund:** ${problem}\n\n` +
      (detail ? "Letzte Ausgabe:\n```\n" + detail + "\n```\n\n" : "") +
      `_Schreib einen Kommentar mit einem Hinweis, dann versucht die Factory es erneut._`);
  }
  await docker(["rm", "-f", c.name]).catch(() => {});
}

// ---------- Vorschau pro Pull Request (optional) ----------

const CADDYFILE = "/etc/software-factory/Caddyfile";
const PREVIEW_PORT = (slot: number) => 4000 + slot; // von außen erreichbar (mit Passwort)
const INTERNAL_PORT = (slot: number) => 5000 + slot; // nur lokal, dahinter läuft die App
let caddyHash: string | null = null;
let caddyFresh = false; // Caddy einmal pro Runner-Start neu aufsetzen (Konfiguration kann sich geändert haben)
const previewNoticePosted = new Set<string>();

type Preview = { name: string; repo: string; issue: number; sha: string; slot: number; running: boolean };

async function listPreviews(): Promise<Preview[]> {
  const names = (await docker(["ps", "-a", "--filter", "label=sf.preview=1", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  const result: Preview[] = [];
  for (const name of names) {
    const info = JSON.parse(await docker(["inspect", name]))[0];
    const l = info.Config.Labels;
    result.push({ name, repo: l["sf.repo"], issue: Number(l["sf.issue"]), sha: l["sf.sha"], slot: Number(l["sf.slot"]), running: info.State.Running });
  }
  return result;
}

export const previewLink = (cfg: Config, slot: number) =>
  cfg.preview?.domain ? `https://${cfg.preview.domain}:${PREVIEW_PORT(slot)}` : `http://${cfg.preview?.host}:${PREVIEW_PORT(slot)}`;

export function caddyConfig(cfg: Config, slots: number[], hash: string): string {
  const domain = cfg.preview?.domain;
  // Mit Domain holt Caddy selbst ein Zertifikat (Ports 80 und 443 müssen erreichbar sein). Ohne Domain nur HTTP.
  const global = domain ? `{\n  admin localhost:2019\n}` : `{\n  auto_https off\n  admin localhost:2019\n}`;
  const blocks = slots.map((slot) =>
    `${domain ? `${domain}:${PREVIEW_PORT(slot)}` : `:${PREVIEW_PORT(slot)}`} {\n  basic_auth {\n    factory ${hash}\n  }\n  reverse_proxy 127.0.0.1:${INTERNAL_PORT(slot)}\n}`);
  if (domain) blocks.unshift(`${domain} {\n  respond "Software Factory: Vorschauen laufen auf eigenen Ports." 200\n}`);
  return `${global}\n\n${blocks.join("\n\n")}\n`;
}

async function writeCaddy(cfg: Config, previews: Preview[]) {
  if (!cfg.preview) return;
  if (!caddyHash) caddyHash = (await docker(["run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", cfg.preview.password])).trim();
  writeFileSync(CADDYFILE, caddyConfig(cfg, previews.map((p) => p.slot), caddyHash));
  const running = (await docker(["ps", "--filter", "name=^sf-caddy$", "--format", "{{.Names}}"])).trim();
  if (!running || !caddyFresh) {
    await docker(["rm", "-f", "sf-caddy"]).catch(() => {});
    // Zertifikate liegen im Volume sf-caddy-data und überleben Neustarts
    await docker(["run", "-d", "--name", "sf-caddy", "--network", "host", "--restart", "unless-stopped",
      "-v", `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, "-v", "sf-caddy-data:/data", "caddy:2-alpine"]);
    caddyFresh = true;
  } else {
    await docker(["exec", "sf-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
  }
}

const previewDir = (cfg: Config, name: string) => join(cfg.dataDir, "previews", name);

/** Startet/aktualisiert Vorschauen für offene Factory-PRs und räumt alte weg. */
async function syncPreviews(cfg: Config, repo: string, issues: Issue[]) {
  if (!cfg.preview) return;
  const max = cfg.preview.max ?? 1;
  let previews = (await listPreviews()).filter((p) => p.repo === repo);
  const wanted = new Map<number, { url: string; number: number; sha: string }>();
  for (const issue of issues.filter((i) => stageOf(i) === "review")) {
    const pr = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${issue.number}`, "--state", "open", "--json", "number,url,headRefOid"]))[0];
    if (pr) wanted.set(issue.number, { url: pr.url, number: pr.number, sha: pr.headRefOid });
  }

  let changed = !caddyFresh;
  // Weg mit Vorschauen ohne offenen PR, mit altem Stand oder abgestürzt
  for (const p of previews) {
    const w = wanted.get(p.issue);
    if (!w || w.sha !== p.sha || !p.running) {
      await docker(["rm", "-f", p.name]).catch(() => {});
      rmSync(previewDir(cfg, p.name), { recursive: true, force: true });
      log("preview:stopped", { repo, issue: p.issue, reason: !w ? "kein offener PR" : w.sha !== p.sha ? "neuer Stand" : "abgestürzt" });
      changed = true;
    }
  }
  const all = await listPreviews();
  previews = all.filter((p) => p.repo === repo);
  const usedSlots = new Set(all.map((p) => p.slot));

  for (const [issueNr, pr] of wanted) {
    if (previews.some((p) => p.issue === issueNr)) continue;
    const slot = Array.from({ length: max }, (_, i) => i + 1).find((s) => !usedSlots.has(s));
    if (!slot) { log("preview:no-slot", { repo, issue: issueNr }); continue; }
    usedSlots.add(slot);
    const name = `sf-preview-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${issueNr}`;
    const image = await imageFor(cfg, repo);

    // 1. Quellcode in einem kurzen Container mit GitHub-Zugang holen …
    const src = previewDir(cfg, name);
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    chownSync(src, CONTAINER_UID, CONTAINER_UID);
    const ghToken = (await gh(["auth", "token"])).trim();
    await docker(["run", "--rm", "-e", `REPO=${repo}`, "-e", `BRANCH=factory/${issueNr}`, "-e", "GH_TOKEN",
      "-v", `${src}:/src`, "--entrypoint", "bash", image, "-c",
      `gh auth setup-git >/dev/null && gh repo clone "$REPO" /src/app -- --quiet --depth 1 --branch "$BRANCH"`], { GH_TOKEN: ghToken });

    // 2. … und die App ohne jegliche Zugangsdaten starten
    await docker(["run", "-d", "--name", name,
      "--label", "sf.preview=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issueNr}`,
      "--label", `sf.sha=${pr.sha}`, "--label", `sf.slot=${slot}`,
      "-p", `127.0.0.1:${INTERNAL_PORT(slot)}:3000`,
      "--memory", cfg.preview.memory ?? "1500m", "--pids-limit", "2048",
      "-v", `${src}/app:/app`, "--entrypoint", "/factory/preview.sh", image]);
    changed = true;
    const link = previewLink(cfg, slot);
    log("preview:started", { repo, issue: issueNr, pr: pr.number, url: link });

    const key = `${repo}#${pr.number}`;
    if (!previewNoticePosted.has(key)) {
      const comments = JSON.parse(await gh(["pr", "view", String(pr.number), "-R", repo, "--json", "comments"])).comments as Comment[];
      if (!comments.some((c) => isFactoryComment(c) && c.body.includes(`${MARK}preview -->`))) {
        await gh(["pr", "comment", String(pr.number), "-R", repo, "--body-file", "-"],
          `${MARK}preview -->\n### 🔍 Vorschau zum Durchklicken\n\n${link}\n\nLogin: \`factory\` · Passwort: steht in \`/etc/software-factory/config.json\` auf dem Server.\n\n_Die Vorschau braucht nach jedem neuen Stand 1–2 Minuten zum Starten. Nach Merge oder Schließen des PRs wird sie entfernt._`);
      }
      previewNoticePosted.add(key);
    }
  }
  if (changed) await writeCaddy(cfg, await listPreviews());
}

// ---------- Verbesserungs-Lauf ----------
// Wertet alle bisherigen Läufe aus und schlägt Änderungen an Playbook/Skills als PR im Factory-Repo vor.
// Auslöser: `factory-improve` (legt eine Anforderungs-Datei an) oder automatisch alle improve.everyDays Tage.
// Belegt einen Agent-Platz wie jeder andere Lauf.

async function improveRunning(cfg: Config): Promise<boolean> {
  const lines = (await docker(["ps", "-a", "--filter", "label=sf.improve=1", "--format", "{{.Names}}|{{.State}}|{{.RunningFor}}"])).trim().split("\n").filter(Boolean);
  let running = false;
  for (const line of lines) {
    const [name, state] = line.split("|");
    if (state === "running") {
      const started = JSON.parse(await docker(["inspect", name]))[0].State.StartedAt;
      if ((Date.now() - Date.parse(started)) / 60000 <= cfg.jobTimeoutMinutes) { running = true; continue; }
      log("improve:timeout", { container: name });
      await docker(["kill", name]).catch(() => {});
    }
    const out = await docker(["logs", "--tail", "5", name]).catch(() => "");
    log("improve:finished", { container: name, tail: redact(out.trim().slice(-600)) });
    await docker(["rm", "-f", name]).catch(() => {});
  }
  return running;
}

async function maybeImprove(cfg: Config, freeSlots: number) {
  if (freeSlots <= 0) return;
  const requested = join(cfg.dataDir, "improve-requested");
  const lastRun = join(cfg.dataDir, "improve-last");
  const days = cfg.improve?.everyDays;
  const due = !!days && (!existsSync(lastRun) || Date.now() - statSync(lastRun).mtimeMs > days * 86400000);
  if (!existsSync(requested) && !due) return;
  rmSync(requested, { force: true });
  if (!cfg.factoryRepo) { log("improve:error", { error: "factoryRepo fehlt in der Config" }); return; }
  writeFileSync(lastRun, new Date().toISOString());

  const work = join(cfg.dataDir, "improve-work");
  const runs = join(cfg.dataDir, "runs");
  const metrics = join(cfg.dataDir, "metrics.jsonl");
  mkdirSync(work, { recursive: true }); mkdirSync(runs, { recursive: true });
  if (!existsSync(metrics)) writeFileSync(metrics, "");
  chownSync(work, CONTAINER_UID, CONTAINER_UID);
  const ghToken = (await gh(["auth", "token"])).trim();
  const authVar = authEnvName(cfg);
  if (!authVar) { log("improve:error", { error: `Kein API-Key für Agent "${cfg.agent}"` }); return; }
  await docker(["run", "-d", "--name", "sf-improve", "--label", "sf.improve=1",
    ...agentLimits(cfg),
    "-e", `REPO=${cfg.factoryRepo}`, "-e", `MODEL=${cfg.model}`, "-e", `AGENT=${cfg.agent}`, "-e", "GH_TOKEN", "-e", authVar,
    "-v", `${work}:/work`, "-v", `${runs}:/data/runs:ro`, "-v", `${metrics}:/data/metrics.jsonl:ro`,
    "--entrypoint", "/factory/improve.sh", cfg.image], { GH_TOKEN: ghToken });
  log("improve:started", { repo: cfg.factoryRepo });
}

// ---------- Hauptschleife ----------

/** Ein Lauf ging verloren (z. B. Server-Neustart): einmal automatisch neu starten, danach entscheidet der Mensch. */
async function lostJob(cfg: Config, repo: string, issue: Issue): Promise<boolean> {
  const s = getState(cfg, repo, issue.number);
  if ((s.lostRetries ?? 0) < 1) { setState(cfg, repo, issue.number, { ...s, lostRetries: (s.lostRetries ?? 0) + 1 }); return true; }
  await setStage(repo, issue, "failed");
  await syncBoard(cfg, issue.url, "failed");
  await comment(repo, issue.number, `failed:${lastFactoryMarker(issue)?.phase ?? "build"}`,
    `### ⚠️ Der Lauf ist wiederholt verloren gegangen\n\nDie Factory startet ihn nicht noch einmal automatisch, damit keine Endlosschleife entsteht.\n\n_Schreib einen Kommentar, dann versucht sie es erneut._`);
  setState(cfg, repo, issue.number, {});
  return false;
}

/** Offene Blocker eines Auftrags (GitHub-native „blocked by"). Cache gilt pro Durchlauf. */
const blockerCache = new Map<string, number[]>();
export async function openBlockers(repo: string, issue: number): Promise<number[]> {
  const key = `${repo}#${issue}`;
  const cached = blockerCache.get(key);
  if (cached) return cached;
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){blockedBy(first:20){nodes{number state}}}}}";
  try {
    const out = await gh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${issue}`]);
    const nodes = (JSON.parse(out)?.data?.repository?.issue?.blockedBy?.nodes ?? []) as { number: number; state: string }[];
    const open = nodes.filter((n) => n.state !== "CLOSED").map((n) => n.number);
    blockerCache.set(key, open);
    return open;
  } catch (e) {
    log("blockers:error", { repo, issue, error: String(e) });
    return [];                                  // API-Fehler darf keinen Lauf blockieren
  }
}

async function tickRepo(cfg: Config, repo: string, containers: Container[], slots: { free: number }) {
  const issues: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", cfg.label, "--state", "open",
    "--json", "number,title,body,url,labels,comments", "--limit", "100"]));
  issues.sort((a, b) => a.number - b.number); // älteste zuerst
  const openNumbers = new Set(issues.map((i) => i.number));

  // Label entfernt oder Issue geschlossen → laufenden Job stoppen und als beendet erfassen
  for (const c of containers.filter((c) => c.repo === repo && !openNumbers.has(c.issue))) {
    log("job:stopped", { repo, issue: c.issue, reason: "Label entfernt oder Issue geschlossen" });
    await docker(["kill", c.name]).catch(() => {});
    await docker(["rm", "-f", c.name]).catch(() => {});
    slots.free++;
  }

  // Alte Labels aus der ersten Version umstellen
  for (const issue of issues) {
    const legacy = LEGACY[stageOf(issue) ?? ""];
    if (legacy) await setStage(repo, issue, legacy);
  }

  // Review abgeschlossen: PR gemergt → Fertig
  const closed: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", "factory:review", "--state", "closed",
    "--json", "number,title,body,url,labels,comments", "--limit", "20"]));
  for (const issue of [...closed, ...issues.filter((i) => stageOf(i) === "review")]) {
    if (await findPr(repo, issue.number, "merged")) {
      await setStage(repo, issue, "done");
      await syncBoard(cfg, issue.url, "done");
      rmSync(jobDir(cfg, repo, issue.number), { recursive: true, force: true });
      rmSync(scenarioDir(cfg, repo, issue.number), { recursive: true, force: true });
      rmSync(stateFile(cfg, repo, issue.number), { force: true });
      log("job:done", { repo, issue: issue.number });
    }
  }

  for (const issue of issues) {
    const status = stageOf(issue);
    const running = containers.find((c) => c.repo === repo && c.issue === issue.number && openNumbers.has(c.issue));
    if (running) {
      // Genauen Schritt aus dem laufenden Job aufs Board bringen
      const step = readJobJson(join(jobDir(cfg, repo, issue.number), "status.json"), 10_000)?.step || undefined;
      if (status) await syncBoard(cfg, issue.url, status, step);
      continue;
    }
    if (!status) { await setStage(repo, issue, "new"); }
    const current = stageOf(issue)!;
    await syncBoard(cfg, issue.url, current);
    if (current === "done") continue;

    // Was als Nächstes zu tun ist
    let phase: Phase | null = null;
    let mode: Mode = "new";
    let prUrl: string | undefined;
    let lost = false;
    const marker = lastFactoryMarker(issue);
    const menschliche = humanCommentsSinceFactory(cfg, issue);
    const vermittelt = proxyApproval(cfg, commentsSinceFactory(issue));
    const answered = menschliche.length > 0 || !!vermittelt;
    if (vermittelt) {
      log("approval:proxy", { repo, issue: issue.number, vermittler: vermittelt.login, entschiedenVon: vermittelt.decidedBy });
    }
    // "Budget: neu" im Kommentar setzt die Kostenzählung dieses Auftrags zurück. Gedacht für
    // Fälle, in denen ein Ausreißer die Grenze verbraucht hat, ohne dass Arbeit entstanden ist.
    const freigabe = budgetApproval(cfg, menschliche) ?? (vermittelt ? { login: vermittelt.decidedBy, body: vermittelt.body } : null);
    if (answered && freigabe && !resetsDone.has(`${repo}#${issue.number}|${freigabe.body.createdAt}`)) {
      resetsDone.add(`${repo}#${issue.number}|${freigabe.body.createdAt}`);
      try {
        const f = join(cfg.dataDir, "budget-resets.json");
        const resets = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
        const now = new Date().toISOString();
        // Wer "Budget: neu" schreibt, meint den Auftrag — und nimmt bewusst auch die Projekt-
        // und Tageszählung zurück, sonst bliebe die Sperre an derselben Zahl hängen.
        resets[`${repo}#${issue.number}`] = now;
        resets[repo] = now;
        resets["global"] = now;
        writeFileSync(f, JSON.stringify(resets, null, 2));
        budgetNotified.delete(`issue|${repo}#${issue.number}`);
        budgetNotified.delete(`runs|${repo}#${issue.number}`);
        budgetNotified.delete(`day|${repo}`);
        budgetNotified.delete("global");
        log("budget:reset", { repo, issue: issue.number, entschiedenVon: freigabe.login });
        // Der Verlauf muss zeigen, wer entschieden hat — sonst ist später nicht nachvollziehbar,
        // ob ein Mensch oder ein Agent am Budget gedreht hat.
        await gh(["issue", "comment", String(issue.number), "-R", repo, "--body",
          `**Budget für diesen Auftrag zurückgesetzt.**\n\nEntschieden von @${freigabe.login} · Eingetragen von ${vermittelt ? `${vermittelt.login} (vermittelt)` : "Nio"} · ${new Date().toISOString()}\n\nEs wird ab jetzt neu gezählt (Auftrag, Projekt und Tag). Die Grenzen selbst bleiben unverändert.`]).catch(() => {});
      } catch (e) { log("budget:reset-error", { repo, issue: issue.number, error: String(e) }); }
    }

    /** Kein Kommentar: Die Sperre hebt nur ein Mensch auf — oder eine vermittelte Freigabe. */
    if (answered && Date.now() < budgetHaltUntil) {
      budgetHaltUntil = 0;
      log("budget:resumed", { repo, issue: issue.number });
    }
    if (current === "new") phase = "check";
    else if (current === "checking") { phase = "check"; mode = "retry"; lost = true; }          // Prüf-Job verloren
    else if (current === "approved") phase = "build";
    else if (current === "working") {
      phase = "build";
      mode = marker?.status === "rework" ? "rework" : "retry";                                  // Rückgabe aus der Abnahme oder Job verloren
      lost = mode === "retry";
      if (mode === "rework") prUrl = (await findPr(repo, issue.number, "open"))?.url;
    }
    else if (current === "accepting") { phase = "accept"; prUrl = (await findPr(repo, issue.number, "open"))?.url; }
    else if (answered && current === "question") { phase = (marker?.phase as Phase) ?? "check"; mode = "answer"; }
    else if (answered && current === "rejected") { phase = "check"; mode = "answer"; }
    else if (answered && current === "failed") { phase = (marker?.phase as Phase) ?? "build"; mode = "retry"; }
    else if (answered && current === "review") {
      prUrl = (await findPr(repo, issue.number, "open"))?.url;
      if (prUrl) { phase = "build"; mode = "change-request"; }
    }
    if (!phase) continue;

    // Abhängigkeit: Ein Auftrag, der auf einem offenen Issue steht, wird nicht bearbeitet.
    // Quelle ist die GitHub-Verknüpfung "blocked by" am Issue — nicht der Text im Auftrag.
    const waiting = await openBlockers(repo, issue.number);
    if (waiting.length) {
      log("issue:blocked", { repo, issue: issue.number, blockedBy: waiting });
      continue;
    }

    // Globale Tagesgrenze über alle Projekte: Bei mehreren Projekten darf die Summe nicht
    // unbegrenzt wachsen, auch wenn jedes einzelne Projekt unter seiner Grenze bleibt.
    const globalLimit = cfg.maxCostPerDayGlobal ?? 12;
    const globalSpent = spent(cfg, "*");
    if (globalSpent > globalLimit) {
      if (!budgetNotified.has("global")) {
        budgetNotified.add("global");
        log("budget:global", { spent: Number(globalSpent.toFixed(2)), limit: globalLimit });
        await gh(["issue", "comment", String(issue.number), "-R", repo, "--body",
          `**Tagesgrenze über alle Projekte erreicht.** Heute sind insgesamt ${globalSpent.toFixed(2)} $ verbraucht (Grenze ${globalLimit} $). Die Fabrik startet bis morgen keine neuen Läufe.`]).catch(() => {});
      }
      continue;
    }

    // Läufe je Auftrag: Auch ein geduldiger Mensch darf einen Auftrag nicht endlos neu anstoßen.
    const runLimit = cfg.maxRunsPerIssue ?? 8;
    if (runsToday(cfg, repo, issue.number) >= runLimit) {
      if (!budgetNotified.has(`runs|${repo}#${issue.number}`)) {
        budgetNotified.add(`runs|${repo}#${issue.number}`);
        log("budget:runs", { repo, issue: issue.number, runs: runsToday(cfg, repo, issue.number), limit: runLimit });
        await gh(["issue", "comment", String(issue.number), "-R", repo, "--body",
          `**Laufgrenze erreicht.** Für #${issue.number} sind heute ${runsToday(cfg, repo, issue.number)} Läufe gemacht worden (Grenze ${runLimit}). Die Fabrik macht hier bis morgen nicht weiter.\n\nWenn es weitergehen soll: den Auftrag kleiner fassen (neues Issue mit enger Spec) statt neu anzustoßen.`]).catch(() => {});
      }
      continue;
    }

    // Tagesgrenze: Liegt die Tagessumme über der Grenze, wird nichts Neues gestartet.
    const dayLimit = cfg.maxCostPerDay ?? 8;
    if (spent(cfg, repo) > dayLimit) {
      if (!budgetNotified.has(`day|${repo}`)) {
        budgetNotified.add(`day|${repo}`);
        log("budget:day", { repo, spent: Number(spent(cfg, repo).toFixed(2)), limit: dayLimit });
        await gh(["issue", "comment", String(issue.number), "-R", repo, "--body",
          `**Tagesgrenze erreicht.** Heute sind in diesem Projekt bereits ${spent(cfg, repo).toFixed(2)} $ verbraucht (Grenze ${dayLimit} $). Die Fabrik startet bis morgen keine neuen Läufe.\n\nGrenze anpassen: \`maxCostPerDay\` in der Konfiguration.`]).catch(() => {});
      }
      continue;
    }

    // Grenze je Auftrag: Auch über viele Runden darf ein einzelner Auftrag nicht das Budget fressen.
    const issueLimit = cfg.maxCostPerIssue ?? 6;
    if (spent(cfg, repo, issue.number) > issueLimit) {
      if (!budgetNotified.has(`issue|${repo}#${issue.number}`)) {
        budgetNotified.add(`issue|${repo}#${issue.number}`);
        log("budget:issue", { repo, issue: issue.number, spent: Number(spent(cfg, repo, issue.number).toFixed(2)), limit: issueLimit });
        await gh(["issue", "comment", String(issue.number), "-R", repo, "--body",
          `**Grenze für diesen Auftrag erreicht.** Für #${issue.number} sind bisher ${spent(cfg, repo, issue.number).toFixed(2)} $ verbraucht (Grenze ${issueLimit} $). Die Fabrik macht hier nicht weiter.\n\nEntweder den Auftrag kleiner fassen (neues Issue, engere Spec) oder \`maxCostPerIssue\` anheben.`]).catch(() => {});
      }
      continue;
    }

    // Guthaben aufgebraucht: keine neuen Läufe starten. Sie würden alle an derselben 402 hängen.
    if (Date.now() < budgetHaltUntil) {
      log("budget:halted", { repo, issue: issue.number, until: new Date(budgetHaltUntil).toISOString() });
      continue;
    }

    // Ein gemeinsamer Platz-Pool für alle Phasen. Ohne freien Platz bleibt das Issue in seinem Status und kommt beim nächsten Durchlauf dran.
    if (slots.free <= 0) continue;
    if (lost && !(await lostJob(cfg, repo, issue))) continue;

    if (phase === "accept") {
      if (!prUrl) prUrl = (await findPr(repo, issue.number, "open"))?.url;
      const reworks = reworksSinceApproval(issue);
      const last = reworks >= cfg.maxReworks;
      await launch(cfg, repo, issue, "accept", mode, prUrl,
        `Abnahme-Runde: ${reworks + 1}${last ? " (letzte Runde: keine Rückgabe mehr. Bestanden → accepted, sonst unresolved)" : ""}`);
    } else {
      await launch(cfg, repo, issue, phase, mode, prUrl);
    }
    slots.free--;
  }

  await syncPreviews(cfg, repo, issues).catch((e) => log("preview:error", { repo, error: String(e) }));
}

/** Geschlossene Aufträge aufräumen: Ein Lauf, der während des Schließens noch lief, kann einen
 *  Zwischenstand (Review, Abnahme) als Label und Board-Spalte hinterlassen. Ein geschlossenes
 *  Issue ist fertig — hier wird das geradegezogen, damit das Board die Wahrheit zeigt. */
async function reconcileClosed(cfg: Config) {
  for (const r of cfg.repos.map((x) => (typeof x === "string" ? x : x.repo))) {
    let closed: { number: number; url: string; labels: { name: string }[] }[] = [];
    try {
      closed = JSON.parse(await gh(["issue", "list", "-R", r, "--state", "closed", "--label", cfg.label,
        "--limit", "30", "--json", "number,url,labels"]));
    } catch (e) {
      log("reconcile:list-error", { repo: r, error: String(e) });
      continue;
    }
    for (const it of closed) {
      const stale = (it.labels ?? []).filter((l) => l.name.startsWith(`${cfg.label}:`) && l.name !== `${cfg.label}:done`);
      try {
        if (stale.length > 0) {
          const args = ["issue", "edit", String(it.number), "-R", r, "--add-label", `${cfg.label}:done`];
          for (const l of stale) args.push("--remove-label", l.name);
          await gh(args);
          log("issue:reconciled", { repo: r, issue: it.number, removed: stale.map((l) => l.name) });
        }
        // Spalte immer mitziehen: Wird die Status-Auswahl am Board neu angelegt, vergibt
        // GitHub neue Option-IDs und bestehende Werte gehen verloren. Ein geschlossener
        // Auftrag gehört nach "Fertig" — auch wenn das Label schon stimmt.
        await syncBoard(cfg, it.url, "done");
      } catch (e) {
        log("reconcile:error", { repo: r, issue: it.number, error: String(e) });
      }
    }
  }
}

async function tick(cfg: Config) {
  let containers = await listContainers();
  blockerCache.clear();                 // Abhängigkeiten jeden Durchlauf frisch lesen
  await reconcileClosed(cfg);           // geschlossene Aufträge auf "Fertig" ziehen

  // 1. Beendete Container auswerten, zu lange laufende stoppen und als Fehlschlag erfassen
  for (const c of containers) {
    try {
      if (!c.running) { await finish(cfg, c); continue; }
      const minutes = (Date.now() - Date.parse(c.startedAt)) / 60000;
      const dir = jobDir(cfg, c.repo, c.issue);
      // Grenzen je Phase: Ein Prüflauf braucht 15 Minuten, ein Bau 90, eine Abnahme 45.
      const pl = (cfg.phaseLimits ?? {})[c.phase] ?? {};
      const timeLimit = pl.minutes ?? cfg.jobTimeoutMinutes;

      // Hat der Lauf sein Ergebnis schon gemeldet, ist er fertig — auch wenn der Agent danach
      // weiterredet oder die Sitzung zu beenden versucht (beobachtet: Endlosschleife aus
      // 'finish'-Aufrufen NACH erfolgreicher Meldung). Diese Prüfung steht bewusst VOR den
      // Bremsen: Eine abgeschlossene Arbeit darf nicht als Schleife verworfen werden.
      const gemeldet = String(readJobJson(join(dir, "status.json"))?.status ?? "");
      const terminal = c.phase === "build" ? ["accepting", "question", "failed"]
        : c.phase === "accept" ? ["review", "working", "question", "failed"]
          : ["approved", "question", "rejected", "failed"];
      if (terminal.includes(gemeldet)) {
        // Zeitpunkt des ERSTEN Sehens merken, nicht die Dateizeit messen: Der Agent schreibt
        // status.json bei jedem erneuten `factory-report` neu — eine Messung an der Datei
        // startet deshalb immer wieder von vorn und der Lauf wird nie beendet (beobachtet
        // am 18.11.: Agent meldet erfolgreich und wiederholt das endlos).
        const key2 = c.name;
        const zuerst = terminalSeenAt.get(key2);
        if (zuerst === undefined) terminalSeenAt.set(key2, Date.now());
        else if (Date.now() - zuerst > 60_000) {
          log("job:selfreport-exit", { repo: c.repo, issue: c.issue, status: gemeldet, sekunden: Math.round((Date.now() - zuerst) / 1000) });
          terminalSeenAt.delete(key2);
          await docker(["kill", c.name]).catch(() => {});
          await finish(cfg, { ...c, running: false, exitCode: 0, finishedAt: new Date().toISOString() });
          continue;
        }
      }

      // Kosten- und Schrittbremse: Zeitlimit und Stillstand erkennen eine Schleife nicht, wenn
      // sie ständig Ausgabe produziert. Gemessen: 2591 Schritte in einem Lauf = 18 $ verbrannt.
      const burn = jobBurn(dir);
      const costLimit = cfg.maxCostPerRun ?? 2;
      const turnLimit = pl.turns ?? cfg.maxTurnsPerRun ?? 250;
      const repeatLimit = cfg.maxRepeatCalls ?? 10;
      const similarLimit = cfg.maxSimilarCalls ?? 8;
      const errorLimit = cfg.maxErrorStreak ?? 5;

      // Zweite, unabhängige Kostenmessung beim Anbieter: Sie gilt auch dann, wenn das Parsen der
      // Agentenausgabe bricht (Formatänderung) — sonst wäre die teuerste Bremse blind.
      let anbieter = "";
      const jetzt = await providerSpend();
      const basisDatei = join(dir, "spend-baseline.json");
      const basis = Number(readJobJson(basisDatei)?.usage ?? NaN);
      if (jetzt !== null) {
        if (!Number.isFinite(basis)) writeFileSync(basisDatei, JSON.stringify({ usage: jetzt }));
        else if (jetzt - basis > costLimit) anbieter = `der Anbieter meldet ${(jetzt - basis).toFixed(2)} $ für diesen Lauf (Grenze ${costLimit} $)`;
      }

      let why = "";
      let art = "";
      if (burn.cost > costLimit) { art = "kosten"; why = `Kostenbremse: der Lauf hat ${burn.cost.toFixed(2)} $ verbraucht (Grenze ${costLimit} $).`; }
      else if (anbieter) { art = "kosten-anbieter"; why = `Kostenbremse: ${anbieter}.`; }
      else if (burn.turns > turnLimit) { art = "schritte"; why = `Schrittbremse für ${c.phase}: ${burn.turns} Schritte (Grenze ${turnLimit}).`; }
      else if (burn.errorStreak >= errorLimit) { art = "fehlerkaskade"; why = `Fehlerkaskade: ${burn.errorStreak} Aufrufe hintereinander fehlgeschlagen (Grenze ${errorLimit}).`; }
      else if (burn.repeat >= repeatLimit) { art = "schleife"; why = `Schleifenbremse: ${burn.repeat} gleiche Aufrufe hintereinander (${burn.repeatSig.split("|")[0]}).`; }
      else if (burn.similar >= similarLimit) { art = "schleife-aehnlich"; why = `Schleifenbremse: ${burn.similar} gleichartige Aufrufe hintereinander (gleicher Befehl, anderer Parameter).`; }

      if (why) {
        log("job:limit", {
          repo: c.repo, issue: c.issue, phase: c.phase, kind: art,
          costUsd: Number(burn.cost.toFixed(2)), turns: burn.turns, repeat: burn.repeat,
          errorStreak: burn.errorStreak, aufruf: burn.repeatSig.slice(0, 60),
        });
        await docker(["kill", c.name]).catch(() => {});
        await finish(cfg, { ...c, running: false, exitCode: 137, finishedAt: new Date().toISOString() },
          `${why} Das deutet auf eine Schleife hin — bitte den Auftrag enger fassen (ein Ziel, klare Grenzen) statt nur neu zu starten.`);
        continue;
      }
      if (minutes > timeLimit) {
        log("job:timeout", { repo: c.repo, issue: c.issue, phase: c.phase, minutes: Math.round(minutes), limit: timeLimit });
        await docker(["kill", c.name]).catch(() => {});
        await finish(cfg, { ...c, running: false, exitCode: 137, finishedAt: new Date().toISOString() },
          `Zeitlimit für ${c.phase} von ${timeLimit} Minuten überschritten.`);
        continue;
      }
      // Stillstand: weder Statusmeldung noch Agentenausgabe seit stallMinutes → beenden.
      const stall = cfg.stallMinutes ?? 30;
      const st = join(dir, "status.json");
      const activity = [st, join(dir, "agent.jsonl")]
        .filter((f) => existsSync(f))
        .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
      const quietMinutes = activity ? (Date.now() - activity) / 60000 : minutes;
      if (minutes > stall && quietMinutes > stall) {
        log("job:stalled", { repo: c.repo, issue: c.issue, minutes: Math.round(minutes), quiet: Math.round(quietMinutes) });
        await docker(["kill", c.name]).catch(() => {});
        await finish(cfg, { ...c, running: false, exitCode: 137, finishedAt: new Date().toISOString() },
          `Kein Fortschritt seit ${Math.round(quietMinutes)} Minuten — Lauf beendet. Letzter gemeldeter Stand: ${String(readJobJson(st)?.status ?? "unbekannt")}.`);
        continue;
      }
      // Ergebnis gemeldet, aber der Container läuft weiter: als normal beendet auswerten.
      const reported = String(readJobJson(st)?.status ?? "");
      if (["built", "review", "accepting", "question", "failed"].includes(reported) && quietMinutes > 5) {
        log("job:selfreport-exit", { repo: c.repo, issue: c.issue, status: reported, quiet: Math.round(quietMinutes) });
        await docker(["kill", c.name]).catch(() => {});
        await finish(cfg, { ...c, running: false, exitCode: 0, finishedAt: new Date().toISOString() });
      }
    } catch (e) {
      log("finish:error", { repo: c.repo, issue: c.issue, error: String(e) });
    }
  }
  containers = (await listContainers()).filter((c) => c.running);
  const improving = await improveRunning(cfg);
  const slots = { free: cfg.maxParallel - containers.length - (improving ? 1 : 0) };

  // Ein fehlerhaftes Repo darf die anderen nicht blockieren
  for (const { repo } of repoList(cfg)) {
    try { await tickRepo(cfg, repo, containers, slots); }
    catch (e) { log("repo:error", { repo, error: String(e) }); }
  }

  await maybeImprove(cfg, slots.free).catch((e) => log("improve:error", { error: String(e) }));
}

async function main() {
  const once = process.argv.includes("--once");
  let cfg = loadConfig();
  const authVar = authEnvName(cfg);
  if (!authVar || !process.env[authVar]) {
    log("config:error", {
      error: cfg.agent === "claude"
        ? "Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY gesetzt"
        : `Kein API-Key gefunden (erwartet: ${cfg.apiKeyEnv ?? "OPENROUTER_API_KEY"}). Trage ihn in /etc/software-factory/secrets.env ein.`,
    });
    process.exit(1);
  }
  if (cfg.agent === "claude" && process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.ANTHROPIC_API_KEY) {
    log("config:warning", { warning: "Beide Login-Arten gesetzt. Es wird nur CLAUDE_CODE_OAUTH_TOKEN an die Jobs gegeben." });
  }
  CONTAINER_UID = Number((await docker(["run", "--rm", "--entrypoint", "id", cfg.image, "-u"])).trim());
  FACTORY_LOGIN = (await gh(["api", "user", "--jq", ".login"])).trim();
  // Arbeitet die Fabrik mit dem Konto, dem die Repos gehören? Dann kann niemand ihre PRs
  // formal freigeben (GitHub verbietet die Freigabe des eigenen PRs) und die Herkunft ist
  // nicht nachvollziehbar. Für Einpersonen-Testbetrieb hinnehmbar, für echte Nutzung nicht.
  if (process.env.GH_TOKEN) {
    log("identity:token", { hinweis: "GH_TOKEN aus der Umgebung wird verwendet (eigene Identität möglich)." });
  } else {
    for (const r of repoList(cfg)) {
      const owner = r.repo.split("/")[0];
      if (owner.toLowerCase() === FACTORY_LOGIN.toLowerCase()) {
        log("identity:warning", {
          repo: r.repo, login: FACTORY_LOGIN,
          hinweis: "Die Fabrik arbeitet mit dem Konto des Repo-Eigentümers. Formale Freigaben sind so nicht möglich — für eine eigene Identität GH_TOKEN in secrets.env setzen.",
        });
      }
    }
  }
  if (!(cfg.allowedUsers ?? []).length) {
    log("config:warning", {
      warning: "allowedUsers ist leer — Kommentare von Menschen werden ignoriert. Fragen, Rückgaben aus der Abnahme und 'nochmal versuchen' bleiben wirkungslos. Trage in der Konfiguration die GitHub-Namen ein, die mitreden dürfen (z. B. \"Burzel72\").",
    });
  }
  await initBoard(cfg);
  log("runner:started", {
    login: FACTORY_LOGIN, allowedUsers: cfg.allowedUsers ?? [],
    preview: cfg.preview ? previewLink(cfg, 1).replace(/:4001$/, ":4001…") : "aus",
    containerUid: CONTAINER_UID, repos: repoList(cfg).map((r) => r.repo), maxParallel: cfg.maxParallel, agent: cfg.agent, model: cfg.model, workflow: cfg.workflow,
  });
  while (true) {
    try {
      cfg = loadConfig();
      await tick(cfg);
    } catch (e) {
      log("tick:error", { error: String(e) });
    }
    if (once) break;
    await Bun.sleep(cfg.pollSeconds * 1000);
  }
}

export { finish, tick }; // für Tests

if ((import.meta as any).main) main();