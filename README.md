# TanayAI — local-first AI copilot

An always-on-top answer panel that stays out of screen shares, driven by
**on-device speech-to-text** and your choice of **DeepSeek**, **opencode**, or
**commandcode** for answers.

Built by reverse-engineering how Clause AI (Electron, `ClauseAi.app` 1.0.19)
does its overlay + audio pipeline, then replacing every cloud dependency with
local or bring-your-own-key equivalents.

## What changed vs. the original

| | Clause AI 1.0.19 | TanayAI |
|---|---|---|
| Speech to text | Deepgram streaming (cloud, server-issued key) | **TanayVoice** — whisper.cpp + Metal, fully on-device |
| Answers | Google Gemini 3.x (cloud, server-issued key) | **DeepSeek API** (your key), or `opencode` / `commandcode` CLI |
| Accounts | Supabase auth, subscriptions, vouchers | none |
| Telemetry | `clauseai.in/api` analytics + diagnostics | none |
| Overlay | `setContentProtection` + screen-saver level | same technique |
| Audio | system loopback + mic | mic (see below) |

## Requirements

- macOS on Apple Silicon
- Node.js 20+
- `brew install whisper-cpp`
- A DeepSeek API key, or an `opencode` / `commandcode` install

## Install

```bash
npm install
cp .env.example .env          # OPENCODE_API_KEY=oc_sk_...
npm run get-model             # ggml-base.en.bin (~142 MB)
npm start
```

Grant microphone access when macOS asks. The panel appears top-centre; the
menu-bar ring icon controls listening.

**Already installed on this Mac:** `/Applications/TanayAI.app`
Launch it from Finder or Spotlight. It is ad-hoc signed (not notarized), so the
first launch may need right-click → Open. Mic permission is requested once.

To rebuild after changing code:

```bash
npm run dist -- --dir                 # dist/mac-arm64/TanayAI.app
codesign --force --deep --sign - dist/mac-arm64/TanayAI.app
ditto dist/mac-arm64/TanayAI.app /Applications/TanayAI.app
```

## Settings

Click the **⚙** button in the panel header, or *Settings…* in the menu-bar menu.
Changes apply immediately — no restart.

- **Shortcuts** — click a binding, press the new combination, Save. Escape cancels.
  At least one modifier is required so a plain letter can't hijack normal typing.
  If a combination is already owned by another app, it is reported by name
  instead of silently failing.
- **Provider / model** — switches the answer backend live.
- **Auto-answer** — same toggle as the menu-bar checkbox.

Shortcuts can also be edited by hand in `config.json`; the file is watched, so
saving it re-registers everything on the spot (`[hotkeys]` lines in the app log
show what registered). `cmd+j`, `⌘J` and `CommandOrControl+J` all mean the same
thing.

```jsonc
"hotkeys": {
  "answer": "CommandOrControl+J",              // answer the last question
  "answerLastUtterance": "CommandOrControl+Shift+Enter",
  "toggleOverlay": "CommandOrControl+Shift+A",
  "toggleListening": "CommandOrControl+Shift+L",
  "clear": "CommandOrControl+Shift+R"
}
```

## Hotkeys

| Keys | Action |
|---|---|
| `⌘J` | **answer the last question now** (the main trigger) |
| `⌘⇧A` | show / hide the overlay |
| `⌘⇧L` | start / stop listening |
| `⌘⇧R` | clear the transcript |
| `⌘⇧↵` | answer the last thing said, no question check |

## Manual vs auto

By default TanayAI **listens continuously but answers only when you press ⌘J**.
That is deliberate: one microphone hears both sides of the call, so auto-answering
ends up responding to your own voice. Pressing ⌘J hands it the most recent thing
that was actually a question:

- it prefers the caption still being spoken, so you can answer mid-question;
- otherwise it walks back through the last 8 utterances and takes the newest one
  that scores as a question;
- if nothing scored, it answers the last thing said rather than doing nothing.

Pressing ⌘J twice, or while an answer is already streaming, does not restart the
request — it would throw away tokens already on screen.

Turn on *Auto-answer questions* in the menu-bar menu (or set `"autoAnswer": true`)
if you want the speculative behaviour instead.

## How the pipeline works

```
mic ──getUserMedia──► AudioWorklet (resample → 16 kHz Int16, 100 ms chunks)
        │
        ▼
   TanayVoice ── energy VAD ──► utterance ──► whisper-cli (Metal) ──► text
        │                                    └── live caption (tail 5 s)
        ▼
  question heuristic ──► DeepSeek / opencode / commandcode ──► streaming answer ──► overlay
```

- `silenceMs` (380 ms) closes an utterance; `maxSegmentMs` (8 s) forces a cut on
  continuous speech.
- The question heuristic only auto-answers interrogative utterances. Anything
  else is answered with `⌘⇧↵` — this avoids the model replying to your own
  answers.
- Starting a new request cancels the previous one. A stale answer mid-call is
  worse than none.

## Configuration

`~/Library/Application Support/TanayAI/config.json`

```jsonc
{
  "provider": "deepseek",            // deepseek | opencode | commandcode
  "deepseek": { "apiKey": "", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
  "opencode":  { "bin": "opencode",  "model": "deepseek/deepseek-chat", "timeoutMs": 90000 },
  "commandcode": { "bin": "commandcode", "args": ["-p", "{prompt}"], "timeoutMs": 90000 },
  "tanayvoice": { "bin": "whisper-cli", "modelPath": "", "threads": 4, "language": "en",
                  "silenceMs": 380, "minSpeechMs": 600, "maxSegmentMs": 8000,
                  "partialEveryMs": 1200, "partialTailMs": 5000 },
  "overlay": { "width": 640, "height": 430, "opacity": 0.96 },
  "profile": "interview",            // interview | sales | generic
  "resumePath": ""                   // absolute path to a .txt/.md resume, optional
}
```

The API key is read from `DEEPSEEK_API_KEY` when present, so it never has to be
written to disk.

### Why DeepSeek is the default

A direct HTTPS call answers in ~0.5-1.5 s. The CLI backends spawn a fresh
process per answer (~2-5 s), which is too slow for live use but useful when you
want the agent's full tool access. `opencode` is called as
`opencode run --format json --model <model> <prompt>`; `commandcode` uses the
argv template in config, so any CLI that takes a prompt as one argument works.

## Verify it

```bash
npm run smoke        # boots both windows, reports state, exits
npm test             # LLM layer: SSE streaming, abort, error paths
npm run test:stt -- /path/to/16k-mono.wav   # real VAD + whisper pass
```

Generate a test clip on macOS:

```bash
say -o /tmp/q.aiff "How would you find the first non-repeating character?"
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/q.aiff /tmp/q.wav
npm run test:stt -- /tmp/q.wav
```

Measured on this M1 / 8 GB: 3.4 s of speech → final transcript 1.3 s after the
utterance closed (including the 380 ms silence window).

### If `npm install` leaves Electron broken

npm 11 blocks postinstall scripts by default, so `node_modules/electron/dist`
stays empty. Either approve it:

```bash
npm install-scripts approve electron && node node_modules/electron/install.js
```

or download `electron-v33.4.11-darwin-arm64.zip` from the Electron releases page,
unzip it into `node_modules/electron/dist`, and write
`Electron.app/Contents/MacOS/Electron` (no trailing newline) into
`node_modules/electron/path.txt`.

## Choosing a provider

Four backends, switchable from the menu-bar menu at runtime:

| Provider | Path | Typical latency |
|---|---|---|
| `opencode-go` | direct HTTPS to `opencode.ai/zen/go/v1` | **~1.4-2.5 s** to first token |
| `deepseek` | direct HTTPS to `api.deepseek.com` | ~1-2 s |
| `opencode` | shells out to `opencode run` | 3-5 s |
| `commandcode` | shells out to a configurable CLI | 3-5 s |

`opencode-go` and `deepseek` stream token by token, so text appears as it is
generated. The two CLI backends buffer the entire answer before returning, which
is why they are not the default.

Which model to use is a measured question, not a taste question:

```bash
OC_KEY=<your key> node test/opencodego.bench.js          # all opencode-go models
OC_KEY=<your key> node test/opencodego.bench.js --list   # just list them
MAX_TOKENS=900 OC_KEY=<your key> node test/opencodego.bench.js <model>  # reasoning models
```

It ranks models by time-to-first-token but only counts ones that actually
returned visible text — a model that streams nothing cannot answer a live
question no matter how fast it fails. Set the winner in `opencodeGo.model`.

## Measured performance

M1, 8 GB, measured rather than estimated. Two paths, because they are different
experiences:

| Stage | Manual (⌘J, default) | Auto-answer |
|---|---|---|
| pause that closes an utterance | 700 ms | 260 ms |
| whisper decode (base.en, ~5 s utterance) | ~1.0 s | ~1.0 s |
| caption → first answer token | 1.4-3.0 s | 1.4-3.0 s |
| speech end → first token | sum of the above | **~0.5 s** (speculative) |

Manual mode is deliberately a little slower at closing an utterance: a 260 ms
pause is not a sentence boundary, and cutting there was splitting questions into
fragments, which is what made transcription look wrong. You read the transcript
and then press ⌘J, so that 440 ms is not in your reaction path.

Auto-answer keeps the fast path and starts answering from the live caption; it
is off by default because one microphone hears both sides of the call.

### Why `deepseek-v4.1-flash` is the default

`test/opencodego.bench.js` ranked all 30 models on the Go plan by time to first
token, counting only models that returned real text:

```
1371ms  deepseek-v4.1-flash     <- default
1474ms  gpt-5.6-luna
1534ms  gpt-6-luna
1751ms  claude-haiku-5-5
1797ms  grok-4.7
...
6265ms  muse-spark-1.3-contributor   (works, but too slow for live use)
```

Nine models stream nothing at all (`glm-5.2`, `glm-5.3`, `hy4-preview`,
`longcat-2.0`, `muse-spark-1.2/1.3-contributor`, `iceman-contributor-free`) or
are deprecated (`mimo-v2.5`, `mimo-v2.5-pro`). Some only produce text with a
larger `max_tokens`, because they spend the budget on internal reasoning —
`MAX_TOKENS=900` re-tests them.

## How questions are detected

A copilot hears both sides of the call. A naive "contains what/how/why" check
fires on the candidate's own answers, which is worse than staying silent. Each
utterance is scored (`src/main/detection.js`):

| Signal | Weight |
|---|---|
| ends with `?` | +3 |
| interrogative opener (*what, how, can you, tell me…*) | +2 |
| ask-to-explain (*describe, design, implement, walk me through…*) | +2 |
| 8+ words | +1 |
| first-person narrative (*I worked, my team, in my role…*) | −3 |
| candidate phrasing (*"what I did was…"*, *"how we solved it…"*) | −3 |
| fewer than 4 words | −2 |

`>= 2` answers, `>= 3` answers immediately. Speculative answering additionally
requires a real `?` and 5+ words — an early version answered
*"Can you explain the difference between"*, which is a fragment, not a question.
`test/detection.test.js` holds 22 interviewer/candidate phrasings, all passing.

## Accuracy notes

- **Segmentation was the real accuracy bug.** A 260 ms pause used to end an
  utterance, so a sentence with a breath in the middle became two fragments,
  each decoded without the other's context. The window is now 700 ms and the
  maximum segment 15 s, so long interviewer questions stay whole.
- Finals run `ggml-base.en`; `ggml-small.en` is selectable in Settings for a
  slower, more accurate pass.
- A domain prompt biases decoding toward interview vocabulary (Kubernetes,
  throughput, hash map, complexity…), which fixes the usual "threat" for
  "thread" class of error.
- `-sns` suppresses non-speech tokens so `[music]` and `(applause)` stop
  appearing in answers.
- 200 ms of audio before speech onset is kept, so a question never loses its
  first syllable to a late VAD trigger.

## The transcript

The panel shows **everything that was heard**, not a trimmed line:

- finished utterances are appended to a scrollable transcript that auto-scrolls
  to the newest line, so the full paragraph the interviewer said stays readable;
- the in-progress caption sits beneath it in italics and is replaced by the
  final text when the utterance closes;
- ⌘⇧R clears both.

## How a long question is picked

Pressing ⌘J answers the **latest question, however long it is** — not just the
newest fragment:

- it finds the most recent utterance that scores as a question;
- it walks backwards and merges contiguous fragments of the same question
  (a piece cut off without terminal punctuation, or carrying question signal),
  stopping at the candidate's own narration or an unrelated finished sentence;
- if the interviewer is still talking, the live caption is appended;
- merged text is capped at 2000 characters.

Verified with a question split across three utterances:

```
3 fragments -> "Can you walk me through how you would design a rate limiter for
a public API with ten thousand requests per second, and what tradeoffs would you
consider between token bucket and sliding window?"   (34 words, opener dropped)
```

## Tail latency, and why hedging is off

Measured time-to-first-token on this endpoint swings between **1.4 s and 9 s**
within the same hour; the plan was not throttled (1% rolling, 46% monthly usage
at the time). That variance is the provider's queue, not this app.

`config.hedge` races a second model when the first is slow:

```jsonc
"hedge": { "enabled": true, "delayMs": 700, "model": "claude-haiku-5-5" }
```

Measured on a bad night it made no difference — both models were slow at once —
while doubling request spend. It stays **off** by default. Turn it on if you
usually see one model queueing behind another.

## Microphone problems

`AbortError: The user aborted a request` looks like a permission failure but is
not. Two separate bugs produced it:

1. **The start command was silently dropped.** The main process sent `start` to
   the hidden capture window and queued it behind `did-finish-load` when
   `isLoading()` said the page was still loading. The page had already loaded, so
   that event never fired again and the command was lost forever. The renderer
   now sends an explicit `tanay:capture-ready` handshake and main queues until it
   arrives.
2. **CSP blocked the AudioWorklet.** The worklet was created from a `blob:` URL
   while the renderer's CSP pins `script-src 'self'`; Chromium refused it and
   surfaced the refusal as `AbortError`. The worklet is now a real file
   (`pcm-worklet.js`) loaded from the same origin.

`electron . --capture-test` drives the real path (IPC → capture.js → worklet) and
reports exactly where it stops:

```
[capture] stream acquired: MacBook Air Microphone live
[capture] worklet ready @ 48000 Hz
[capture] capture live
{"listening":true,"audioChunks":36}
```

Permission handling still exists for the genuine case: the app checks the OS grant
before calling `getUserMedia`, shows an **Open microphone settings** button when
it is denied, and resumes within two minutes of the switch being flipped. The app
is ad-hoc signed, so macOS asks again after every rebuild.

## Known gaps

- **System audio on macOS.** Electron's `audio: 'loopback'` in
  `setDisplayMediaRequestHandler` is Windows-only; the original app has the same
  limitation on Mac. TanayAI records the microphone, which hears the call
  through your speakers/headphones. For clean remote audio install
  [BlackHole](https://existential.audio/blackhole/) and set it as the input, or
  add a ScreenCaptureKit helper later.
- Screenshot/vision answering is not wired up (DeepSeek's chat API is
  text-only). Use the `opencode` provider for that.
- whisper.cpp base.en is a latency/accuracy compromise on 8 GB M1. Try
  `ggml-small.en.bin` if you have headroom, or `ggml-tiny.en.bin` if not.

## Files

```
src/main/index.js            app lifecycle, IPC, answer flow
src/main/windows.js          overlay + capture windows, tray
src/main/stt/TanayVoice.js   VAD + whisper.cpp streaming
src/main/llm/*               DeepSeek SSE + CLI backends
src/main/prompts.js          prompt profiles
src/renderer/overlay/*       the panel
src/renderer/capture/*       microphone + AudioWorklet
```

## Legal note

Clause AI is GPL-3.0. TanayAI is an independent implementation: the shipped
bundle was inspected to learn the overlay/audio/UX approach, and no source text
or prompt wording was copied. The prompt profiles here were written fresh.
