"""Deterministic handling of time: recall-cue detection, time-range parsing,
and the timestamp tags injected in front of every message the LLM sees.

Nothing here calls a model. "Yesterday" is resolved to exact UTC bounds in
code, in the user's timezone, before the LLM is involved.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .memory import Message, MemoryStore

# Phrases that suggest the user is asking about the conversation itself.
# False positives are cheap (a few extra context lines), misses are not.
RECALL_CUES = re.compile(
    r"\b("
    r"earlier|previous(ly)?|before|last time|ago|yesterday|so far|history|"
    r"remember|recall|remind me|"
    r"(did|have|had) (i|we) (ask|asked|say|said|tell|told|mention|mentioned|discuss|discussed|talk|talked)|"
    r"(i|we) (asked|said|told|mentioned|discussed|talked)|"
    r"my (first|last|previous|earlier|past|recent) (question|message|query|prompt)s?|"
    r"(first|last) thing i|"
    r"when did (i|we)|what was my|what were my|what did (i|we)|"
    r"(today|tonight|this (morning|afternoon|evening|week))('s)? (question|message|conversation|chat|topic)s?|"
    r"summari[sz]e (today|our|my|this|the) |"
    r"(our|this|the) (conversation|chat|discussion)"
    r")\b",
    re.I,
)

_UNITS = {
    "second": 1, "sec": 1, "minute": 60, "min": 60, "hour": 3600, "hr": 3600,
    "day": 86400, "week": 604800,
}
_UNIT_RE = r"(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)"
_NUM_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "couple": 2, "a couple": 2, "a couple of": 2,
    "three": 3, "few": 3, "a few": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "fifteen": 15, "twenty": 20, "thirty": 30,
    "half an": 0.5,
}
_NUM_RE = r"(\d+(?:\.\d+)?|half an|a couple of|a couple|a few|an?|one|two|couple|three|few|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)"
_AGO_RE = re.compile(rf"\b{_NUM_RE}\s+{_UNIT_RE}\s+(ago|back)\b", re.I)
_LAST_N_RE = re.compile(rf"\b(?:last|past|previous)\s+(?:{_NUM_RE}\s+)?{_UNIT_RE}\b", re.I)
_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY_RE = re.compile(r"\b(?:on|last)\s+(" + "|".join(_WEEKDAYS) + r")\b", re.I)

_STOPWORDS = set(
    """a an the and or but if of to in on at for with about from by as is are was were be been am do
    does did have has had i me my we our you your it its this that these those what when where which
    who whom why how can could would should will shall may might ask asked asking say said tell told
    mention mentioned discuss discussed talk talked question questions message messages query queries
    prompt earlier previous previously before ago yesterday today tonight morning afternoon evening
    last first time times remember recall remind summarize summarise summary conversation chat
    discussion history far so now just then there here again please thing things any all some
    minute minutes min mins hour hours hr hrs day days week weeks second seconds past recent
    exactly something anything not no yes us them they he she his her into than also""".split()
)


def get_tz(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except Exception:
        return ZoneInfo("UTC")


def tz_label(dt: datetime) -> str:
    return dt.strftime("%Z") or "UTC"


def age(delta: timedelta) -> str:
    s = max(0, int(delta.total_seconds()))
    if s < 60:
        return f"{s}s ago"
    if s < 3600:
        return f"{s // 60} min ago"
    if s < 86400:
        h, m = divmod(s // 60, 60)
        return f"{h}h {m:02d}m ago"
    d, rem = divmod(s, 86400)
    return f"{d}d {rem // 3600}h ago"


def tag(dt: datetime, tz: ZoneInfo, now: datetime) -> str:
    """[2026-11-11 21:06:02 IST · 5 min ago] - exact time plus precomputed
    age, so the model never has to do clock arithmetic."""
    local = dt.astimezone(tz)
    return f"[{local:%Y-%m-%d %H:%M:%S} {tz_label(local)} · {age(now - dt)}]"


@dataclass
class Recall:
    is_recall: bool = False
    start: datetime | None = None   # UTC, inclusive
    end: datetime | None = None     # UTC, exclusive
    label: str = ""
    keywords: list[str] = field(default_factory=list)


def _num(text: str | None) -> float:
    if not text:
        return 1
    text = text.lower()
    return _NUM_WORDS[text] if text in _NUM_WORDS else float(text)


def _unit_seconds(unit: str) -> int:
    unit = unit.lower().rstrip("s")
    return _UNITS.get(unit, _UNITS.get(unit + "s", 60))


def _day(local_now: datetime, offset_days: int) -> tuple[datetime, datetime]:
    start = (local_now + timedelta(days=offset_days)).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def parse_range(text: str, now: datetime, tz: ZoneInfo) -> tuple[datetime, datetime, str] | None:
    """Resolve a temporal phrase to (start, end, label) in UTC, or None."""
    q = text.lower()
    local = now.astimezone(tz)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)

    def out(start: datetime, end: datetime, label: str):
        return start.astimezone(timezone.utc), min(end, local).astimezone(timezone.utc), label

    m = _AGO_RE.search(q)
    if m:
        n, unit = _num(m.group(1)), _unit_seconds(m.group(2))
        delta = timedelta(seconds=n * unit)
        if unit >= 86400:
            # "2 days ago" means that calendar day; "a week ago" that day +-.
            pad = 0 if unit == 86400 else 3
            start, end = _day(local - delta, -pad)[0], _day(local - delta, pad)[1]
            return out(start, end, m.group(0))
        # "5 minutes ago" is approximate speech: take a window around it.
        slack = max(delta * 0.5, timedelta(seconds=90))
        return out(local - delta - slack, local - delta + slack, f"around {m.group(0)}")

    if "day before yesterday" in q:
        return out(*_day(local, -2), "the day before yesterday")
    if "yesterday" in q:
        return out(*_day(local, -1), "yesterday")
    if "last night" in q:
        return out(midnight - timedelta(hours=6), midnight + timedelta(hours=5), "last night")
    if "this morning" in q:
        return out(midnight, midnight + timedelta(hours=12), "this morning")
    if "this afternoon" in q:
        return out(midnight + timedelta(hours=12), midnight + timedelta(hours=17), "this afternoon")
    if "this evening" in q or "tonight" in q:
        return out(midnight + timedelta(hours=17), midnight + timedelta(hours=24), "this evening")
    if "last week" in q:
        monday = midnight - timedelta(days=local.weekday())
        return out(monday - timedelta(days=7), monday, "last week")
    if "this week" in q:
        return out(midnight - timedelta(days=local.weekday()), local, "this week")

    m = _LAST_N_RE.search(q)
    if m:
        delta = timedelta(seconds=_num(m.group(1)) * _unit_seconds(m.group(2)))
        return out(local - delta, local, f"the {m.group(0)}")

    if re.search(r"\btoday\b", q):
        return out(midnight, local, "today")

    m = _DATE_RE.search(q)
    if m:
        try:
            start = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=tz)
            return out(start, start + timedelta(days=1), m.group(0))
        except ValueError:
            pass

    m = _WEEKDAY_RE.search(q)
    if m:
        back = (local.weekday() - _WEEKDAYS.index(m.group(1).lower())) % 7 or 7
        return out(*_day(local, -back), f"{m.group(1).capitalize()} ({(local - timedelta(days=back)):%Y-%m-%d})")
    return None


def keywords(text: str) -> list[str]:
    seen: list[str] = []
    for tok in re.findall(r"[A-Za-z0-9][\w'-]*", text.lower()):
        tok = tok.strip("'-")
        if len(tok) > 1 and tok not in _STOPWORDS and not tok.isdigit() and tok not in seen:
            seen.append(tok)
    return seen[:8]


def analyze(text: str, now: datetime, tz: ZoneInfo) -> Recall:
    if not RECALL_CUES.search(text):
        return Recall()
    rng = parse_range(text, now, tz)
    r = Recall(is_recall=True, keywords=keywords(text))
    if rng:
        r.start, r.end, r.label = rng
    return r


def _line(m: Message, tz: ZoneInfo, now: datetime, limit: int) -> str:
    body = " ".join(m.content.split())
    if len(body) > limit:
        body = body[:limit] + "…"
    return f"{tag(m.dt, tz, now)} {m.role.upper()}: {body}"


def build_recall_block(
    store: MemoryStore, recall: Recall, session_id: str, now: datetime, tz: ZoneInfo, exclude_id: int
) -> str:
    """Render retrieved memory as a system-prompt section. Empty lookups are
    stated explicitly so the model reports "no record" instead of guessing."""
    if not recall.is_recall:
        return ""
    parts = ["## MEMORY RECALL (retrieved from the persistent store; authoritative)"]
    shown: set[int] = set()

    if recall.start and recall.end:
        rows, total = store.in_range(recall.start, recall.end, limit=40, exclude_id=exclude_id)
        s, e = recall.start.astimezone(tz), recall.end.astimezone(tz)
        head = (
            f"Time range \"{recall.label}\" = {s:%Y-%m-%d %H:%M:%S} to {e:%Y-%m-%d %H:%M:%S} "
            f"{tz_label(s)}: {total} stored message(s)"
        )
        if total > len(rows):
            head += f", showing the first {len(rows)}"
        parts.append(head + ("." if rows else ". Nothing was recorded in this range."))
        parts += [_line(m, tz, now, 400 if m.role == "user" else 240) for m in rows]
        shown.update(m.id for m in rows)

    if recall.keywords:
        hits = [m for m in store.search(recall.keywords, limit=8, exclude_id=exclude_id) if m.id not in shown]
        if hits:
            hits.sort(key=lambda m: m.id)
            parts.append(f"Keyword matches for {', '.join(recall.keywords)} (any session):")
            parts += [_line(m, tz, now, 400 if m.role == "user" else 240) for m in hits]
        elif not shown:
            parts.append(f"Keyword matches for {', '.join(recall.keywords)}: none.")

    log = store.session_log(session_id, limit=40, exclude_id=exclude_id)
    if log:
        parts.append("Current session, every user question in order:")
        parts += [_line(m, tz, now, 400) for m in log]
    else:
        parts.append("Current session: no earlier user questions; this is the first message.")
    return "\n".join(parts)
