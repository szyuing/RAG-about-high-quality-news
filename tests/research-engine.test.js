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

test("parseSegmentFaultSearchHtml should extract Chinese article candidates", () => {
  const html = `
  <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialState: {
          search: {
            result: {
              rows: [
                {
                  type: "article",
                  contents: {
                    title: "Sora 何时开放使用",
                    excerpt: "根据提供的信息，Sora 目前还未对广大用户开放。",
                    created: 1708247935,
                    votes: 3,
                    comments: 2,
                    url: "/a/1190000044637173"
                  }
                }
              ]
            }
          }
        }
      }
    }
  })}</script>
  `;

  const results = __internal.parseSegmentFaultSearchHtml(html, "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "SegmentFault");
  assert.match(results[0].url, /segmentfault\.com\/a\//);
});

test("parseBilibiliSearchHtml should extract video candidates", () => {
  const html = `
  <div class="bili-video-card">
    <a href="//www.bilibili.com/video/BV1Y2cXzREsm/" class="" target="_blank">
      <span class="bili-video-card__stats__duration">04:04</span>
    </a>
    <div class="bili-video-card__info">
      <a href="//www.bilibili.com/video/BV1Y2cXzREsm/" target="_blank">
        <h3 class="bili-video-card__info--tit" title="3月Sora2无限版 免费教程已更新！">3月Sora2无限版 免费教程已更新！</h3>
      </a>
      <div class="bili-video-card__info--bottom">
        <a class="bili-video-card__info--owner" href="//space.bilibili.com/12210083" target="_blank">
          <span class="bili-video-card__info--author">kubula</span>
        </a>
      </div>
    </div>
  </div>
  `;

  const results = __internal.parseBilibiliSearchHtml(html, "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "Bilibili");
  assert.equal(results[0].duration, "04:04");
  assert.match(results[0].url, /bilibili\.com\/video\/BV1Y2cXzREsm/);
});

test("parseITHomeTagHtml should extract Chinese news candidates", () => {
  const html = `
  <ul class="bl">
    <li>
      <div class="c" data-ot="2026-03-11T13:19:23.1230000+08:00">
        <h2 class="">
          <a title="消息称 OpenAI 视频生成工具 Sora 将登陆 ChatGPT" target="_blank" href="https://www.ithome.com/0/927/929.htm" class="title">消息称 OpenAI 视频生成工具 Sora 将登陆 ChatGPT</a>
        </h2>
        <div class="m">此举是 OpenAI 扩大用户规模整体战略的一部分。</div>
      </div>
    </li>
  </ul>
  `;

  const results = __internal.parseITHomeTagHtml(html, "Sora 最新动态", "Sora");
  assert.equal(results.length, 1);
  assert.equal(results[0].platform, "IT之家");
  assert.match(results[0].url, /ithome\.com\/0\/927\/929\.htm/);
});

test("buildDouyinSearchUrl should generate search landing url", () => {
  const url = __internal.buildDouyinSearchUrl("美国总统特朗普 演讲视频");
  assert.equal(
    url,
    "https://www.douyin.com/search/%E7%BE%8E%E5%9B%BD%E6%80%BB%E7%BB%9F%E7%89%B9%E6%9C%97%E6%99%AE%20%E6%BC%94%E8%AE%B2%E8%A7%86%E9%A2%91"
  );
});
