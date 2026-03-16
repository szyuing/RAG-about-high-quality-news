const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal } = require("../src/source-connectors");

test("parseDouyinRenderedPageSafe should extract detail fields from rendered payload", () => {
  const payload = {
    title: "\u996d\u5e97\u7684\u5bd2\u5047\u5de5\uff0c\u5ba2\u4eba\u7ed9\u5c0f\u8d39\uff01 - \u6296\u97f3",
    heading: "\u7b2c54\u96c6 | \u996d\u5e97\u7684\u5bd2\u5047\u5de5\uff0c\u5ba2\u4eba\u7ed9\u5c0f\u8d39\uff01",
    subheadings: ["\u996d\u5e97\u7684\u5bd2\u5047\u5de5", "\u63a8\u8350\u89c6\u9891"],
    bodyText: [
      "\u5f00\u542f\u8bfb\u5c4f\u6807\u7b7e",
      "\u7ae0\u8282\u8981\u70b9",
      "00:00",
      "\u5ba2\u4eba\u7ed9\u5c0f\u8d39\uff0c\u5f20\u7f8e\u73b2\u62a5\u5907",
      "00:17",
      "\u5b59\u6653\u6653\u62a2\u5c0f\u8d39",
      "00:44",
      "\u5b59\u6653\u6653\u8981\u5c0f\u8d39",
      "\u7b2c54\u96c6 | \u996d\u5e97\u7684\u5bd2\u5047\u5de5\uff0c\u5ba2\u4eba\u7ed9\u5c0f\u8d39\uff01",
      "349.6\u4e07",
      "16.4\u4e07",
      "11.8\u4e07",
      "96.1\u4e07",
      "\u4e3e\u62a5",
      "\u53d1\u5e03\u65f6\u95f4\uff1a2026-03-14 18:01",
      "\u5468\u5c0f\u95f9",
      "\u7c89\u4e1d2478.0\u4e07\u83b7\u8d5e8.4\u4ebf",
      "\u5173\u6ce8"
    ].join("\n"),
    videos: [
      {
        src: "https://v26-web.douyinvod.com/demo.mp4?__vid=7616963043788302772",
        poster: "",
        duration: 156.713991
      }
    ],
    jsonLd: [
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "\u6296\u97f3" },
          { "@type": "ListItem", position: 2, name: "\u5468\u5c0f\u95f9" },
          { "@type": "ListItem", position: 3, name: "\u89c6\u9891\u4f5c\u54c1" }
        ]
      })
    ]
  };

  const parsed = __internal.parseDouyinRenderedPageSafe(payload);
  assert.equal(parsed.title, "\u7b2c54\u96c6 | \u996d\u5e97\u7684\u5bd2\u5047\u5de5\uff0c\u5ba2\u4eba\u7ed9\u5c0f\u8d39\uff01");
  assert.equal(parsed.series_title, "\u996d\u5e97\u7684\u5bd2\u5047\u5de5");
  assert.equal(parsed.author, "\u5468\u5c0f\u95f9");
  assert.equal(parsed.published_at, "2026-03-14T10:01:00.000Z");
  assert.equal(parsed.duration, "02:36");
  assert.deepEqual(parsed.metrics, ["349.6\u4e07", "16.4\u4e07", "11.8\u4e07", "96.1\u4e07"]);
  assert.equal(parsed.timeline[0].start, "00:00");
  assert.match(parsed.timeline[0].summary, /\u5ba2\u4eba\u7ed9\u5c0f\u8d39/);
});
