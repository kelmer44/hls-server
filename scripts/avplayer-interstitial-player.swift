import AppKit
import AVFoundation
import AVKit

let streamURL = URL(string: CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:8765/live.m3u8")!

func stamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func log(_ message: String) {
    print("[\(stamp())] \(message)")
    fflush(stdout)
}

func describe(_ status: AVPlayer.TimeControlStatus) -> String {
    switch status {
    case .paused:
        return "paused"
    case .waitingToPlayAtSpecifiedRate:
        return "waiting"
    case .playing:
        return "playing"
    @unknown default:
        return "unknown"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var player: AVPlayer!
    private var item: AVPlayerItem!
    private var observations: [NSKeyValueObservation] = []
    private var periodicToken: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let asset = AVURLAsset(url: streamURL)
        item = AVPlayerItem(asset: asset)
        player = AVPlayer(playerItem: item)
        player.volume = 1.0
        player.automaticallyWaitsToMinimizeStalling = true

        let playerView = AVPlayerView(frame: NSRect(x: 0, y: 0, width: 900, height: 220))
        playerView.player = player
        playerView.controlsStyle = .floating

        window = NSWindow(
            contentRect: playerView.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AVPlayer HLS Interstitial Test"
        window.contentView = playerView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        installObservers()
        log("stream=\(streamURL.absoluteString)")
        log("Use the AVPlayer controls in the window. Server REQUEST_LOG=1 should show interstitial asset requests.")
        player.play()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func installObservers() {
        observations.append(player.observe(\.timeControlStatus, options: [.initial, .new]) { player, _ in
            log("timeControlStatus=\(describe(player.timeControlStatus)) reason=\(player.reasonForWaitingToPlay?.rawValue ?? "-") rate=\(player.rate)")
        })

        observations.append(item.observe(\.status, options: [.initial, .new]) { item, _ in
            switch item.status {
            case .unknown:
                log("item.status=unknown")
            case .readyToPlay:
                log("item.status=readyToPlay duration=\(CMTimeGetSeconds(item.duration))")
            case .failed:
                log("item.status=failed error=\(item.error?.localizedDescription ?? "-")")
            @unknown default:
                log("item.status=unknown-default")
            }
        })

        observations.append(item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { item, _ in
            log("likelyToKeepUp=\(item.isPlaybackLikelyToKeepUp)")
        })

        observations.append(item.observe(\.isPlaybackBufferEmpty, options: [.new]) { item, _ in
            log("bufferEmpty=\(item.isPlaybackBufferEmpty)")
        })

        periodicToken = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 2, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            let current = CMTimeGetSeconds(time)
            let loaded = self.item.loadedTimeRanges.map { range in
                let start = CMTimeGetSeconds(range.timeRangeValue.start)
                let duration = CMTimeGetSeconds(range.timeRangeValue.duration)
                return String(format: "%.3f-%.3f", start, start + duration)
            }.joined(separator: ",")
            log(String(format: "tick currentTime=%.3f rate=%.2f status=%@ loaded=[%@]",
                       current,
                       self.player.rate,
                       describe(self.player.timeControlStatus),
                       loaded))
        }

        let center = NotificationCenter.default
        center.addObserver(forName: .AVPlayerItemNewAccessLogEntry, object: item, queue: .main) { [weak self] _ in
            self?.printAccessLog()
        }
        center.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main) { [weak self] _ in
            self?.printErrorLog()
        }
        center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { _ in
            log("notification=PlaybackStalled")
        }
        center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            log("notification=FailedToPlayToEndTime error=\(error?.localizedDescription ?? "-")")
        }
    }

    private func printAccessLog() {
        guard let event = item.accessLog()?.events.last else {
            log("accessLog=<empty>")
            return
        }
        log(String(format: "accessLog uri=%@ requests=%d stalls=%d downloaded=%.3f observedBitrate=%.0f indicatedBitrate=%.0f",
                   event.uri ?? "-",
                   event.numberOfMediaRequests,
                   event.numberOfStalls,
                   event.segmentsDownloadedDuration,
                   event.observedBitrate,
                   event.indicatedBitrate))
    }

    private func printErrorLog() {
        guard let event = item.errorLog()?.events.last else {
            log("errorLog=<empty>")
            return
        }
        log("errorLog status=\(event.errorStatusCode) domain=\(event.errorDomain) comment=\(event.errorComment ?? "-") uri=\(event.uri ?? "-")")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
