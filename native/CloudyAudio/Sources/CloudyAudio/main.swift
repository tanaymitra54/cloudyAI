//
//  CloudyAudio
//
//  Captures SYSTEM audio only (meeting output / other participants) via
//  ScreenCaptureKit and streams it to stdout as raw PCM.
//
//  stdout protocol (binary only, never text):
//      repeat: [UInt32 LE byteLength][Int16 LE samples...]
//      byteLength is always even and < 1 MiB.
//      Audio is always 16 000 Hz, mono, signed 16-bit little-endian.
//
//  stderr carries all logs. The microphone is never captured.
//

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Constants

let targetSampleRate: Double = 16_000
let targetChannelCount: AVAudioChannelCount = 1

/// Largest payload we emit per frame: 256 000 samples = 512 000 bytes (< 1 MiB).
let maxSamplesPerFrame = 256_000

// MARK: - Logging (stderr only)

func log(_ message: String) {
    let line = "[CloudyAudio] " + message + "\n"
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func fail(_ message: String, code: Int32) -> Never {
    log("error: " + message)
    exit(code)
}

// MARK: - stdout writer

/// Writes exactly `count` bytes, retrying on partial writes and EINTR.
func writeAll(_ base: UnsafeRawPointer, _ count: Int) -> Bool {
    var written = 0
    while written < count {
        let result = Darwin.write(STDOUT_FILENO, base + written, count - written)
        if result > 0 {
            written += result
            continue
        }
        if result < 0 && errno == EINTR { continue }
        if result < 0 && errno == EAGAIN {
            usleep(500)
            continue
        }
        return false
    }
    return true
}

// MARK: - Audio pipeline

final class AudioPipeline: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {

    private let outputFormat: AVAudioFormat
    private let sampleQueue = DispatchQueue(label: "cloudy.audio.samples", qos: .userInitiated)
    private let stateLock = NSLock()

    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var announcedConversion = false
    private var totalFrames: Int = 0
    private var totalBytes: Int = 0
    private var started = false

    override init() {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: targetChannelCount,
            interleaved: true
        ) else {
            fail("could not create the 16 kHz mono Int16 output format", code: 10)
        }
        self.outputFormat = format
        super.init()
    }

    // MARK: Start

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            if let error = error {
                log("cannot read shareable content: \(error.localizedDescription)")
                exit(3)
            }
            guard let content = content else {
                log("no shareable content returned")
                exit(3)
            }
            guard let display = content.displays.first else {
                log("no capturable display found")
                exit(3)
            }
            self.startStream(display: display)
        }
    }

    private func startStream(display: SCDisplay) {
        // Exclude only our own windows from the (throwaway) video.
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()

        // System audio only. The microphone is never requested.
        config.capturesAudio = true
        config.sampleRate = Int(targetSampleRate)
        config.channelCount = Int(targetChannelCount)
        config.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) {
            config.captureMicrophone = false
        }

        // Minimal video so the stream reliably starts. Frames are discarded.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.scalesToFit = false

        let stream = SCStream(filter: filter, configuration: config, delegate: self)

        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            log("failed to attach stream outputs: \(error.localizedDescription)")
            exit(4)
        }

        self.stream = stream
        stream.startCapture { error in
            if let error = error {
                log("startCapture failed: \(error.localizedDescription)")
                exit(5)
            }
            self.started = true
            log("capturing system audio -> 16000 Hz mono Int16LE on stdout")
        }
    }

    // MARK: Stop

    /// Stops the stream synchronously (bounded wait) and reports a summary.
    func shutdown(code: Int32) -> Never {
        log("stopping capture")
        let semaphore = DispatchSemaphore(value: 0)
        if let stream = stream {
            stream.stopCapture { error in
                if let error = error {
                    log("stopCapture reported: \(error.localizedDescription)")
                }
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 2.0)
        }
        log("stopped (frames=\(totalFrames) bytes=\(totalBytes))")
        exit(code)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped with error: \(error.localizedDescription)")
        // Non-zero exit so the parent process can restart the helper.
        exit(7)
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return } // discard video
        handleAudio(sampleBuffer)
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else { return }

        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description)
        else {
            log("audio sample buffer had no format description")
            return
        }

        var asbd = asbdPointer.pointee
        guard let inputFormat = makeInputFormat(&asbd) else {
            log("unsupported audio format delivered by the system")
            return
        }

        guard let inputBuffer = AVAudioPCMBuffer(
            pcmFormat: inputFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else { return }
        inputBuffer.frameLength = AVAudioFrameCount(frameCount)

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: inputBuffer.mutableAudioBufferList
        )
        guard status == noErr else {
            log("could not copy PCM data out of the sample buffer (OSStatus \(status))")
            return
        }

        emit(samples: samples16(from: inputBuffer))
    }

    private func makeInputFormat(_ asbd: inout AudioStreamBasicDescription) -> AVAudioFormat? {
        if let format = AVAudioFormat(streamDescription: &asbd) {
            return format
        }
        // Fallback: the system always delivers Float32 for system audio.
        return AVAudioFormat(
            standardFormatWithSampleRate: asbd.mSampleRate > 0 ? asbd.mSampleRate : targetSampleRate,
            channels: AVAudioChannelCount(max(1, asbd.mChannelsPerFrame))
        )
    }

    // MARK: Format conversion

    private func samples16(from buffer: AVAudioPCMBuffer) -> [Int16] {
        let format = buffer.format

        // Already what we want (1 channel => layout is irrelevant here).
        if format.commonFormat == .pcmFormatInt16,
           format.sampleRate == targetSampleRate,
           format.channelCount == targetChannelCount,
           let channel = buffer.int16ChannelData?[0] {
            return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        }

        return resample(buffer)
    }

    private func resample(_ input: AVAudioPCMBuffer) -> [Int16] {
        if converter == nil || converterInputFormat != input.format {
            guard let created = AVAudioConverter(from: input.format, to: outputFormat) else {
                log("cannot build AVAudioConverter for \(input.format)")
                return []
            }
            created.sampleRateConverterQuality = AVAudioQuality.medium.rawValue
            converter = created
            converterInputFormat = input.format
            if !announcedConversion {
                announcedConversion = true
                log(
                    "converting \(input.format.sampleRate) Hz / \(input.format.channelCount) ch / "
                        + "\(input.format.commonFormat == .pcmFormatFloat32 ? "Float32" : "other") "
                        + "-> 16000 Hz mono Int16"
                )
            }
        }
        guard let converter = converter else { return [] }

        let ratio = targetSampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 2048
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: max(capacity, 1)
        ) else { return [] }

        var collected: [Int16] = []
        collected.reserveCapacity(Int(capacity))

        var consumedInput = false
        for _ in 0..<8 {
            outputBuffer.frameLength = 0
            var conversionError: NSError?
            let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
                if consumedInput {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                consumedInput = true
                outStatus.pointee = .haveData
                return input
            }

            if let conversionError = conversionError {
                log("audio conversion failed: \(conversionError.localizedDescription)")
                break
            }

            if outputBuffer.frameLength > 0, let channel = outputBuffer.int16ChannelData?[0] {
                collected.append(
                    contentsOf: UnsafeBufferPointer(start: channel, count: Int(outputBuffer.frameLength))
                )
            }

            if status != .haveData { break }
        }

        return collected
    }

    // MARK: stdout emission

    private func emit(samples: [Int16]) {
        guard !samples.isEmpty else { return }

        var offset = 0
        while offset < samples.count {
            let count = min(samples.count - offset, maxSamplesPerFrame)
            guard count > 0 else { break }

            let byteLength = UInt32(count * 2) // always even, < 1 MiB
            let headerWritten = withUnsafeBytes(of: byteLength.littleEndian) { raw -> Bool in
                guard let base = raw.baseAddress else { return false }
                return writeAll(base, raw.count)
            }
            guard headerWritten else {
                log("stdout closed while writing frame header")
                exit(6)
            }

            let payloadWritten = samples.withUnsafeBufferPointer { buffer -> Bool in
                guard let base = buffer.baseAddress else { return false }
                return writeAll(UnsafeRawPointer(base + offset), count * 2)
            }
            guard payloadWritten else {
                log("stdout closed while writing audio frame")
                exit(6)
            }

            offset += count
            totalFrames += count
            totalBytes += count * 2 + 4
        }
    }
}

// MARK: - Permission preflight

func requireScreenRecordingPermission() {
    if CGPreflightScreenCaptureAccess() { return }

    log("screen recording permission is not granted; requesting it")
    _ = CGRequestScreenCaptureAccess()
    Thread.sleep(forTimeInterval: 1.0)

    if CGPreflightScreenCaptureAccess() {
        return
    }

    log(
        "error: screen recording permission denied - grant it in System Settings > "
            + "Privacy & Security > Screen & System Audio Recording, then relaunch CloudyAudio"
    )
    exit(2)
}

// MARK: - main

/// Everything lives here rather than at top level so the pipeline is a plain
/// local instead of a main-actor global read from the signal queue.
func runHelper() {
    // Never let a closed stdout pipe kill us silently.
    signal(SIGPIPE, SIG_IGN)

    requireScreenRecordingPermission()

    let pipeline = AudioPipeline()

    let signalQueue = DispatchQueue(label: "cloudy.audio.signals")
    var signalSources: [DispatchSourceSignal] = []
    for signum in [SIGTERM, SIGINT] {
        signal(signum, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signum, queue: signalQueue)
        source.setEventHandler {
            log("received signal \(signum)")
            pipeline.shutdown(code: 0)
        }
        source.resume()
        signalSources.append(source)
    }

    log("starting up")
    pipeline.start()

    // Keep the process alive; ScreenCaptureKit drives its own queues.
    RunLoop.main.run()
    withExtendedLifetime(signalSources) {}
}

runHelper()
