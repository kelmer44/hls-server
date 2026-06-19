# Audio HLS Interstitial Live Server

This is a small local prototype for an audio-only live HLS stream that schedules HLS interstitials over in-band broadcast ad audio.

The main playlist is a sliding live playlist at `/live.m3u8`. It loops content segments and inserts two broadcast ad segments in a row at each ad break: `broadcast-ad-1.ts` followed by `broadcast-ad-2.ts`. The server emits a prefetch `EXT-X-DATERANGE` before the segment immediately preceding each break, then emits the `CLASS="com.apple.hls.interstitial"` daterange before playback reaches the break. The interstitial tag includes:

- `CLASS="com.apple.hls.interstitial"`
- `X-ASSET-LIST` pointing to `/interstitial-assets.json?interstitialId=...&duration=...`, which resolves the ad group into per-asset `.m3u8` playlists for `interstitial-1.ts` and `interstitial-2.ts`
- `PLANNED-DURATION` equal to the two-segment interstitial duration
- `X-SNAP="OUT,IN"` so interstitial playback snaps out of and back into the primary stream
- `X-TIMELINE-OCCUPIES="RANGE"`, `X-TIMELINE-STYLE="HIGHLIGHT"`, and `X-CONTENT-MAY-VARY="YES"`

The prefetch tag uses `X-PREFETCH-DURATION` and `X-PREFETCH-ID` to mirror the marker shape used by production live streams.

## Run

```sh
npm run generate
npm start
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
- The live playlist advances by wall clock time and keeps a 16-segment window, currently about 96.6 seconds. The ad cadence puts at least three ad breaks in the live window after startup.
- Upcoming interstitials are advertised four segments before the break, which is enough lead time for players that resolve asset lists about three target durations ahead.
- Broadcast ad assets are grouped into one ad break, so supported players should replace `broadcast-ad-1.ts` and `broadcast-ad-2.ts` with the `.m3u8` playlists returned by the asset-list endpoint.
- Generated segments speak their chunk name first, then use a unique sine tone for the rest of the chunk.
