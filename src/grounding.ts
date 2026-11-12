// Citation guard: a streaming filter that makes fabricated URLs impossible
// to deliver. The prompt asks the model to cite only search results; this
// enforces it. A URL reaches the user only if it is in the allowed set (this
// turn's search results plus URLs already present in the conversation).

const URL_BODY = "https?://(?:[^()\\s]|\\([^()\\s]*\\))+";
const LINK_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\((${URL_BODY})\\)`, "y");
// A '[' that could still grow into a markdown link once more tokens arrive.
const LINK_PARTIAL_RE = /^\[[^\]\n]*(\](\(\S*)?)?$/;
const BARE_URL_RE = /https?:\/\/[^\s<>\])"'`]*/y;
const SPECIAL_RE = /\[|https?:\/\//g;
// The model sometimes imitates the timestamp tags it sees in history.
const LEADING_TAG_RE = /\[\d{4}-\d{2}-\d{2}[^\]\n]*\]\s*/y;
const URL_FIND_RE = new RegExp(URL_BODY, "g");
const MAX_HOLD = 2000;
const SCHEMES = ["http://", "https://"];

export function normalize(url: string): string {
  return url.trim().split("#", 1)[0]!.replace(/[.,;:!?*_]+$/, "").replace(/\/+$/, "");
}

export function extractUrls(text: string): Set<string> {
  return new Set((text ?? "").match(URL_FIND_RE)?.map(normalize));
}

export class CitationGuard {
  readonly allowed = new Set<string>();
  readonly removed: string[] = [];
  private buf = "";
  private started = false; // any visible output yet?

  constructor(allowed: Iterable<string> = []) {
    this.allow(allowed);
  }

  allow(urls: Iterable<string>): void {
    for (const u of urls) this.allowed.add(normalize(u));
  }

  feed(chunk: string): string {
    this.buf += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private ok(url: string): boolean {
    if (this.allowed.has(normalize(url))) return true;
    this.removed.push(url);
    return false;
  }

  private drain(final: boolean): string {
    const buf = this.buf;
    let i = 0;
    let out = "";
    while (i < buf.length) {
      SPECIAL_RE.lastIndex = i;
      const m = SPECIAL_RE.exec(buf);
      if (!m) {
        const keep = final ? 0 : schemePrefixTail(buf, i);
        out += buf.slice(i, buf.length - keep);
        i = buf.length - keep;
        break;
      }
      out += buf.slice(i, m.index);
      i = m.index;
      if (buf[i] === "[") {
        if (!this.started && !out.trim()) {
          LEADING_TAG_RE.lastIndex = i;
          const tag = LEADING_TAG_RE.exec(buf);
          if (tag) {
            i += tag[0].length;
            continue;
          }
        }
        LINK_RE.lastIndex = i;
        const link = LINK_RE.exec(buf);
        if (link) {
          // Unverified link: keep the words, drop the URL.
          out += this.ok(link[2]!) ? link[0] : link[1];
          i += link[0].length;
          continue;
        }
        if (!final && buf.length - i < MAX_HOLD && LINK_PARTIAL_RE.test(buf.slice(i))) break; // wait for the rest
        out += "[";
        i += 1;
      } else {
        BARE_URL_RE.lastIndex = i;
        const raw = BARE_URL_RE.exec(buf)![0];
        if (!final && i + raw.length === buf.length) break; // URL may still be growing
        const url = raw.replace(/[.,;:!?*_]+$/, "");
        out += (this.ok(url) ? url : "") + raw.slice(url.length);
        i += raw.length;
      }
    }
    this.buf = buf.slice(i);
    if (out.trim()) this.started = true;
    return out;
  }
}

/** Length of a trailing fragment that might be the start of "https://". */
function schemePrefixTail(buf: string, start: number): number {
  for (let k = Math.min(8, buf.length - start); k > 0; k--) {
    const tail = buf.slice(-k);
    if (SCHEMES.some((s) => s.startsWith(tail))) return k;
  }
  return 0;
}
