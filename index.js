const http = require("http");
const https = require("https");
const { URLSearchParams } = require("url");

const PORT = process.env.PORT || 3000;
const ALLOWED_SECRET = process.env.RELAY_SECRET || "";

const SITE_ORIGIN = "https://www.hkv.cc";
const STREAM_PHP = "https://data.stnye.cc/data/stream.php";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function fetchStream(id) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ id }).toString();
    const u = new URL(STREAM_PHP);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": UA,
        Referer: `${SITE_ORIGIN}/live_${id}.html`,
        Origin: SITE_ORIGIN,
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (ALLOWED_SECRET) {
    const u = new URL(req.url, "http://localhost");
    const secret = req.headers["x-relay-secret"] || u.searchParams.get("secret");
    if (secret !== ALLOWED_SECRET) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }
  }

  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/" || u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("stream-relay ok\n");
    return;
  }

  if (u.pathname !== "/stream") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }

  const id = u.searchParams.get("id");
  if (!id || !/^[a-f0-9]{32}$/i.test(id)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad id" }));
    return;
  }

  let last = { status: 0, body: "" };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      last = await fetchStream(id);
      let data;
      try { data = JSON.parse(last.body); } catch { continue; }
      if (data && data.status === "success" && data.content) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      const msg = String((data && data.content) || "");
      if (!/interrupted|Signal failure|try again|no signal/i.test(msg)) break;
    } catch (err) {
      last = { status: 0, body: err.message };
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(last.body || JSON.stringify({ status: "fail", content: "relay error" }));
});

server.listen(PORT, () => {
  console.log(`stream-relay listening on port ${PORT}`);
});
