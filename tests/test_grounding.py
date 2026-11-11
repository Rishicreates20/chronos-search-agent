import random

from app.grounding import CitationGuard

ALLOWED = {"https://reuters.com/a", "https://en.wikipedia.org/wiki/Mercury_(planet)"}


def run(text: str, size: int | None = None, allowed=ALLOWED) -> tuple[str, CitationGuard]:
    g = CitationGuard(set(allowed))
    if size is None:
        return g.feed(text) + g.flush(), g
    out = "".join(g.feed(text[i : i + size]) for i in range(0, len(text), size))
    return out + g.flush(), g


def test_allowed_link_passes_and_fabricated_link_is_stripped():
    text = "Rates rose [Reuters](https://reuters.com/a). Also [Fake](https://made-up.example/x)."
    out, g = run(text)
    assert out == "Rates rose [Reuters](https://reuters.com/a). Also Fake."
    assert g.removed == ["https://made-up.example/x"]


def test_bare_urls():
    out, g = run("See https://reuters.com/a. Not https://nope.example/y, ok?")
    assert out == "See https://reuters.com/a. Not , ok?"
    assert g.removed == ["https://nope.example/y"]


def test_parenthesised_url_and_trailing_slash():
    out, _ = run("[Wiki](https://en.wikipedia.org/wiki/Mercury_(planet)) and [R](https://reuters.com/a/)")
    assert out == "[Wiki](https://en.wikipedia.org/wiki/Mercury_(planet)) and [R](https://reuters.com/a/)"


def test_plain_brackets_survive():
    text = "Use a[0] and [note] here, then [x] (not a link)."
    assert run(text)[0] == text
    assert run(text, 1)[0] == text


def test_leading_timestamp_tag_is_dropped():
    out, _ = run("[2026-11-11 21:01:10 IST · 5 min ago] Hello there", 3)
    assert out == "Hello there"


def test_result_is_independent_of_chunking():
    text = (
        "Intro [Reuters](https://reuters.com/a) mid https://bad.example/z end "
        "[Bad](https://bad.example/q) [Wiki](https://en.wikipedia.org/wiki/Mercury_(planet)) h ht http done"
    )
    expected, _ = run(text)
    assert "bad.example" not in expected
    rng = random.Random(7)
    for size in list(range(1, 12)) + [50]:
        assert run(text, size)[0] == expected
    for _ in range(50):
        g, out, i = CitationGuard(set(ALLOWED)), "", 0
        while i < len(text):
            n = rng.randint(1, 9)
            out += g.feed(text[i : i + n])
            i += n
        assert out + g.flush() == expected
