import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const hlsJsPath = path.join(__dirname, "node_modules", "hls.js", "dist", "hls.min.js");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8765);
const segmentDuration = 6.037333;
const adBreakSegments = 2;
const adBreakDuration = segmentDuration * adBreakSegments;
const playlistWindow = 16;
const interstitialLeadSegments = Math.ceil((3 * Math.ceil(segmentDuration)) / segmentDuration);
const mediaVersion = process.env.MEDIA_VERSION || Date.now().toString(36);
const startedAtMs = Date.now() - segmentDuration * 1000 * (playlistWindow + interstitialLeadSegments);
const interstitialAssets = ["interstitial-1.ts", "interstitial-2.ts"];
const allowedInterstitialAssets = new Set(interstitialAssets);

const loop = [
  { type: "content", file: "content-1.ts" },
  { type: "content", file: "content-2.ts" },
  { type: "content", file: "content-3.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-1.ts", adBreakPosition: 0 },
  { type: "broadcast-ad", file: "broadcast-ad-2.ts", adBreakPosition: 1 },
  { type: "content", file: "content-4.ts" },
  { type: "content", file: "content-5.ts" },
  { type: "content", file: "content-6.ts" },
  { type: "broadcast-ad", file: "broadcast-ad-1.ts", adBreakPosition: 0 },
  { type: "broadcast-ad", file: "broadcast-ad-2.ts", adBreakPosition: 1 }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".json": "application/json; charset=utf-8",
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

function parseDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function adBreakStartForSequence(sequence) {
  const item = loop[sequence % loop.length];
  if (item.type !== "broadcast-ad") {
    return null;
  }
  return sequence - item.adBreakPosition;
}

function interstitialDateRange(baseUrl, adBreakStartSequence) {
  const adBreakStartMs = startedAtMs + adBreakStartSequence * segmentDuration * 1000;
  const id = `ad-break-${adBreakStartSequence}`;
  const assetListUri = `${baseUrl}/interstitial-assets.json?interstitialId=${encodeURIComponent(id)}&duration=${formatDuration(adBreakDuration)}`;
  return `#EXT-X-DATERANGE:ID="${quote(id)}",CLASS="com.apple.hls.interstitial",START-DATE="${isoAt(adBreakStartMs)}",DURATION=${formatDuration(adBreakDuration)},X-ASSET-LIST="${quote(assetListUri)}",X-RESUME-OFFSET=${formatDuration(adBreakDuration)},X-PLAYOUT-LIMIT=${formatDuration(adBreakDuration)}`;
}

function interstitialStartSequences(firstSeq, elapsedSegments) {
  const startSequences = new Set();
  const lastSeqToAdvertise = elapsedSegments + interstitialLeadSegments;
  for (let sequence = firstSeq; sequence <= lastSeqToAdvertise; sequence += 1) {
    const adBreakStartSequence = adBreakStartForSequence(sequence);
    if (adBreakStartSequence !== null && adBreakStartSequence >= firstSeq - adBreakSegments + 1) {
      startSequences.add(adBreakStartSequence);
    }
  }
  return Array.from(startSequences).sort((a, b) => a - b);
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

  for (const adBreakStartSequence of interstitialStartSequences(firstSeq, elapsedSegments)) {
    lines.push(interstitialDateRange(baseUrl, adBreakStartSequence));
  }

  for (let sequence = firstSeq; sequence <= elapsedSegments; sequence += 1) {
    const item = loop[sequence % loop.length];
    const startMs = startedAtMs + sequence * segmentDuration * 1000;

    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${isoAt(startMs)}`);
    if (sequence > firstSeq) {
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push(`#EXTINF:${formatDuration(segmentDuration)},`);
    lines.push(`/media/${item.file}?v=${mediaVersion}&seq=${sequence}`);
  }

  return `${lines.join("\n")}\n`;
}

function assetPlaylistLines(asset, duration) {
  return [
    `#EXTINF:${formatDuration(duration)},`,
    `/media/${asset}?v=${mediaVersion}`
  ];
}

function interstitialPlaylist(asset, duration) {
  const assets = asset && allowedInterstitialAssets.has(asset) ? [asset] : interstitialAssets;
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...assets.flatMap((asset) => assetPlaylistLines(asset, duration)),
    "#EXT-X-ENDLIST"
  ].join("\n") + "\n";
}

function interstitialAssetList(baseUrl, interstitialId, duration) {
  const assetDuration = duration / interstitialAssets.length;
  return {
    ASSETS: interstitialAssets.map((asset, index) => {
      const uri = new URL("/interstitial.m3u8", baseUrl);
      uri.searchParams.set("interstitialId", interstitialId);
      uri.searchParams.set("asset", asset);
      uri.searchParams.set("duration", formatDuration(assetDuration));
      uri.searchParams.set("position", String(index + 1));

      return {
        URI: uri.toString(),
        DURATION: Number(formatDuration(assetDuration))
      };
    })
  };
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

async function serveHlsJs(res) {
  const body = await readFile(hlsJsPath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[".js"],
    "Cache-Control": "public, max-age=31536000, immutable",
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

    if (url.pathname === "/vendor/hls.min.js") {
      await serveHlsJs(res);
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
      const asset = url.searchParams.get("asset");
      const duration = parseDuration(url.searchParams.get("duration"), segmentDuration);
      res.writeHead(200, {
        "Content-Type": mimeTypes[".m3u8"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(interstitialPlaylist(asset, duration));
      return;
    }

    if (url.pathname === "/interstitial-assets.json") {
      const interstitialId = url.searchParams.get("interstitialId") || "ad-break";
      const duration = parseDuration(url.searchParams.get("duration"), adBreakDuration);
      res.writeHead(200, {
        "Content-Type": mimeTypes[".json"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(`${JSON.stringify(interstitialAssetList(requestBaseUrl(req), interstitialId, duration), null, 2)}\n`);
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
