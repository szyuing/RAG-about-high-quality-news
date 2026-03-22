const test = require("node:test");
const assert = require("node:assert/strict");
const { __internal } = require("../src/source-connectors");

test("parseYouTubeSearchHtml should parse native YouTube search results", () => {
  const html = `
    <html><body><script>
      var ytInitialData = {
        "contents": {
          "twoColumnSearchResultsRenderer": {
            "primaryContents": {
              "sectionListRenderer": {
                "contents": [{
                  "itemSectionRenderer": {
                    "contents": [{
                      "videoRenderer": {
                        "videoId": "abc123xyz",
                        "title": { "runs": [{ "text": "OpenAI Demo" }] },
                        "ownerText": { "runs": [{ "text": "OpenAI" }] },
                        "publishedTimeText": { "simpleText": "2 days ago" },
                        "lengthText": { "simpleText": "12:34" },
                        "viewCountText": { "simpleText": "1.2M views" },
                        "descriptionSnippet": { "runs": [{ "text": "Model updates and benchmarks." }] },
                        "thumbnail": { "thumbnails": [{ "url": "https://i.ytimg.com/vi/abc123xyz/hqdefault.jpg" }] }
                      }
                    }]
                  }
                }]
              }
            }
          }
        }
      };
    </script></body></html>`;

  const results = __internal.parseYouTubeSearchHtml(html, "openai update");
  assert.equal(results.length, 1);
  assert.equal(results[0].connector, "youtube");
  assert.equal(results[0].content_type, "video");
  assert.equal(results[0].title, "OpenAI Demo");
  assert.equal(results[0].author, "OpenAI");
  assert.equal(results[0].duration, "12:34");
  assert.equal(results[0].url, "https://www.youtube.com/watch?v=abc123xyz");
  assert.equal(results[0].metadata.native_search, true);
});

test("extractYouTubePlayerResponse should expose caption tracks and selector should prefer English manual captions", () => {
  const html = `
    <script>
      var ytInitialPlayerResponse = {
        "captions": {
          "playerCaptionsTracklistRenderer": {
            "captionTracks": [
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=abc123xyz&lang=en&fmt=srv3",
                "languageCode": "en",
                "vssId": ".en",
                "name": { "simpleText": "English" }
              },
              {
                "baseUrl": "https://www.youtube.com/api/timedtext?v=abc123xyz&lang=en&kind=asr",
                "languageCode": "en",
                "vssId": "a.en",
                "name": { "simpleText": "English (auto-generated)" }
              }
            ]
          }
        }
      };
    </script>`;

  const playerResponse = __internal.extractYouTubePlayerResponse(html);
  const tracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
  const selected = __internal.selectYouTubeCaptionTrack(tracks);

  assert.equal(tracks.length, 2);
  assert.equal(selected.languageCode, "en");
  assert.equal(selected.vssId, ".en");
});

test("parseYouTubeCaptionJson3 and parseYouTubeCaptionXml should normalize cues", () => {
  const jsonCues = __internal.parseYouTubeCaptionJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1200, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Second line" }] }
    ]
  });
  const xmlCues = __internal.parseYouTubeCaptionXml(`
    <transcript>
      <text start="0" dur="1.2">Hello &amp; welcome</text>
      <text start="2.5" dur="1.0">Next point</text>
    </transcript>
  `);

  assert.equal(jsonCues.length, 2);
  assert.equal(jsonCues[0].text, "Hello world");
  assert.equal(jsonCues[1].time, "00:01");
  assert.equal(xmlCues.length, 2);
  assert.equal(xmlCues[0].text, "Hello & welcome");
  assert.equal(xmlCues[1].time, "00:02");
});
