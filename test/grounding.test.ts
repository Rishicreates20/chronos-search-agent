import assert from "node:assert/strict";
import { test } from "node:test";
import { CitationGuard } from "../src/grounding.ts";

const ALLOWED = ["https://reuters.com/a", "https://en.wikipedia.org/wiki/Mercury_(planet)"];

function run(text: string, size?: number) {
  const g = new CitationGuard(ALLOWED);
  let out = "";
  if (!size) out = g.feed(text);
  else for (let i = 0; i < text.length; i += size) out += g.feed(text.slice(i, i + size));
  return { out: out + g.flush(), g };
}

test("allowed link passes and a fabricated link is stripped", () => {
  const { out, g } = run("Rates rose [Reuters](https://reuters.com/a). Also [Fake](https://made-up.example/x).");
  assert.equal(out, "Rates rose [Reuters](https://reuters.com/a). Also Fake.");
  assert.deepEqual(g.removed, ["https://made-up.example/x"]);
});

test("bare URLs are checked too", () => {
  const { out, g } = run("See https://reuters.com/a. Not https://nope.example/y, ok?");
  assert.equal(out, "See https://reuters.com/a. Not , ok?");
  assert.deepEqual(g.removed, ["https://nope.example/y"]);
});

test("parenthesised URLs and trailing slashes still match", () => {
  const text = "[Wiki](https://en.wikipedia.org/wiki/Mercury_(planet)) and [R](https://reuters.com/a/)";
  assert.equal(run(text).out, text);
});

test("plain brackets survive", () => {
  const text = "Use a[0] and [note] here, then [x] (not a link).";
  assert.equal(run(text).out, text);
  assert.equal(run(text, 1).out, text);
});

test("an imitated leading timestamp tag is dropped", () => {
  assert.equal(run("[2026-11-11 Wed 21:01:10 GMT+5:30 · 5 min ago] Hello there", 3).out, "Hello there");
});

test("the result does not depend on how the stream is chunked", () => {
  const text =
    "Intro [Reuters](https://reuters.com/a) mid https://bad.example/z end " +
    "[Bad](https://bad.example/q) [Wiki](https://en.wikipedia.org/wiki/Mercury_(planet)) h ht http done";
  const expected = run(text).out;
  assert.ok(!expected.includes("bad.example"));
  for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 50]) assert.equal(run(text, size).out, expected, `size ${size}`);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9) + 1;
  for (let k = 0; k < 50; k++) {
    const g = new CitationGuard(ALLOWED);
    let out = "";
    for (let i = 0; i < text.length; ) {
      const n = rand();
      out += g.feed(text.slice(i, i + n));
      i += n;
    }
    assert.equal(out + g.flush(), expected);
  }
});
