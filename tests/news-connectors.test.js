const test = require("node:test");
const assert = require("node:assert/strict");

const { invokeSourceTool, readCandidate, __internal: sourceInternal } = require("../src/source-connectors");
const { __internal: siteInternal } = require("../src/site-hints");

const NEWS_CONNECTOR_IDS = [
  "xinhua",
  "people",
  "cctv_news",
  "the_paper",
  "caixin",
  "jiemian",
  "reuters",
  "ap_news",
  "bbc_news",
  "bloomberg",
  "nytimes",
  "wsj"
];

function buildNativeSearchHtml(articleUrl, title = "Demo result") {
  return `
    <html>
      <body>
        <a href="${articleUrl}">${title}</a>
        <a href="${articleUrl}?dup=1">Secondary result</a>
      </body>
    </html>
  `;
}

function buildArticleHtml({ title, summary, author, publishedAt, paragraphs = [], restricted = false }) {
  return `
    <html>
      <head>
        <title>${title}</title>
        <meta name="description" content="${summary}">
        <meta property="article:author" content="${author}">
        <meta property="article:published_time" content="${publishedAt}">
      </head>
      <body>
        <article>
          ${restricted ? '<p>Subscribe to continue reading this article.</p>' : ''}
          ${paragraphs.map((item) => `<p>${item}</p>`).join("\n")}
        </article>
      </body>
    </html>
  `;
}

function inferArticleUrlFromSearchRequest(url) {
  const value = String(url);
  if (value.includes("so.news.cn")) return "https://www.news.cn/politics/20260319/demo.htm";
  if (value.includes("search.people.com.cn")) return "https://www.people.com.cn/n1/2026/0319/c12345-12345678.html";
  if (value.includes("search.cctv.com")) return "https://news.cctv.com/2026/03/19/ARTIdemo.shtml";
  if (value.includes("thepaper.cn/searchResult")) return "https://www.thepaper.cn/newsDetail_forward_12345678";
  if (value.includes("search.caixin.com")) return "https://www.caixin.com/2026-03-19/102345678.html";
  if (value.includes("jiemian.com/search")) return "https://www.jiemian.com/article/12345678.html";
  if (value.includes("reuters.com/site-search")) return "https://www.reuters.com/world/demo-story-2026-03-19/";
  if (value.includes("apnews.com/search")) return "https://apnews.com/article/demo-story-1234567890abcdef";
  if (value.includes("bbc.co.uk/search")) return "https://www.bbc.com/news/articles/demo123456";
  if (value.includes("bloomberg.com/search")) return "https://www.bloomberg.com/news/articles/2026-03-19/demo-story";
  if (value.includes("nytimes.com/search")) return "https://www.nytimes.com/2026/03/19/world/demo-story.html";
  if (value.includes("wsj.com/search")) return "https://www.wsj.com/articles/demo-story-1234567890";
  return null;
}

test("news connectors should be discoverable through native-first search", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const articleUrl = inferArticleUrlFromSearchRequest(url);
    if (!articleUrl) {
      throw new Error(`Unexpected URL: ${url}`);
    }
    return {
      ok: true,
      text: async () => buildNativeSearchHtml(articleUrl, `Headline for ${articleUrl}`)
    };
  };

  try {
    const results = await invokeSourceTool({
      action: "discover",
      query: "market update",
      connector_ids: NEWS_CONNECTOR_IDS
    });
    const ids = new Set(results.map((item) => item.connector));
    for (const id of NEWS_CONNECTOR_IDS) {
      assert.ok(ids.has(id), `missing discovery result for ${id}`);
    }
    assert.ok(results.every((item) => item.id && item.title && item.url && item.summary));
  } finally {
    global.fetch = originalFetch;
  }
});

test("news read sources should return structured reads across representative site types", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("news.cn")) {
      return { ok: true, text: async () => buildArticleHtml({
        title: "Xinhua title",
        summary: "Official summary",
        author: "Xinhua Reporter",
        publishedAt: "2026-03-19T00:00:00Z",
        paragraphs: [
          "This is a long enough paragraph to be captured as structured article text from the open Chinese news site.",
          "Another paragraph provides additional facts and context for the reading pipeline to normalize correctly."
        ]
      }) };
    }
    if (value.includes("reuters.com")) {
      return { ok: true, text: async () => buildArticleHtml({
        title: "Reuters title",
        summary: "International summary",
        author: "Reuters Staff",
        publishedAt: "2026-03-19T00:00:00Z",
        paragraphs: [
          "Reuters paragraph one contains enough detail to qualify as extracted article content in the generic parser.",
          "Reuters paragraph two continues the report and makes the read result suitable for downstream evidence extraction."
        ]
      }) };
    }
    if (value.includes("bloomberg.com")) {
      return { ok: true, text: async () => buildArticleHtml({
        title: "Bloomberg title",
        summary: "Markets summary available before the paywall",
        author: "Bloomberg News",
        publishedAt: "2026-03-19T00:00:00Z",
        paragraphs: [],
        restricted: true
      }) };
    }
    if (value.includes("jiemian.com")) {
      return { ok: true, text: async () => buildArticleHtml({
        title: "Jiemian title",
        summary: "Business summary",
        author: "Jiemian Reporter",
        publishedAt: "2026-03-19T00:00:00Z",
        paragraphs: [
          "Jiemian paragraph one covers a company and industry angle with enough text for structured extraction.",
          "Jiemian paragraph two adds the commercial context expected from a domestic business news source."
        ]
      }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const xinhuaRead = await readCandidate({
      id: "xinhua:1",
      connector: "xinhua",
      title: "Xinhua title",
      url: "https://www.news.cn/politics/20260319/demo.htm",
      author: "Xinhua Reporter",
      source_type: "web",
      content_type: "web"
    });
    assert.equal(xinhuaRead.access_limited, false);
    assert.match(xinhuaRead.markdown, /structured article text/i);

    const reutersRead = await readCandidate({
      id: "reuters:1",
      connector: "reuters",
      title: "Reuters title",
      url: "https://www.reuters.com/world/demo-story-2026-03-19/",
      author: "Reuters Staff",
      source_type: "web",
      content_type: "web"
    });
    assert.equal(reutersRead.access_limited, false);
    assert.match(reutersRead.markdown, /Reuters paragraph one/);

    const bloombergRead = await readCandidate({
      id: "bloomberg:1",
      connector: "bloomberg",
      title: "Bloomberg title",
      url: "https://www.bloomberg.com/news/articles/2026-03-19/demo-story",
      author: "Bloomberg News",
      source_type: "web",
      content_type: "web"
    });
    assert.equal(bloombergRead.access_limited, true);
    assert.match(bloombergRead.markdown, /Access limited/i);

    const jiemianRead = await readCandidate({
      id: "jiemian:1",
      connector: "jiemian",
      title: "Jiemian title",
      url: "https://www.jiemian.com/article/12345678.html",
      author: "Jiemian Reporter",
      source_type: "web",
      content_type: "web"
    });
    assert.equal(jiemianRead.access_limited, false);
    assert.match(jiemianRead.markdown, /commercial context/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolveDiscoverConnectors should retain newly added news connectors", () => {
  const connectors = sourceInternal.resolveDiscoverConnectors(["reuters", "xinhua", "wsj", "missing"]);
  assert.deepEqual(connectors.map((item) => item.id), ["xinhua", "reuters", "wsj"]);
});

test("site hints should map major news domains to the new connector ids", () => {
  const profiles = siteInternal.profilesFromTableRows([
    ["Site", "Domain", "Category", "Tags"],
    ["Reuters", "https://www.reuters.com", "News", "breaking, markets"],
    ["People", "https://www.people.com.cn", "News", "official, china"],
    ["BBC", "https://www.bbc.com", "News", "international"],
    ["Jiemian", "https://www.jiemian.com", "News", "business"]
  ], "News");

  assert.equal(profiles[0].connector_id, "reuters");
  assert.equal(profiles[1].connector_id, "people");
  assert.equal(profiles[2].connector_id, "bbc_news");
  assert.equal(profiles[3].connector_id, "jiemian");
});
