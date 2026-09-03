const http = require("http");
const https = require("https");
const { URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || process.env.LISTEN_PORT || 3000);
const ALLOWED_SECRET = process.env.RELAY_SECRET || "";
const SITE_ORIGIN = "https://www.hkv.cc";
const CDN_REFERER = "https://www.hkv.cc/";
const STREAM_PHP = "https://data.stnye.cc/data/stream.php";
const EVENTS_URL = "https://api.sportlive.cc/data/events.json";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const agent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 20000 });

let cachedLiveStreams = null;
let cachedLiveStreamsTime = 0;

process.on("uncaughtException", (err) => console.error("uncaughtException", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
console.log("boot", { PORT, NODE_ENV: process.env.NODE_ENV, hasSecret: Boolean(ALLOWED_SECRET) });

function checkSecret(req) {
  if (!ALLOWED_SECRET) return true;
  const u = new URL(req.url, "http://localhost");
  const s = req.headers["x-relay-secret"] || u.searchParams.get("secret");
  return s === ALLOWED_SECRET;
}

function getSecretParam(req) {
  if (!ALLOWED_SECRET) return "";
  const u = new URL(req.url, "http://localhost");
  const s = req.headers["x-relay-secret"] || u.searchParams.get("secret");
  return s === ALLOWED_SECRET ? s : "";
}

function send(res, status, body, headers) {
  if (res.headersSent) return;
  const h = Object.assign(
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    headers || {}
  );
  res.writeHead(status, h);
  if (res.req && res.req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function publicOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  let proto;
  if (forwardedProto) {
    proto = String(forwardedProto).split(",")[0].trim();
  } else if (req.socket && req.socket.encrypted) {
    proto = "https";
  } else {
    const host = String(req.headers.host || "");
    proto = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(host) ? "http" : "https";
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function cdnHeaders() {
  return {
    "User-Agent": UA,
    Referer: CDN_REFERER,
    Origin: SITE_ORIGIN,
    Accept: "*/*",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsBuffer(rawUrl, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  const body = opts.body;
  const timeoutMs = opts.timeoutMs || 15000;
  const redirectCount = opts.redirectCount || 0;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (err) {
      return reject(new Error("bad url: " + rawUrl));
    }
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        agent,
      },
      (up) => {
        if ([301, 302, 307, 308].includes(up.statusCode)) {
          const loc = up.headers.location;
          up.resume();
          if (!loc) return reject(new Error("redirect without location"));
          if (redirectCount > 5) return reject(new Error("too many redirects"));
          return resolve(
            httpsBuffer(new URL(loc, rawUrl).href, Object.assign({}, opts, { redirectCount: redirectCount + 1 }))
          );
        }
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsPipe(rawUrl, outRes, headers, timeoutMs, redirectCount) {
  headers = headers || {};
  timeoutMs = timeoutMs || 25000;
  redirectCount = redirectCount || 0;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (err) {
      return reject(new Error("bad url: " + rawUrl));
    }
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        agent,
      },
      (up) => {
        if ([301, 302, 307, 308].includes(up.statusCode)) {
          const loc = up.headers.location;
          up.resume();
          if (!loc) return reject(new Error("redirect without location"));
          if (redirectCount > 5) return reject(new Error("too many redirects"));
          return resolve(httpsPipe(new URL(loc, rawUrl).href, outRes, headers, timeoutMs, redirectCount + 1));
        }
        if (!outRes.headersSent) {
          outRes.writeHead(up.statusCode, {
            "Content-Type": up.headers["content-type"] || "application/octet-stream",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          });
        }
        up.pipe(outRes);
        up.on("end", resolve);
        up.on("error", reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    outRes.on("close", () => {
      if (!req.destroyed) req.destroy();
    });
    req.end();
  });
}

function channelName(r) {
  return `${r.competition || "常规赛"}_${String(r.title || "未知").replace(/\s+/g, "_")}_${r.lang || "原音"}_${r.hd || "HD"}`;
}

function isTruthyLive(v) {
  return v === 1 || v === "1" || v === true;
}

function eventTimeLive(event, now) {
  now = now || Date.now();
  const start = Date.parse(event.startTs || "");
  const end = Date.parse(event.endTs || "");
  if (!Number.isFinite(start)) return false;
  if (now < start) return false;
  if (Number.isFinite(end) && now >= end) return false;
  return true;
}

function extractStreamUrl(html) {
  if (!html) return null;
  const trimmed = html.trim().replace(/^"|"$/g, "");
  if (/^https?:\/\/\S+\.(m3u8|mpd)(\?|#|$)/i.test(trimmed)) return trimmed.split(/\s/)[0];
  const srcMatch =
    html.match(/src\s*=\s*`([^`]+?)`/i) ||
    html.match(/src\s*=\s*'([^']+?)'/i) ||
    html.match(/src\s*=\s*"([^"]+?)"/i);
  if (srcMatch) {
    const extracted = srcMatch[1].replace(/^[\s\n\r\t]+|[\s\n\r\t]+$/g, "");
    if (/\.(m3u8|mpd)(?:\?[^#]*)?(?:#.*)?$/i.test(extracted)) return extracted;
  }
  const m = html.match(/https?:\/\/[^\s'"<>]+?\.(?:m3u8|mpd)(?:\?[^\s'"#]*)?(?:#[^\s'"]*)?/i);
  return m ? m[0].replace(/^[\s\n\r\t]+|[\s\n\r\t]+$/g, "") : null;
}

function looksLikePlaylist(buf) {
  const head = (Buffer.isBuffer(buf) ? buf.slice(0, 32).toString("utf8") : String(buf).slice(0, 32)).trim();
  return head.startsWith("#EXTM3U") || head.startsWith("#EXT-X-") || head.startsWith("#EXT");
}

function rewritePlaylist(text, proxyBase, originalUrl) {
  const sep = proxyBase.includes("?") ? "&" : "?";
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_, raw) => {
          try {
            return `URI="${proxyBase}${sep}u=${encodeURIComponent(new URL(raw, originalUrl).href)}"`;
          } catch (err) {
            return `URI="${raw}"`;
          }
        });
      }
      try {
        return `${proxyBase}${sep}u=${encodeURIComponent(new URL(trimmed, originalUrl).href)}`;
      } catch (err) {
        return line;
      }
    })
    .join("\n");
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
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    body,
  });
  return { status: r.status, body: r.body.toString("utf8") };
}

async function listLiveStreams(force) {
  const now = Date.now();
  if (!force && cachedLiveStreams && now - cachedLiveStreamsTime < 30000) {
    return cachedLiveStreams;
  }
  const r = await httpsBuffer(EVENTS_URL, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    timeoutMs: 15000,
  });
  if (r.status >= 400) throw new Error("events.json HTTP " + r.status);
  const eventsData = JSON.parse(r.body.toString("utf8"));
  const liveStreams = [];
  const seen = new Set();
  if (!Array.isArray(eventsData.events)) return liveStreams;
  for (const event of eventsData.events) {
    if (!Array.isArray(event.channels)) continue;
    const timeLive = eventTimeLive(event);
    for (const channel of event.channels) {
      if (!channel || typeof channel === "string" || !channel.id) continue;
      if (!isTruthyLive(channel.islive) && !timeLive) continue;
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      liveStreams.push({
        title: event.title || event.title_en || "未知赛事",
        competition: event.competition || "常规赛",
        lang: channel.islg || "原音",
        hd: channel.ishd || "HD",
        id: channel.id,
      });
    }
  }
  cachedLiveStreams = liveStreams;
  cachedLiveStreamsTime = now;
  return liveStreams;
}

async function resolveStreamUrl(id) {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const result = await fetchStream(id);
      last = result.body;
      let data;
      try {
        data = JSON.parse(last);
      } catch (err) {
        continue;
      }
      if (data && data.status === "success" && data.content) {
        const extracted = extractStreamUrl(String(data.content).replace(/\\\//g, "/"));
        if (extracted) return extracted;
      }
      const msg = String((data && data.content) || "");
      if (!/interrupted|Signal failure|try again|no signal/i.test(msg)) break;
    } catch (err) {
      last = err.message;
    }
  }
  console.error("resolveStreamUrl fail", id, String(last).slice(0, 200));
  return null;
}

async function fetchAndRewrite(targetUrl, proxyBase, res) {
  const isLikelyPlaylist = /\.m3u8?(?:\?|#|$)/i.test(targetUrl);
  if (!isLikelyPlaylist) {
    await httpsPipe(targetUrl, res, cdnHeaders());
    return;
  }
  const upstream = await httpsBuffer(targetUrl, { headers: cdnHeaders(), timeoutMs: 25000 });
  const contentType = String((upstream.headers && upstream.headers["content-type"]) || "").toLowerCase();
  if (!contentType.includes("mpegurl") && !contentType.includes("m3u") && !looksLikePlaylist(upstream.body)) {
    send(res, upstream.status || 200, upstream.body, {
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    return;
  }
  const playlistText = upstream.body.toString("utf8");
  if (!playlistText.trim().startsWith("#EXT")) {
    send(res, 502, "upstream error: " + playlistText.slice(0, 200));
    return;
  }
  send(res, 200, rewritePlaylist(playlistText, proxyBase, targetUrl), {
    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
}

const server = http.createServer(async (req, res) => {
  console.log(new Date().toISOString(), req.method, req.url, req.socket && req.socket.remoteAddress);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const u = new URL(req.url, "http://localhost");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const secret = getSecretParam(req);

    if (ALLOWED_SECRET && !checkSecret(req)) {
      send(res, 403, "forbidden");
      return;
    }

    if (path === "/" || path === "/health") {
      send(res, 200, "stream-relay ok port=" + PORT + " addr=" + JSON.stringify(server.address()) + "\n");
      return;
    }

    const baseOrigin = publicOrigin(req);
    const playBase = baseOrigin + "/play" + (secret ? "?secret=" + encodeURIComponent(secret) : "");
    const proxyBase = baseOrigin + "/proxy" + (secret ? "?secret=" + encodeURIComponent(secret) : "");
    const sep = playBase.includes("?") ? "&" : "?";

    if (path === "/m3u" || path === "/txt") {
      const liveStreams = await listLiveStreams();
      if (path === "/m3u") {
        let body = "#EXTM3U\n";
        for (const row of liveStreams) {
          const name = channelName(row);
          body += `#EXTINF:-1 tvg-name="${name}" tvg-id="${name}" group-title="职球圈",${name}\n`;
          body += `${playBase}${sep}id=${encodeURIComponent(row.id)}\n`;
        }
        send(res, 200, body, {
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": "no-store",
        });
        return;
      }

      let body = "职球圈,#genre#\n";
      for (const row of liveStreams) {
        body += `${channelName(row)},${playBase}${sep}id=${encodeURIComponent(row.id)}\n`;
      }
      send(res, 200, body, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return;
    }

    if (path === "/play") {
      const id = u.searchParams.get("id");
      if (!id) {
        send(res, 400, "missing id");
        return;
      }
      const m3u8 = await resolveStreamUrl(id);
      if (!m3u8) {
        send(res, 404, "无可用串流媒体");
        return;
      }
      await fetchAndRewrite(m3u8, proxyBase, res);
      return;
    }

    if (path === "/proxy") {
      const target = u.searchParams.get("u");
      if (!target || !/^https?:\/\//i.test(target)) {
        send(res, 400, "missing u");
        return;
      }
      await fetchAndRewrite(target, proxyBase, res);
      return;
    }

    if (path === "/debug") {
      const info = {
        time: new Date().toISOString(),
        events: 0,
        live: 0,
        sampleId: null,
        streamHttp: null,
        streamBody: null,
        extracted: null,
        fetchHttp: null,
        playlistHead: null,
      };
      try {
        const liveStreams = await listLiveStreams(true);
        info.live = liveStreams.length;
        info.sampleId = (liveStreams[0] && liveStreams[0].id) || null;
        const ev = await httpsBuffer(EVENTS_URL, { headers: { "User-Agent": UA }, timeoutMs: 15000 });
        info.events = (JSON.parse(ev.body.toString("utf8")).events || []).length;
        if (info.sampleId) {
          const stream = await fetchStream(info.sampleId);
          info.streamHttp = stream.status;
          info.streamBody = String(stream.body).slice(0, 400);
          try {
            const data = JSON.parse(stream.body);
            info.extracted = data && data.content ? extractStreamUrl(String(data.content).replace(/\\\//g, "/")) : null;
          } catch (err) {
            info.extracted = null;
          }
          if (info.extracted) {
            const fr = await httpsBuffer(info.extracted, { headers: cdnHeaders(), timeoutMs: 20000 });
            info.fetchHttp = fr.status;
            info.playlistHead = fr.body.toString("utf8").slice(0, 200);
          }
        }
      } catch (err) {
        info.error = err.message;
      }
      send(res, 200, JSON.stringify(info, null, 2), { "Content-Type": "application/json; charset=utf-8" });
      return;
    }

    if (path === "/stream") {
      const id = u.searchParams.get("id");
      if (!id || !/^[a-f0-9]{32}$/i.test(id)) {
        send(res, 400, JSON.stringify({ error: "bad id" }), { "Content-Type": "application/json" });
        return;
      }
      let last = { status: 0, body: "" };
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(400 * attempt);
        try {
          last = await fetchStream(id);
          let data;
          try {
            data = JSON.parse(last.body);
          } catch (e) {
            continue;
          }
          if (data && data.status === "success" && data.content) {
            send(res, 200, JSON.stringify(data), { "Content-Type": "application/json" });
            return;
          }
          const msg = String((data && data.content) || "");
          if (!/interrupted|Signal failure|try again|no signal/i.test(msg)) break;
        } catch (err) {
          last = { status: 0, body: err.message };
        }
      }
      send(res, 200, last.body || JSON.stringify({ status: "fail", content: "relay error" }), {
        "Content-Type": "application/json",
      });
      return;
    }

    if (path === "/fetch") {
      const target = u.searchParams.get("u");
      if (!target || !/^https?:\/\//i.test(target)) {
        send(res, 400, "bad url");
        return;
      }
      await httpsPipe(target, res, cdnHeaders());
      return;
    }

    send(res, 404, "请访问 /m3u 或 /txt 路径获取直播源\n");
  } catch (err) {
    console.error("request error", req.url, err);
    send(res, 502, "error: " + err.message);
  }
});

server.keepAliveTimeout = 75000;
server.headersTimeout = 76000;
server.timeout = 120000;

function bind(host) {
  server.listen({ port: PORT, host: host, ipv6Only: false }, () => {
    console.log("stream-relay listening", server.address(), "host=" + host);
  });
}

server.on("error", (err) => {
  if (err && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") && !server.listening) {
    console.error("bind", err.code, "fallback 0.0.0.0");
    bind("0.0.0.0");
    return;
  }
  console.error("server error", err);
});

bind("::");
