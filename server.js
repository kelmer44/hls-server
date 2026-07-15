import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const hlsJsPath = path.join(__dirname, "node_modules", "hls.js", "dist", "hls.min.js");
const configPath = path.resolve(process.env.CONFIG_PATH || path.join(__dirname, "config.json"));
const config = loadConfig(configPath);

const host = process.env.HOST || config.host || "0.0.0.0";
const port = Number(process.env.PORT || config.port || 8765);
const logRequests = parseBooleanConfig(process.env.REQUEST_LOG, config.logRequests === true);
const prefetchDateRangesEnabled = parseBooleanConfig(process.env.PREFETCH_DATERANGES, config.prefetchDateRanges === true);
const segmentDuration = 6.037333;
const adBreakSegments = 2;
const adBreakDuration = segmentDuration * adBreakSegments;
const playlistWindow = 16;
const interstitialLeadSegments = Math.ceil((3 * Math.ceil(segmentDuration)) / segmentDuration);
const mediaVersion = process.env.MEDIA_VERSION || Date.now().toString(36);
const startedAtMs = Date.now() - segmentDuration * 1000 * (playlistWindow + interstitialLeadSegments);
const interstitialAssets = ["interstitial-1.ts", "interstitial-2.ts"];
const allowedInterstitialAssets = new Set(interstitialAssets);
const interstitialAdCountPattern = parseInterstitialAdCountPattern(
  process.env.INTERSTITIAL_AD_COUNT_PATTERN ?? config.interstitialAdCountPattern
);
const shimDuration = 12.010667;

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

const adBreakStartOffsets = loop.reduce((offsets, item, index) => {
  if (item.type === "broadcast-ad" && item.adBreakPosition === 0) {
    offsets.push(index);
  }
  return offsets;
}, []);

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

function loadConfig(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Ignoring config file ${filePath}: ${error.message}`);
    return {};
  }
}

function parseBooleanConfig(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }
  return fallback;
}

function parseInterstitialAdCountPattern(value) {
  const fallback = [interstitialAssets.length];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const counts = Array.isArray(value)
    ? value.map((part) => Number(part))
    : String(value)
        .split(",")
        .map((part) => Number(part.trim()));

  if (counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count < 1 || count > interstitialAssets.length)) {
    console.warn(
      `Ignoring interstitial ad count pattern ${JSON.stringify(value)}. Use counts from 1 to ${interstitialAssets.length}.`
    );
    return fallback;
  }

  return counts;
}

function parseNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function adBreakStartSequenceFromId(interstitialId) {
  const match = /^ad-break-(\d+)$/.exec(interstitialId);
  return match ? Number(match[1]) : 0;
}

function adBreakStartForSequence(sequence) {
  const item = loop[sequence % loop.length];
  if (item.type !== "broadcast-ad") {
    return null;
  }
  return sequence - item.adBreakPosition;
}

function adBreakOrdinal(adBreakStartSequence) {
  const offset = adBreakStartSequence % loop.length;
  const offsetIndex = adBreakStartOffsets.indexOf(offset);
  if (offsetIndex === -1) {
    return 0;
  }
  return Math.floor(adBreakStartSequence / loop.length) * adBreakStartOffsets.length + offsetIndex;
}

function interstitialAssetsForBreak(adBreakStartSequence) {
  const patternIndex = adBreakOrdinal(adBreakStartSequence) % interstitialAdCountPattern.length;
  const adCount = interstitialAdCountPattern[patternIndex];
  return interstitialAssets.slice(0, adCount);
}

function prefetchDateRange(adBreakStartSequence) {
  const adBreakStartMs = startedAtMs + adBreakStartSequence * segmentDuration * 1000;
  const prefetchStartMs = adBreakStartMs - segmentDuration * 1000;
  const id = `ad-break-${adBreakStartSequence}`;
  const prefetchId = `prefetch_${id}`;
  return `#EXT-X-DATERANGE:ID="${quote(prefetchId)}",START-DATE="${isoAt(prefetchStartMs)}",END-DATE="${isoAt(adBreakStartMs)}",X-PREFETCH-DURATION="${formatDuration(adBreakDuration)}",X-PREFETCH-ID="${quote(id)}"`;
}

function interstitialDateRange(baseUrl, adBreakStartSequence) {
  const adBreakStartMs = startedAtMs + adBreakStartSequence * segmentDuration * 1000;
  const id = `ad-break-${adBreakStartSequence}`;
  const assetListUri = `${baseUrl}/interstitial-assets.json?interstitialId=${encodeURIComponent(id)}&duration=${formatDuration(adBreakDuration)}&adBreakStartSequence=${adBreakStartSequence}`;
  return `#EXT-X-DATERANGE:ID="${quote(id)}",CLASS="com.apple.hls.interstitial",START-DATE="${isoAt(adBreakStartMs)}",PLANNED-DURATION=${formatDuration(adBreakDuration)},X-PLAYOUT-LIMIT=${formatDuration(adBreakDuration)},X-ASSET-LIST="${quote(assetListUri)}",X-SNAP="OUT,IN",X-TIMELINE-OCCUPIES="RANGE",X-TIMELINE-STYLE="HIGHLIGHT",X-CONTENT-MAY-VARY="YES"`;
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

  const advertisedInterstitials = new Set(interstitialStartSequences(firstSeq, elapsedSegments));

  for (let sequence = firstSeq; sequence <= elapsedSegments; sequence += 1) {
    const item = loop[sequence % loop.length];
    const startMs = startedAtMs + sequence * segmentDuration * 1000;
    const nextSequence = sequence + 1;
    const nextInterstitialStartSequence = advertisedInterstitials.has(nextSequence) ? nextSequence : null;

    if (sequence === firstSeq && advertisedInterstitials.has(sequence) && item.type === "broadcast-ad" && item.adBreakPosition === 0) {
      lines.push(interstitialDateRange(baseUrl, sequence));
    }

    if (prefetchDateRangesEnabled && nextInterstitialStartSequence !== null) {
      lines.push(prefetchDateRange(nextInterstitialStartSequence));
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${isoAt(startMs)}`);
    if (sequence > firstSeq) {
      lines.push("#EXT-X-DISCONTINUITY");
    }
    lines.push(`#EXTINF:${formatDuration(segmentDuration)},`);
    lines.push(`/media/${item.file}?v=${mediaVersion}&seq=${sequence}`);
    if (nextInterstitialStartSequence !== null) {
      lines.push(interstitialDateRange(baseUrl, nextInterstitialStartSequence));
    }
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

function shimPlaylist() {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(shimDuration)}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXTINF:${formatDuration(shimDuration)},`,
    `/media/shim.ts?v=${mediaVersion}`,
    "#EXT-X-ENDLIST"
  ].join("\n") + "\n";
}

function interstitialAssetList(baseUrl, interstitialId, duration, adBreakStartSequence) {
  const assets = interstitialAssetsForBreak(adBreakStartSequence);
  const assetDuration = duration / adBreakSegments;
  return {
    ASSETS: assets.map((asset, index) => {
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
    if (logRequests) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}${url.search}`);
    }

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

    if (url.pathname === "/shim.m3u8") {
      res.writeHead(200, {
        "Content-Type": mimeTypes[".m3u8"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(shimPlaylist());
      return;
    }

    if (url.pathname === "/interstitial-assets.json") {
      const interstitialId = url.searchParams.get("interstitialId") || "ad-break";
      const duration = parseDuration(url.searchParams.get("duration"), adBreakDuration);
      const adBreakStartSequence = parseNonNegativeInteger(
        url.searchParams.get("adBreakStartSequence"),
        adBreakStartSequenceFromId(interstitialId)
      );
      res.writeHead(200, {
        "Content-Type": mimeTypes[".json"],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(`${JSON.stringify(interstitialAssetList(requestBaseUrl(req), interstitialId, duration, adBreakStartSequence), null, 2)}\n`);
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
  console.log(`Config file:           ${existsSync(configPath) ? configPath : "not found"}`);
  console.log(`Prefetch dateranges:   ${prefetchDateRangesEnabled ? "enabled" : "disabled"}`);
  console.log(`Interstitial ad count pattern: ${interstitialAdCountPattern.join(",")}`);
});
