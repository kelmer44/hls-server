# Audio HLS Interstitial Live Server

This is a small local prototype for an audio-only live HLS stream that schedules HLS interstitials over in-band broadcast ad audio.

The main playlist is a sliding live playlist at `/live.m3u8`. It loops content segments and periodic `broadcast-ad.ts` segments. Whenever a broadcast ad segment enters the playlist, the server emits an `EXT-X-DATERANGE` tag with:

- `CLASS="com.apple.hls.interstitial"`
- `X-ASSET-URI` pointing to `/interstitial.m3u8`
- `X-RESUME-OFFSET` equal to the broadcast ad duration
- `X-PLAYOUT-LIMIT` equal to the interstitial duration

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
- The live playlist advances by wall clock time and keeps an eight-segment window, currently about 48.3 seconds.
- The same `broadcast-ad.ts` file is reused with a cache-busting `seq` query parameter.
- Broadcast ad audio uses a synthetic voice saying "This is a broadcast ad."
