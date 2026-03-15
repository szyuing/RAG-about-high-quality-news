const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal } = require("../src/source-connectors");

test("parseBingSearchMarkdown should extract title and decoded url", () => {
  const markdown = `
Title: Demo

URL Source: http://www.bing.com/search?q=Sora+OpenAI

Markdown Content:
1.   [Sora: Creating video from text | OpenAI](https://www.bing.com/ck/a?!&&p=test&u=a1aHR0cHM6Ly9vcGVuYWkuY29tL2luZGV4L3NvcmEv&ntb=1)
--------------------------------------------------------------------------------

Feb 15, 2024· Sora is able to generate complex scenes with multiple characters.
`;

  const results = __internal.parseBingSearchMarkdown(markdown, "Sora OpenAI");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Sora: Creating video from text | OpenAI");
  assert.equal(results[0].url, "https://openai.com/index/sora/");
});

test("parseTedSearchHtml should extract TED talk candidates", () => {
  const html = `
  <article class='m1 search__result'>
    <h3 class='h7 m4'>
      <a class="ga-link" data-ga-context="search" href="/talks/victor_riparbelli_will_ai_make_us_the_last_generation_to_read_and_write">Victor Riparbelli: Will AI make us the last generation to read and write?</a>
    </h3>
    <div class='search__result__description m4'>
      Technology is changing our world and how we communicate.
    </div>
  </article>
  `;

  const results = __internal.parseTedSearchHtml(html, "artificial intelligence");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "TED");
  assert.match(results[0].url, /ted\.com\/talks/);
});
