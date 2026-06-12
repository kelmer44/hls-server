import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8765);
const segmentDuration = 6.037333;
const playlistWindow = 8;
const mediaVersion = process.env.MEDIA_VERSION || Date.now().toString(36);
const startedAtMs = Date.now() - segmentDuration * 1000 * 3;

const loop = [
  { type: "content", file: "content-1.ts" },
  { type: "content", file: "content-2.ts" },
  { type: "content", file: "content-3.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-1.ts", interstitial: "interstitial-1.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-2.ts", interstitial: "interstitial-2.ts" },
  { type: "content", file: "content-4.ts" },
  { type: "content", file: "content-5.ts" },
  { type: "content", file: "content-6.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-1.ts", interstitial: "interstitial-1.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-2.ts", interstitial: "interstitial-2.ts" }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function quote(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function formatDuration(seconds) {
  return seconds.toFixed(6);
}

function livePlaylist(baseUrl) {
  const elapsedSegments = Math.max(0, Math.floor((Date.now() - startedAtMs) / (segmentDuration * 1000)));
  const firstSeq = Math.max(0, elapsedSegments - playlistWindow + 1);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${firstSeq}`,
    "#EXT-X-INDEPENDENT-SEGMENTS"
  ];

  for (let sequence = firstSeq; sequence <= elapsedSegments; sequence += 1) {
    const item = loop[sequence % loop.length];
    const startMs = startedAtMs + sequence * segmentDuration * 1000;

    if (item.type === "broadcast-ad") {
      const id = `broadcast-ad-${sequence}`;
      const assetUri = `${baseUrl}/interstitial.m3u8?event=${sequence}&asset=${encodeURIComponent(item.interstitial)}`;
      lines.push(
        `#EXT-X-DATERANGE:ID="${quote(id)}",CLASS="com.apple.hls.interstitial",START-DATE="${isoAt(startMs)}",DURATION=${formatDuration(segmentDuration)},X-ASSET-URI="${quote(assetUri)}",X-RESUME-OFFSET=${formatDuration(segmentDuration)},X-PLAYOUT-LIMIT=${formatDuration(segmentDuration)}`
      );
    }

    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${isoAt(startMs)}`);
    if (sequence > firstSeq) {
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push(`#EXTINF:${formatDuration(segmentDuration)},`);
    lines.push(`/media/${item.file}?v=${mediaVersion}&seq=${sequence}`);
  }

  return `${lines.join("\n")}\n`;
}

function interstitialPlaylist(asset = "interstitial-1.ts") {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXTINF:${formatDuration(segmentDuration)},`,
    `/media/${asset}?v=${mediaVersion}`,
    "#EXT-X-ENDLIST"
  ].join("\n") + "\n";
}

function requestBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const hostHeader = req.headers.host || `${host}:${port}`;
  return `${proto}://${hostHeader}`;
}

function localNetworkUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === "IPv4" && !address.internal)
    .map((address) => `http://${address.address}:${port}/live.m3u8`);
}

async function serveStatic(res, urlPath) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden\n");
    return;
  }

  const extension = path.extname(filePath);
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": extension === ".ts" ? "public, max-age=31536000, immutable" : "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      await serveStatic(res, "/index.html");
      return;
    }

    if (url.pathname === "/live.m3u8") {
      res.writeHead(200, {
        "Content-Type": mimeTypes[".m3u8"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(livePlaylist(requestBaseUrl(req)));
      return;
    }

    if (url.pathname === "/interstitial.m3u8") {
      const asset = url.searchParams.get("asset") || "interstitial-1.ts";
      const allowedAssets = new Set(["interstitial-1.ts", "interstitial-2.ts"]);
      res.writeHead(200, {
        "Content-Type": mimeTypes[".m3u8"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(interstitialPlaylist(allowedAssets.has(asset) ? asset : "interstitial-1.ts"));
      return;
    }

    if (url.pathname.startsWith("/media/")) {
      await serveStatic(res, url.pathname);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`${error.stack || error}\n`);
  }
});

if (!existsSync(path.join(publicDir, "media", "content-1.ts"))) {
  console.error("Missing generated media. Run: npm run generate");
  process.exit(1);
}

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`Audio HLS live stream: http://${displayHost}:${port}/live.m3u8`);
  console.log(`Android emulator URL:  http://10.0.2.2:${port}/live.m3u8`);
  for (const url of localNetworkUrls()) {
    console.log(`Phone/Charles URL:     ${url}`);
  }
  console.log(`Preview page:          http://${displayHost}:${port}/`);
});
