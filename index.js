const http = require("http");
const https = require("https");
const { URLSearchParams } = require("url");

const PORT = process.env.PORT || 3000;
const ALLOWED_SECRET = process.env.RELAY_SECRET || "";

const SITE_ORIGIN = "https://www.hkv.cc";
const STREAM_PHP = "https://data.stnye.cc/data/stream.php";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CDN_REFERER = "https://www.hkv.cc/";

function checkSecret(req) {
  if (!ALLOWED_SECRET) return true;
  const u = new URL(req.url, "http://localhost");
  const s = req.headers["x-relay-secret"] || u.searchParams.get("secret");
  return s === ALLOWED_SECRET;
}

function httpsGet(rawUrl, headers) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      https.get(u, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doGet(res.headers.location);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }).on("error", reject);
    };
    doGet(rawUrl);
  });
}

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

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!checkSecret(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }

  const u = new URL(req.url, "http://localhost");

  // health
  if (u.pathname === "/" || u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("stream-relay ok\n");
    return;
  }

  // /stream?id=<32hex>  查询 stream.php
  if (u.pathname === "/stream") {
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
    return;
  }

  // /fetch?u=<url>  代理 CDN 资源（m3u8 playlist + 分片）带防盗链头
  if (u.pathname === "/fetch") {
    const target = u.searchParams.get("u");
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad url");
      return;
    }
    try {
      const upstream = await httpsGet(target, {
        "User-Agent": UA,
        Referer: CDN_REFERER,
        Origin: SITE_ORIGIN,
        Accept: "*/*",
      });
      const ct = upstream.headers["content-type"] || "application/octet-stream";
      res.writeHead(upstream.status, {
        "Content-Type": ct,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(upstream.body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("fetch error: " + err.message);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});

server.listen(PORT, () => {
  console.log(`stream-relay listening on port ${PORT}`);
});
