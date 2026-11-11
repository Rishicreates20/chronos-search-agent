"""Citation guard: a streaming filter that makes fabricated URLs impossible
to deliver. The prompt asks the model to cite only search results; this
enforces it. A URL reaches the user only if it is in the allowed set (this
turn's search results plus URLs already present in the conversation)."""
from __future__ import annotations

import re

_URL_BODY = r"https?://(?:[^()\s]|\([^()\s]*\))+"
LINK_RE = re.compile(r"\[([^\]\n]*)\]\((" + _URL_BODY + r")\)")
# A '[' that could still grow into a markdown link once more tokens arrive.
LINK_PARTIAL_RE = re.compile(r"\[[^\]\n]*(\](\(\S*)?)?")
BARE_URL_RE = re.compile(r"https?://[^\s<>\]\)\"'`]*")
SPECIAL_RE = re.compile(r"\[|https?://")
# The model sometimes imitates the timestamp tags it sees in history.
LEADING_TAG_RE = re.compile(r"\[\d{4}-\d{2}-\d{2}[^\]\n]*\]\s*")
URL_FIND_RE = re.compile(_URL_BODY)
_MAX_HOLD = 2000
_SCHEMES = ("http://", "https://")


def normalize(url: str) -> str:
    return url.strip().split("#", 1)[0].rstrip(".,;:!?*_").rstrip("/")


def extract_urls(text: str) -> set[str]:
    return {normalize(u) for u in URL_FIND_RE.findall(text or "")}


class CitationGuard:
    def __init__(self, allowed: set[str] | None = None):
        self.allowed: set[str] = {normalize(u) for u in (allowed or set())}
        self.removed: list[str] = []
        self._buf = ""
        self._started = False  # any visible output yet?

    def allow(self, urls) -> None:
        self.allowed.update(normalize(u) for u in urls)

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        return self._drain(final=False)

    def flush(self) -> str:
        return self._drain(final=True)

    def _ok(self, url: str) -> bool:
        if normalize(url) in self.allowed:
            return True
        self.removed.append(url)
        return False

    def _drain(self, final: bool) -> str:
        buf, i, out = self._buf, 0, []
        while i < len(buf):
            m = SPECIAL_RE.search(buf, i)
            if not m:
                keep = 0 if final else _scheme_prefix_tail(buf, i)
                out.append(buf[i : len(buf) - keep])
                i = len(buf) - keep
                break
            out.append(buf[i : m.start()])
            i = m.start()
            if buf[i] == "[":
                if not self._started and not "".join(out).strip():
                    tag = LEADING_TAG_RE.match(buf, i)
                    if tag:
                        i = tag.end()
                        continue
                link = LINK_RE.match(buf, i)
                if link:
                    label, url = link.group(1), link.group(2)
                    # Unverified link: keep the words, drop the URL.
                    out.append(link.group(0) if self._ok(url) else label)
                    i = link.end()
                    continue
                if not final and len(buf) - i < _MAX_HOLD and LINK_PARTIAL_RE.fullmatch(buf, i):
                    break  # wait for the rest of the link
                out.append("[")
                i += 1
            else:
                um = BARE_URL_RE.match(buf, i)
                if not final and um.end() == len(buf):
                    break  # URL may still be growing
                raw = um.group(0)
                url = raw.rstrip(".,;:!?*_")
                out.append((url if self._ok(url) else "") + raw[len(url):])
                i = um.end()
        self._buf = buf[i:]
        text = "".join(out)
        if text.strip():
            self._started = True
        return text


def _scheme_prefix_tail(buf: str, start: int) -> int:
    """Length of a trailing fragment that might be the start of 'https://'."""
    for k in range(min(8, len(buf) - start), 0, -1):
        tail = buf[-k:]
        if any(s.startswith(tail) for s in _SCHEMES):
            return k
    return 0
