// Deterministic handling of time: recall-cue detection, time-range parsing,
// and the timestamp tags put in front of every message the model sees.
//
// Nothing here calls a model. "Last Tuesday" is resolved to exact UTC bounds
// in code, in the user's timezone, before the LLM is involved.
import type { Message, TurnContext } from "./memory/types.ts";

const DAY = 86_400_000;

// ---- timezone arithmetic without a date library ---------------------------
// A "wall" Date holds the user's local clock reading in its UTC fields.

export function validTz(tz: string | undefined | null): string {
  try {
    if (tz) return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {}
  return "UTC";
}

function offsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

const toWall = (d: Date, tz: string) => new Date(d.getTime() + offsetMs(d, tz));

function fromWall(wallMs: number, tz: string): Date {
  const guess = new Date(wallMs - offsetMs(new Date(wallMs), tz));
  return new Date(wallMs - offsetMs(guess, tz)); // second pass settles DST edges
}

export function tzLabel(d: Date, tz: string): string {
  if (tz === "UTC") return "UTC";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const fmtWall = (w: Date) =>
  `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())} ${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}`;
const fmtDay = (w: Date) => fmtWall(w).slice(0, 10);

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function formatLocal(d: Date, tz: string): string {
  return `${fmtWall(toWall(d, tz))} ${tzLabel(d, tz)}`;
}

export function weekdayName(d: Date, tz: string): string {
  const n = WEEKDAYS[toWall(d, tz).getUTCDay()]!;
  return n[0]!.toUpperCase() + n.slice(1);
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m ago`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ago`;
}

/** [2026-11-11 Wed 21:06:02 GMT+5:30 · 5 min ago]: exact time plus a
 * precomputed age, so the model never has to do clock arithmetic. */
export function tag(d: Date, tz: string, now: Date): string {
  const w = toWall(d, tz);
  const dow = WEEKDAYS[w.getUTCDay()]!.slice(0, 3);
  return `[${fmtDay(w)} ${dow[0]!.toUpperCase() + dow.slice(1)} ${fmtWall(w).slice(11)} ${tzLabel(d, tz)} · ${age(now.getTime() - d.getTime())}]`;
}

// ---- range parsing --------------------------------------------------------

export interface TimeRange {
  start: Date; // inclusive
  end: Date; // exclusive
  label: string;
}

const UNIT_MS: Record<string, number> = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: DAY, week: 7 * DAY, month: 30 * DAY };
const UNIT = "(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)";
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, "a couple": 2, "a couple of": 2, three: 3, few: 3, "a few": 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, "half an": 0.5,
};
const NUM = "(\\d+(?:\\.\\d+)?|half an|a couple of|a couple|a few|an?|one|two|couple|three|few|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)";
const AGO_RE = new RegExp(`\\b${NUM}\\s+${UNIT}\\s+(?:ago|back)\\b`);
const LAST_N_RE = new RegExp(`\\b(?:last|past|previous)\\s+(?:${NUM}\\s+)?${UNIT}\\b`);
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4}))?`);
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`);
const ON_THE_RE = /\bon the (\d{1,2})(?:st|nd|rd|th)\b/;
const WEEKDAY_RE = new RegExp(`\\b(on|last|this past|this|since|from)\\s+(${WEEKDAYS.join("|")})\\b`);

const num = (t?: string) => (t === undefined ? 1 : NUM_WORDS[t] ?? Number(t));
const unitMs = (u: string) => UNIT_MS[u.replace(/s$/, "")] ?? UNIT_MS[u] ?? 60_000;

/** Resolve a temporal phrase to exact bounds in UTC, or null. */
export function parseRange(text: string, now: Date, tz: string): TimeRange | null {
  const q = text.toLowerCase();
  const wallNow = toWall(now, tz).getTime();
  const w = new Date(wallNow);
  const midnight = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  const out = (startWall: number, endWall: number, label: string): TimeRange => {
    const end = fromWall(endWall, tz);
    return { start: fromWall(startWall, tz), end: end > now ? now : end, label };
  };
  const day = (wallMidnight: number, label: string) => out(wallMidnight, wallMidnight + DAY, label);
  let m: RegExpMatchArray | null;

  if ((m = q.match(AGO_RE))) {
    const unit = unitMs(m[2]!);
    const delta = num(m[1]) * unit;
    if (unit >= DAY) {
      // "2 days ago" means that calendar day; "a week ago", that day give or take.
      const centre = new Date(wallNow - delta);
      const mid = Date.UTC(centre.getUTCFullYear(), centre.getUTCMonth(), centre.getUTCDate());
      const padDays = unit === DAY ? 0 : unit === 7 * DAY ? 2 : 5;
      return out(mid - padDays * DAY, mid + (padDays + 1) * DAY, m[0]);
    }
    // "5 minutes ago" is approximate speech: take a window around it.
    const slack = Math.max(delta * 0.5, 90_000);
    return out(wallNow - delta - slack, wallNow - delta + slack, `around ${m[0]}`);
  }

  // Explicit dates win over loose words: in "…on 3 November? Is it still
  // correct today?" the date is the subject and "today" just means now.
  if ((m = q.match(ISO_DATE_RE))) {
    const mid = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
    if (!Number.isNaN(mid)) return day(mid, m[0]);
  }

  // "3 November", "November 3rd", "3rd of Nov 2026". With no year, the most
  // recent such date that is not in the future.
  const dm = q.match(DAY_MONTH_RE);
  const md = dm ? null : q.match(MONTH_DAY_RE);
  if (dm || md) {
    const dayNo = Number(dm ? dm[1] : md![2]);
    const monthNo = MONTHS.findIndex((name) => name.startsWith((dm ? dm[2]! : md![1]!).slice(0, 3)));
    const yearText = dm ? dm[3] : md![3];
    if (dayNo >= 1 && dayNo <= 31 && monthNo >= 0) {
      let year = yearText ? Number(yearText) : w.getUTCFullYear();
      if (!yearText && Date.UTC(year, monthNo, dayNo) > midnight) year -= 1;
      const mid = Date.UTC(year, monthNo, dayNo);
      return day(mid, `${dayNo} ${MONTHS[monthNo]![0]!.toUpperCase() + MONTHS[monthNo]!.slice(1)} ${year}`);
    }
  }

  if ((m = q.match(ON_THE_RE))) {
    const dayNo = Number(m[1]);
    let mid = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), dayNo);
    if (mid > midnight) mid = Date.UTC(w.getUTCFullYear(), w.getUTCMonth() - 1, dayNo);
    return day(mid, `the ${m[1]} (${fmtDay(new Date(mid))})`);
  }

  // "on Monday", "last Tuesday": the most recent such day before today.
  if ((m = q.match(WEEKDAY_RE))) {
    const back = (w.getUTCDay() - WEEKDAYS.indexOf(m[2]!) + 7) % 7 || 7;
    const mid = midnight - back * DAY;
    const name = m[2]![0]!.toUpperCase() + m[2]!.slice(1);
    if (m[1] === "since" || m[1] === "from") return out(mid, wallNow, `since ${name} (${fmtDay(new Date(mid))})`);
    return day(mid, `${m[1]} ${name} (${fmtDay(new Date(mid))})`);
  }

  if (q.includes("day before yesterday")) return day(midnight - 2 * DAY, "the day before yesterday");
  if (q.includes("yesterday")) return day(midnight - DAY, "yesterday");
  if (q.includes("last night")) return out(midnight - 6 * 3_600_000, midnight + 5 * 3_600_000, "last night");
  if (q.includes("this morning")) return out(midnight, midnight + 12 * 3_600_000, "this morning");
  if (q.includes("this afternoon")) return out(midnight + 12 * 3_600_000, midnight + 17 * 3_600_000, "this afternoon");
  if (q.includes("this evening") || q.includes("tonight")) return out(midnight + 17 * 3_600_000, midnight + DAY, "this evening");
  const monday = midnight - ((w.getUTCDay() + 6) % 7) * DAY;
  if (q.includes("last week")) return out(monday - 7 * DAY, monday, "last week");
  if (q.includes("this week")) return out(monday, wallNow, "this week");
  if (q.includes("last month")) {
    return out(Date.UTC(w.getUTCFullYear(), w.getUTCMonth() - 1, 1), Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1), "last month");
  }
  if (q.includes("this month")) return out(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), 1), wallNow, "this month");

  if ((m = q.match(LAST_N_RE))) return out(wallNow - num(m[1]) * unitMs(m[2]!), wallNow, `the ${m[0]}`);
  if (/\btoday\b/.test(q)) return out(midnight, wallNow, "today");

  return null;
}

// ---- recall detection -----------------------------------------------------

// Phrases that mean the user is asking about the conversation itself.
// False positives are cheap (a few extra context lines); misses are not.
const RECALL_CUES = new RegExp(
  "\\b(" +
    "earlier|previous(ly)?|before|last time|ago|so far|history|since then|" +
    "remember|recall|remind me|" +
    "(did|have|had) (i|we|you) (ask|asked|say|said|tell|told|mention|mentioned|discuss|discussed|talk|talked|recommend|recommended|suggest|suggested)|" +
    "(i|we) (asked|said|told|mentioned|discussed|talked|shortlisted|compared|picked|chose|decided|looked at|went over|covered)|" +
    "you (said|told|mentioned|recommended|suggested|answered|listed|gave)|" +
    "your (answer|response|reply|recommendation|suggestion|list)|" +
    "still (correct|true|valid|accurate|right|the case|up to date)|" +
    "my (first|last|previous|earlier|past|recent) (question|message|query|prompt)s?|" +
    "(first|last) thing i|when did (i|we)|what was my|what were my|what did (i|we|you)|" +
    "summari[sz]e (today|our|my|this|the) |(our|this|the) (conversation|chat|discussion)" +
    ")\\b",
  "i",
);
const FIRST_PERSON = /\b(i|we|you|my|our|me|us|your)\b/i;

const STOPWORDS = new Set(
  `a an the and or but if of to in on at for with about from by as is are was were be been am do does did have has had
  i me my we our you your it its this that these those what when where which who whom why how can could would should
  will shall may might ask asked asking say said tell told mention mentioned discuss discussed talk talked question
  questions message messages query queries prompt earlier previous previously before ago yesterday today tonight
  morning afternoon evening last first time times remember recall remind summarize summarise summary conversation
  chat discussion history far so now just then there here again please thing things any all some minute minutes min
  mins hour hours hr hrs day days week weeks month months second seconds past recent exactly something anything not
  no yes us them they he she his her into than also since still correct answer answers changed change shipped big
  them any of either both new latest current currently right true valid accurate case
  ${WEEKDAYS.join(" ")} ${MONTHS.join(" ")} jan feb mar apr jun jul aug sep sept oct nov dec`.split(/\s+/),
);

export function keywords(text: string): string[] {
  const seen: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const tok = raw.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, "");
    if (tok.length > 1 && !STOPWORDS.has(tok) && !/^\d+(st|nd|rd|th)?$/.test(tok) && !seen.includes(tok)) seen.push(tok);
  }
  return seen.slice(0, 8);
}

export interface Recall {
  isRecall: boolean;
  range: TimeRange | null;
  keywords: string[];
}

export function analyze(text: string, now: Date, tz: string): Recall {
  const range = parseRange(text, now, tz);
  // A past date plus a first-person reference ("On Monday we shortlisted…")
  // is a reference to the conversation even without an explicit cue word.
  const isRecall = RECALL_CUES.test(text) || (range !== null && FIRST_PERSON.test(text));
  return isRecall ? { isRecall, range, keywords: keywords(text) } : { isRecall: false, range: null, keywords: [] };
}

// ---- rendering ------------------------------------------------------------

function line(m: Message, tz: string, now: Date): string {
  const limit = m.role === "user" ? 500 : 1200;
  let body = m.content.replace(/\s+/g, " ").trim();
  if (body.length > limit) body = body.slice(0, limit) + "…";
  return `${tag(new Date(m.createdAt), tz, now)} ${m.role.toUpperCase()}: ${body}`;
}

const BLOCK_BUDGET = 14_000;

/** Render retrieved memory as a system-prompt section. Empty lookups are
 * stated explicitly so the model reports "no record" instead of guessing. */
export function buildRecallBlock(recall: Recall, ctx: TurnContext, now: Date, tz: string): string {
  if (!recall.isRecall) return "";
  const parts = ["## MEMORY RECALL (retrieved from the persistent store; authoritative)"];
  const shown = new Set<number>();

  if (recall.range) {
    const { start, end, label } = recall.range;
    let head = `Time range "${label}" = ${formatLocal(start, tz)} to ${formatLocal(end, tz)}: ${ctx.rangeTotal} stored message(s)`;
    if (ctx.rangeTotal > ctx.rangeRows.length) head += `, showing the first ${ctx.rangeRows.length}`;
    parts.push(head + (ctx.rangeRows.length ? "." : ". Nothing was recorded in this range."));
    for (const m of ctx.rangeRows) {
      parts.push(line(m, tz, now));
      shown.add(m.id);
    }
  }

  if (recall.keywords.length) {
    const hits = ctx.hits.filter((m) => !shown.has(m.id));
    if (hits.length) {
      parts.push(`Keyword matches for ${recall.keywords.join(", ")} (any session, with the other half of each exchange):`);
      for (const m of hits) parts.push(line(m, tz, now));
    } else if (!shown.size) {
      parts.push(`Keyword matches for ${recall.keywords.join(", ")}: none.`);
    }
  }

  if (ctx.log.length) {
    parts.push("Current session, every user question in order:");
    for (const m of ctx.log) parts.push(line(m, tz, now));
  } else {
    parts.push("Current session: no earlier user questions; this is the first message.");
  }

  let block = parts.join("\n");
  if (block.length > BLOCK_BUDGET) block = block.slice(0, BLOCK_BUDGET) + "\n…(recall truncated)";
  return block;
}
