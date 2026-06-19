import AVFoundation
import Foundation

let streamURL = URL(string: CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:8765/live.m3u8")!
let runSeconds = TimeInterval(CommandLine.arguments.dropFirst(2).first.flatMap(Double.init) ?? 90)
let startedAt = Date()

func stamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func elapsed() -> String {
    String(format: "%.1fs", Date().timeIntervalSince(startedAt))
}

func log(_ message: String) {
    print("[\(stamp()) +\(elapsed())] \(message)")
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

final class Observer: NSObject {
    let player: AVPlayer
    let item: AVPlayerItem
    var observations: [NSKeyValueObservation] = []
    var periodicToken: Any?

    init(player: AVPlayer, item: AVPlayerItem) {
        self.player = player
        self.item = item
        super.init()
        install()
    }

    deinit {
        if let periodicToken {
            player.removeTimeObserver(periodicToken)
        }
    }

    private func install() {
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
            log(String(format: "tick currentTime=%.3f rate=%.2f status=%@ loaded=[%@]", current, self.player.rate, describe(self.player.timeControlStatus), loaded))
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
        center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
            log("notification=DidPlayToEndTime")
        }
    }

    private func printAccessLog() {
        guard let event = item.accessLog()?.events.last else {
            log("accessLog=<empty>")
            return
        }
        let uri = event.uri ?? "-"
        log(String(format: "accessLog uri=%@ requests=%d stalls=%d downloaded=%.3f observedBitrate=%.0f indicatedBitrate=%.0f",
                   uri,
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

log("AVPlayer HLS interstitial check")
log("stream=\(streamURL.absoluteString)")
log("duration=\(Int(runSeconds))s")

let asset = AVURLAsset(url: streamURL)
let item = AVPlayerItem(asset: asset)
let player = AVPlayer(playerItem: item)
player.automaticallyWaitsToMinimizeStalling = false

let observer = Observer(player: player, item: item)
withExtendedLifetime(observer) {
    player.play()
    RunLoop.main.run(until: Date(timeIntervalSinceNow: runSeconds))
    player.pause()
    log("finished")
}
