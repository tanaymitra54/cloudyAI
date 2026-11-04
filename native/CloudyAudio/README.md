# CloudyAudio

A tiny macOS helper that captures **system audio only** (the meeting output / the
other participants) and streams it as raw PCM to stdout, for the Electron parent
process to consume.

The microphone is never captured: `captureMicrophone` is explicitly disabled and
no microphone permission is requested.

## Build

```sh
cd native/CloudyAudio
swift build -c release
```

Binary: `native/CloudyAudio/.build/release/CloudyAudio`

No external dependencies. Swift tools 6.0, macOS 14+.

## stdout protocol (binary only)

```
repeat until the process exits:
    uint32 little-endian byteLength   // payload length in bytes
    int8[byteLength]                  // samples
```

* Payload is always **16 000 Hz, mono, signed 16-bit little-endian**.
* `byteLength` is always even and `< 1 MiB` (max 512 000 bytes / 256 000 samples).
* Read the 4-byte header, read `byteLength` bytes, emit, repeat.
* Nothing but these frames is ever written to stdout. All logs go to stderr.

## stderr

Human-readable lifecycle logs, prefixed `[CloudyAudio]`. Parse nothing from here
except for debugging.

## Signals and exit codes

| Situation | Behaviour |
| --- | --- |
| SIGTERM / SIGINT | Stream stopped, flushed, `exit(0)` |
| Screen recording permission denied | one-line error, `exit(2)` |
| Shareable content unavailable | `exit(3)` |
| Output attach failure | `exit(4)` |
| `startCapture` failure | `exit(5)` |
| stdout closed (parent died) | `exit(6)` |
| Stream stopped with an error | error logged, `exit(7)` |

Anything non-zero means the parent process should restart the helper.

## Capture configuration

* `SCStream` via ScreenCaptureKit.
* `capturesAudio = true`, `sampleRate = 16000`, `channelCount = 1`,
  `excludesCurrentProcessAudio = true`, `captureMicrophone = false`.
* Minimal video (2×2, 1 fps) only so the stream starts reliably. Video frames are
  received and discarded; video is never written to stdout.
* Audio stream output plus screen output are both attached.
* Delivered audio is Float32 16 kHz mono; it is converted to Int16LE with
  `AVAudioConverter`, which also handles any other rate/channel count the system
  happens to hand over.

## macOS permission caveat

System-audio capture requires **Screen & System Audio Recording** permission.
macOS grants it per *host application*, not per binary — so grant it to the app
that spawns this helper (the Electron app in production, or Terminal / iTerm /
the agent host when running it from a shell). Dotfiles may need a relaunch of the
host app before the permission takes effect.

The helper preflights with `CGPreflightScreenCaptureAccess()`, and calls
`CGRequestScreenCaptureAccess()` once if it is missing. If permission is still
absent it prints one line to stderr and exits `2`.

## Verification

`Tools/verify_pcm.py` parses a captured stdout file and reports frame count,
sample total, peak and RMS, plus 0.5 s windowed RMS.

```sh
./.build/release/CloudyAudio > out.bin 2> out.log &
afplay /path/to/speech.wav
kill -TERM %1
python3 Tools/verify_pcm.py out.bin 2.0   # skip the first 2 s of startup
```
