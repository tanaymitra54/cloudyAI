// CloudyEar — a long-lived local ASR helper for CloudyAI.
//
// NVIDIA Parakeet Unified EN 0.6B (CoreML, Neural Engine) via FluidAudio.
// The process loads the model once and then answers one JSON request per line:
//
//   in : {"id": 1, "path": "/tmp/utterance.wav"}
//   out: {"id": 1, "text": "Can you explain database indexes?"}
//
// Events are emitted on stdout with an `event` key ("loading", "progress",
// "ready"), errors carry `id` + `error`. Logs go to stderr only.
//
// `CloudyEar --transcribe file.wav` runs one file and exits; `--models-dir`
// overrides the default ~/Library/Application Support/FluidAudio/Models cache.

import Foundation
import FluidAudio

private let stdout = FileHandle.standardOutput
private let stderr = FileHandle.standardError

private func writeLine(_ handle: FileHandle, _ line: String) {
    guard let data = (line + "\n").data(using: .utf8) else { return }
    handle.write(data)
}

private func emit(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return }
    writeLine(stdout, text)
}

private func note(_ message: String) {
    writeLine(stderr, message)
}

private func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

@main
struct CloudyEar {
    static func main() async {
        // The line protocol owns stdout; keep library chatter off it.
        AppLogger.minimumLevel = .warning
        AppLogger.mirrorsToConsole = false

        let oneShot = argument("--transcribe")
        let modelsDir = argument("--models-dir").map { URL(fileURLWithPath: $0) }

        emit(["event": "loading"])
        let manager = UnifiedAsrManager(encoderPrecision: .int8)

        do {
            try await manager.loadModels(to: modelsDir, progressHandler: { progress in
                let percent = Int((progress.fractionCompleted * 100).rounded())
                emit(["event": "progress", "percent": percent])
            })
        } catch {
            emit(["event": "error", "error": "\(error)"])
            exit(1)
        }
        emit(["event": "ready"])

        let converter = AudioConverter()

        func transcribe(_ path: String) async throws -> (text: String, ms: Int, audioMs: Int) {
            let samples = try converter.resampleAudioFile(URL(fileURLWithPath: path))
            let started = Date()
            let text = try await manager.transcribe(samples)
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            return (text, ms, samples.count / 16)
        }

        if let oneShot {
            do {
                let result = try await transcribe(oneShot)
                emit(["text": result.text, "ms": result.ms, "audioMs": result.audioMs])
                exit(0)
            } catch {
                emit(["error": "\(error)"])
                exit(1)
            }
        }

        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard
                !trimmed.isEmpty,
                let data = trimmed.data(using: .utf8),
                let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { continue }

            let id = request["id"] as? Int ?? 0
            guard let path = request["path"] as? String else {
                emit(["id": id, "error": "missing path"])
                continue
            }

            do {
                let result = try await transcribe(path)
                emit(["id": id, "text": result.text, "ms": result.ms, "audioMs": result.audioMs])
            } catch {
                emit(["id": id, "error": "\(error)"])
            }
        }
    }
}
