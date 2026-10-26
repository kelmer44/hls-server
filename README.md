# Audio HLS Interstitial Live Server

This is a small local prototype for an audio-only live HLS stream that schedules HLS interstitials over in-band broadcast ad audio.

The main playlist is a sliding live playlist at `/live.m3u8`. It loops content segments and inserts two broadcast ad segments in a row at each ad break: `broadcast-ad-1.ts` followed by `broadcast-ad-2.ts`. The server emits the `CLASS="com.apple.hls.interstitial"` daterange before playback reaches each break. The interstitial tag includes:

- `CLASS="com.apple.hls.interstitial"`
- `X-ASSET-LIST` pointing to `/interstitial-assets.json?interstitialId=...&duration=...`, which resolves the ad group into per-asset `.m3u8` playlists for `interstitial-1.ts` and `interstitial-2.ts`
- `PLANNED-DURATION` equal to the two-segment interstitial duration
- `X-PLAYOUT-LIMIT` selected from a configurable pattern for successive breaks
- Optional `X-RESUME-OFFSET` to control where primary playback resumes independently of the limit
- `X-SNAP="OUT,IN"` so interstitial playback snaps out of and back into the primary stream
- `X-TIMELINE-OCCUPIES="RANGE"`, `X-TIMELINE-STYLE="HIGHLIGHT"`, and `X-CONTENT-MAY-VARY="YES"`

Optional prefetch `EXT-X-DATERANGE` tags can be enabled with `PREFETCH_DATERANGES=1`. These tags are emitted before the segment selected by `prefetchChunksBeforeBreak` and use `X-PREFETCH-DURATION` and `X-PREFETCH-ID` to mirror the marker shape used by production live streams.

## Run

```sh
npm run generate
npm start
```

Runtime config is read from `config.json` by default. The loader accepts `//` and `/* ... */` comments (JSONC); trailing commas are not supported:

```json
{
  "maxUsableChunks": 6,
  "chunksBetweenAdBreaks": 3,
  "prefetchDateRanges": true,
  "prefetchChunksBeforeBreak": 1,
  "interstitialAdCountPattern": [2],
  "interstitialAdOrderPattern": [[1, 2]],
  "interstitialPlayoutLimitPattern": [3, 8, 12.074666],
  "interstitialResumeOffset": 12.074666
}
```

`maxUsableChunks` selects how many numbered content chunks to cycle through (1–48, default 6). `chunksBetweenAdBreaks` sets the number of content chunks between each pair of broadcast ads (a positive integer, default 3). The counters are independent: chunk numbering wraps without resetting the ad cadence, even when the settings do not divide evenly. Ads always remain two broadcast segments per break.

`prefetchChunksBeforeBreak` sets how many stream chunks before its break a prefetch marker starts (a positive integer, default 1). Each chunk is 6.037333 seconds, so `1` is about 6 seconds before the break and `3` is about 18 seconds. The marker's `END-DATE` remains the break start, and `X-PREFETCH-DURATION` remains the ad break duration. The offset counts all stream segments, including any earlier broadcast ads. Environment override: `PREFETCH_CHUNKS_BEFORE_BREAK=3`. Restart the server after changing it.

The defaults produce `chunk1–chunk2–chunk3–ad1–ad2–chunk4–chunk5–chunk6–ad1–ad2`, repeating. To observe prefetch with a 90-second buffer, try:

```json
{
  "maxUsableChunks": 48,
  "chunksBetweenAdBreaks": 24,
  "prefetchDateRanges": true
}
```

This gives about 145 seconds of content between breaks. Each chunk lasts about 6.037 seconds; use at least 15 chunks to exceed 90 seconds. The settings also accept environment overrides: `MAX_USABLE_CHUNKS=48 CHUNKS_BETWEEN_AD_BREAKS=24 npm start`. Generate media once to create all 48 numbered chunks, then restart the server after changing config; no regeneration is needed when changing either setting.

`interstitialAdCountPattern` controls how many interstitial ads are returned for each break. `[1, 2]` alternates one-ad and two-ad breaks. Use `[2]` to keep both assets available when testing playout limits. The asset durations and `PLANNED-DURATION` do not change when the limit changes.

`interstitialAdOrderPattern` controls asset order for successive breaks. The default `[[1, 2]]` always returns ad 1 then ad 2. Use `[[1, 2], [2, 1]]` to alternate orders, or `[[2, 1]]` to always reverse them. Each entry must contain both ad numbers exactly once; the ad-count pattern selects how many to take from that order. The order stays stable across playlist reloads. Environment override: `INTERSTITIAL_AD_ORDER_PATTERN='[[1,2]]'`. The Media3 demo asset-list resolver preserves the server's asset order and durations before appending any shim.

`interstitialPlayoutLimitPattern` selects the limit in seconds by break ordinal, so the same break keeps its value across playlist reloads. If omitted, the limit defaults to the full two-ad duration. `interstitialResumeOffset` emits an explicit `X-RESUME-OFFSET`; omit it to test the player's automatic resume behavior. Restart the server after editing config.

## Testing PlayoutLimit in Media3

The checked-in config cycles through three cases, with two approximately 6.037333-second ads available in every asset list:

| Limit | Expected interstitial audio |
| --- | --- |
| 3 seconds | Ad 1 starts, then cuts off; ad 2 is never played. |
| 8 seconds | Ad 1 plays fully; ad 2 plays for about 1.963 seconds, then cuts off. |
| 12.074666 seconds | Both ads play fully (control case). |

The limit applies to the entire interstitial, across both assets. Each asset still declares its full duration and serves its full audio: the player must enforce the cutoff. No media regeneration is needed for this test.

The explicit 12.074666-second resume offset skips both primary broadcast ads in all three cases. Playback should return to `Chunk 4` or `Chunk 1`, depending on the break. Shorter interstitials advance playback relative to the live edge; this is expected with a fixed resume offset. Removing the offset tests a different behavior, where the limit and `X-SNAP="OUT,IN"` can affect the primary resume position.

Play `/live.m3u8` in your modified Media3 player, enter a break through normal playback, and observe at least three successive breaks (roughly 90 seconds). The starting case depends on the server's current break ordinal. Inspect the `ad-break-N` dateranges in the manifest or Charles to identify each limit. Time actual ad playback; asset requests can happen ahead of playback and do not prove an asset was played. The browser preview can help inspect the stream, but Media3 is the player under test.

In the inspected custom Media3 source, `HlsInterstitialsAdsLoader.insertOrUpdateInterstitialInAdGroup` initially records `playoutLimitUs`, but `LoaderCallback.onLoadCompleted` replaces it with each asset's full `durationUs` when resolving `X-ASSET-LIST`. This appears to discard the limit. If all cases play both full ads, inspect that path: it needs to distribute the remaining interstitial budget across assets and exclude assets beyond the budget. This server deliberately keeps the full asset durations so that it can expose that behavior.

To restore the previous server configuration, use `interstitialAdCountPattern: [2, 1]` and remove `interstitialPlayoutLimitPattern` and `interstitialResumeOffset`.

To use a different config file:

```sh
CONFIG_PATH=/path/to/config.json npm start
```

Environment variables still override the config file for quick local testing:

```sh
PREFETCH_DATERANGES=1 INTERSTITIAL_AD_COUNT_PATTERN=1,2 npm start
```

To repeat just the 3-second cutoff case:

```sh
INTERSTITIAL_AD_COUNT_PATTERN=2 INTERSTITIAL_PLAYOUT_LIMIT_PATTERN=3 INTERSTITIAL_RESUME_OFFSET=12.074666 npm start
```

Open:

```text
http://127.0.0.1:8765/live.m3u8
```

For the standard Android emulator, use the host-loopback address:

```text
http://10.0.2.2:8765/live.m3u8
```

When the Android device or emulator is configured to use Charles Proxy on the Mac, use the Mac's LAN IP instead. Do not use `10.0.2.2` through Charles, because Charles resolves that address from the Mac side.

Example:

```text
http://192.168.68.128:8765/live.m3u8
```

There is also a minimal preview page:

```text
http://127.0.0.1:8765/
```

## Notes

- Media generation uses local `say` and `ffmpeg`.
- All media is audio-only AAC in MPEG-TS containers.
- The live playlist advances by wall clock time and keeps a 16-segment window, about 96.6 seconds. The number of visible breaks depends on `chunksBetweenAdBreaks`; longer intervals can leave the window with no breaks.
- Upcoming interstitials are advertised four segments before the break, which is enough lead time for players that resolve asset lists about three target durations ahead.
- Broadcast ad assets are grouped into one ad break, so supported players should replace `broadcast-ad-1.ts` and `broadcast-ad-2.ts` with the `.m3u8` playlists returned by the asset-list endpoint.
- All 48 generated content segments speak their chunk number first, then use a unique sine tone for the rest of the chunk, alternating low and high frequencies so consecutive chunks are easy to distinguish.
