import urllib.request, json, time
url =  http://localhost:3000/api/search
data = json.dumps({question: 甄嬛传的最后一句话是什么, mode: quick}).encode(utf-8)
req = urllib.request.Request(url, data=data, headers={Content-Type: application/json})
start = time.time()
with urllib.request.urlopen(req, timeout=120) as resp:
    duration = time.time() - start
    body = resp.read().decode(utf-8)
    print(status, resp.status)
    print(seconds, round(duration, 1))
    print(body[:1000])
