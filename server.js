import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const hlsDistDir = path.join(__dirname, "node_modules", "hls.js", "dist");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8765);
const segmentDuration = 6.037333;
const defaultPlaylistWindow = 8;
const mediaVersion = process.env.MEDIA_VERSION || Date.now().toString(36);
let startedAtMs = Date.now() - segmentDuration * 1000 * 3;
const contentAssets = [
  "content-1.ts",
  "content-2.ts",
  "content-3.ts",
  "content-4.ts",
  "content-5.ts",
  "content-6.ts"
];
const broadcastAdAssets = ["broadcast-ad-1.ts", "broadcast-ad-2.ts"];
const interstitialAssets = ["interstitial-1.ts", "interstitial-2.ts"];
const allowedInterstitialAssets = new Set(interstitialAssets);
let adSettings = normalizeAdSettings();

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

function shouldEmitInterstitial(item, sequence, firstSeq) {
  return adSettings.adsEnabled && item.type === "broadcast-ad" && (item.adBreakPosition === 0 || sequence === firstSeq);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeAdSettings(input = {}) {
  return {
    adsEnabled: input.adsEnabled !== false,
    contentSegmentsBeforeAd: clampInteger(input.contentSegmentsBeforeAd, 3, 1, 24),
    adSegmentsPerBreak: clampInteger(input.adSegmentsPerBreak, 2, 1, broadcastAdAssets.length),
    playlistWindow: clampInteger(input.playlistWindow, defaultPlaylistWindow, 3, 30)
  };
}

function resetSchedule() {
  startedAtMs = Date.now() - segmentDuration * 1000 * Math.min(3, adSettings.playlistWindow - 1);
}

function adBreakDuration() {
  return segmentDuration * adSettings.adSegmentsPerBreak;
}

function cycleLength() {
  return adSettings.contentSegmentsBeforeAd + adSettings.adSegmentsPerBreak;
}

function itemAtSequence(sequence) {
  const position = sequence % cycleLength();
  if (position < adSettings.contentSegmentsBeforeAd) {
    const cycleIndex = Math.floor(sequence / cycleLength());
    const contentIndex = cycleIndex * adSettings.contentSegmentsBeforeAd + position;
    return {
      type: "content",
      file: contentAssets[contentIndex % contentAssets.length]
    };
  }

  const adBreakPosition = position - adSettings.contentSegmentsBeforeAd;
  return {
    type: "broadcast-ad",
    file: broadcastAdAssets[adBreakPosition % broadcastAdAssets.length],
    adBreakPosition
  };
}

function nextAdBreakInfo(nowMs = Date.now()) {
  if (!adSettings.adsEnabled) {
    return null;
  }

  const elapsedSegments = Math.max(0, Math.floor((nowMs - startedAtMs) / (segmentDuration * 1000)));
  const position = elapsedSegments % cycleLength();
  const segmentsUntilBreak = position < adSettings.contentSegmentsBeforeAd
    ? adSettings.contentSegmentsBeforeAd - position
    : 0;
  const sequence = elapsedSegments + segmentsUntilBreak;
  const startsAtMs = startedAtMs + sequence * segmentDuration * 1000;

  return {
    sequence,
    startsAt: isoAt(startsAtMs),
    secondsUntil: Math.max(0, Number(((startsAtMs - nowMs) / 1000).toFixed(3)))
  };
}

function settingsResponse(req) {
  const baseUrl = requestBaseUrl(req);
  return {
    ...adSettings,
    segmentDuration: Number(formatDuration(segmentDuration)),
    adBreakDuration: Number(formatDuration(adBreakDuration())),
    cycleDuration: Number(formatDuration(segmentDuration * cycleLength())),
    liveUrl: `${baseUrl}/live.m3u8`,
    nextAdBreak: nextAdBreakInfo()
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseDuration(value, fallback) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function livePlaylist(baseUrl) {
  const elapsedSegments = Math.max(0, Math.floor((Date.now() - startedAtMs) / (segmentDuration * 1000)));
  const firstSeq = Math.max(0, elapsedSegments - adSettings.playlistWindow + 1);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${firstSeq}`,
    "#EXT-X-INDEPENDENT-SEGMENTS"
  ];

  for (let sequence = firstSeq; sequence <= elapsedSegments; sequence += 1) {
    const item = itemAtSequence(sequence);
    const startMs = startedAtMs + sequence * segmentDuration * 1000;

    if (shouldEmitInterstitial(item, sequence, firstSeq)) {
      const adBreakStartSequence = sequence - item.adBreakPosition;
      const adBreakStartMs = startedAtMs + adBreakStartSequence * segmentDuration * 1000;
      const id = `ad-break-${adBreakStartSequence}`;
      const duration = adBreakDuration();
      const assetListUri = `${baseUrl}/interstitial-assets.json?interstitialId=${encodeURIComponent(id)}&duration=${formatDuration(duration)}`;
      lines.push(
        `#EXT-X-DATERANGE:ID="${quote(id)}",CLASS="com.apple.hls.interstitial",START-DATE="${isoAt(adBreakStartMs)}",DURATION=${formatDuration(duration)},X-ASSET-LIST="${quote(assetListUri)}",X-RESUME-OFFSET=${formatDuration(duration)},X-PLAYOUT-LIMIT=${formatDuration(duration)}`
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

    if (url.pathname === "/settings") {
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": mimeTypes[".json"],
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(`${JSON.stringify(settingsResponse(req), null, 2)}\n`);
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        adSettings = normalizeAdSettings(body);
        resetSchedule();
        res.writeHead(200, {
          "Content-Type": mimeTypes[".json"],
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(`${JSON.stringify(settingsResponse(req), null, 2)}\n`);
        return;
      }
    }

    if (url.pathname === "/vendor/hls.min.js") {
      await serveVendorHls(res, "hls.min.js");
      return;
    }

    if (url.pathname === "/vendor/hls.min.js.map") {
      await serveVendorHls(res, "hls.min.js.map");
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
      const duration = parseDuration(url.searchParams.get("duration"), adBreakDuration());
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

async function serveVendorHls(res, fileName) {
  const body = await readFile(path.join(hlsDistDir, fileName));
  res.writeHead(200, {
    "Content-Type": fileName.endsWith(".map") ? "application/json; charset=utf-8" : mimeTypes[".js"],
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

if (!existsSync(path.join(publicDir, "media", "content-1.ts"))) {
  console.error("Missing generated media. Run: npm run generate");
  process.exit(1);
}

if (!existsSync(path.join(hlsDistDir, "hls.min.js"))) {
  console.error("Missing hls.js dependency. Run: npm install");
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
