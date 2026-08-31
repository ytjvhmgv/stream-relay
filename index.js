const http = require("http");
const https = require("https");
const { URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_SECRET = process.env.RELAY_SECRET || "";
const SITE_ORIGIN = "https://www.hkv.cc";
const STREAM_PHP = "https://data.stnye.cc/data/stream.php";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CDN_REFERER = "https://www.hkv.cc/";

const agent = new https.Agent({ keepAlive: true, maxSockets: 32, timeout: 20000 });
process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));

function checkSecret(req) {
  if (!ALLOWED_SECRET) return true;
  const u = new URL(req.url, "http://localhost");
  const s = req.headers["x-relay-secret"] || u.searchParams.get("secret");
  return s === ALLOWED_SECRET;
}

function send(res, status, body, headers) {
  if (res.headersSent) return;
  res.writeHead(status, headers || { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function httpsBuffer(rawUrl, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  const body = opts.body;
  const timeoutMs = opts.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers, agent
    }, (up) => {
      if ([301, 302, 307, 308].includes(up.statusCode)) {
        const loc = up.headers.location; up.resume();
        if (!loc) return reject(new Error("redirect without location"));
        return resolve(httpsBuffer(new URL(loc, rawUrl).href, opts));
      }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsPipe(rawUrl, outRes, headers, timeoutMs) {
  headers = headers || {};
  timeoutMs = timeoutMs || 25000;
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: "GET", headers, agent
    }, (up) => {
      if ([301, 302, 307, 308].includes(up.statusCode)) {
        const loc = up.headers.location; up.resume();
        if (!loc) return reject(new Error("redirect without location"));
        return resolve(httpsPipe(new URL(loc, rawUrl).href, outRes, headers, timeoutMs));
      }
      if (!outRes.headersSent) {
        outRes.writeHead(up.statusCode, {
          "Content-Type": up.headers["content-type"] || "application/octet-stream",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });
      }
      up.pipe(outRes);
      up.on("end", resolve);
      up.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchStream(id) {
  const body = new URLSearchParams({ id }).toString();
  const r = await httpsBuffer(STREAM_PHP, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": UA,
      Referer: SITE_ORIGIN + "/live_" + id + ".html",
      Origin: SITE_ORIGIN,
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9"
    },
    body
  });
  return { status: r.status, body: r.body.toString("utf8") };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (!checkSecret(req)) { send(res, 403, "forbidden"); return; }
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/" || u.pathname === "/health") { send(res, 200, "stream-relay ok\n"); return; }
    if (u.pathname === "/stream") {
      const id = u.searchParams.get("id");
      if (!id || !/^[a-f0-9]{32}$/i.test(id)) {
        send(res, 400, JSON.stringify({ error: "bad id" }), { "Content-Type": "application/json" });
        return;
      }
      let last = { status: 0, body: "" };
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
        try {
          last = await fetchStream(id);
          let data;
          try { data = JSON.parse(last.body); } catch (e) { continue; }
          if (data && data.status === "success" && data.content) {
            send(res, 200, JSON.stringify(data), { "Content-Type": "application/json" });
            return;
          }
          const msg = String((data && data.content) || "");
          if (!/interrupted|Signal failure|try again|no signal/i.test(msg)) break;
        } catch (err) { last = { status: 0, body: err.message }; }
      }
      send(res, 200, last.body || JSON.stringify({ status: "fail", content: "relay error" }), { "Content-Type": "application/json" });
      return;
    }
    if (u.pathname === "/fetch") {
      const target = u.searchParams.get("u");
      if (!target || !/^https?:\/\//i.test(target)) { send(res, 400, "bad url"); return; }
      await httpsPipe(target, res, { "User-Agent": UA, Referer: CDN_REFERER, Origin: SITE_ORIGIN, Accept: "*/*" });
      return;
    }
    send(res, 404, "not found\n");
  } catch (err) {
    console.error("request error", req.url, err);
    send(res, 502, "fetch error: " + err.message);
  }
});

server.keepAliveTimeout = 75000;
server.headersTimeout = 76000;
server.timeout = 120000;
server.on("error", (err) => console.error("server error", err));
server.listen(PORT, "0.0.0.0", () => {
  console.log("stream-relay listening on 0.0.0.0:" + PORT + " (direct)");
});
