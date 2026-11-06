# CloudyAI — local-first AI copilot

An always-on-top answer panel that stays out of screen shares, driven by
**on-device speech-to-text** and your choice of **DeepSeek**, **opencode**, or
**commandcode** for answers.

Built by reverse-engineering how Clause AI (Electron, `ClauseAi.app` 1.0.19)
does its overlay + audio pipeline, then replacing every cloud dependency with
local or bring-your-own-key equivalents.

## What changed vs. the original

| | Clause AI 1.0.19 | CloudyAI |
|---|---|---|
| Speech to text | Deepgram streaming (cloud, server-issued key) | **CloudyVoice** — Parakeet 0.6B on the Neural Engine (whisper.cpp fallback), fully on-device |
| Answers | Google Gemini 3.x (cloud, server-issued key) | **DeepSeek / Command Code API** (your key), or `opencode` / `commandcode` CLI |
| Accounts | Supabase auth, subscriptions, vouchers | none |
| Telemetry | `clauseai.in/api` analytics + diagnostics | none |
| Overlay | `setContentProtection` + screen-saver level | same technique |
| Questions | speech only | speech, typed text, or a **screenshot** of the screen |
| Audio | system loopback + mic | **system audio only** (ScreenCaptureKit), mic optional and off |

## Requirements

- macOS on Apple Silicon
- Node.js 20+
- Swift 6.2+ (Command Line Tools are enough) for the two helpers:
  `npm run build:ear` and `npm run build:audio`
- Optional fallback: `brew install whisper-cpp` + `npm run get-model`
- A DeepSeek or Command Code API key, or an `opencode` / `commandcode` install

## Install

```bash
npm install
cp .env.example .env          # OPENCODE_API_KEY=oc_sk_...
npm run get-model             # ggml-base.en.bin (~142 MB)
npm start
```

Grant **Screen & System Audio Recording** access to CloudyAI when macOS asks
(System Settings → Privacy & Security → Screen & System Audio Recording). The
system-audio helper fails closed if it is denied; it never falls back to the
microphone. macOS may ask for a relaunch after the grant.

**Already installed on this Mac:** `/Applications/CloudyAI.app`
Launch it from Finder or Spotlight. It is ad-hoc signed (not notarized), so the
first launch may need right-click → Open. Mic permission is requested once.

To rebuild after changing code:

```bash
npm run dist -- --dir                 # dist/mac-arm64/CloudyAI.app
ditto dist/mac-arm64/CloudyAI.app /Applications/CloudyAI.app
```

Packaging signs the bundle itself. `scripts/after-pack.js` runs
`scripts/sign-app.sh` after pack: it signs the Electron frameworks, then the two
Swift helpers (`cloudy-audio`, `cloudy-ear`), then the bundle as one identity
with `com.cloudy.ai`. Set `SIGN_IDENTITY` (or install a Developer ID
Application certificate in the keychain) to sign for real; with no certificate
it falls back to ad-hoc, which still produces a valid, sealed bundle.

That single identity matters for TCC. If the helpers stay unsigned, macOS
records their screen-capture request against the raw executable path and System
Settings shows a second, generic-icon **CloudyAI** row in Screen & System Audio
Recording. After a rebuild the old row can be deleted with the **−** button.

## Settings

Click the **⚙** button in the panel header, or *Settings…* in the menu-bar menu.
Changes apply immediately — no restart.

- **Shortcuts** — click a binding, press the new combination, Save. Escape cancels.
  At least one modifier is required so a plain letter can't hijack normal typing.
  If a combination is already owned by another app, it is reported by name
  instead of silently failing.
- **Screenshot model** — the model that reads screenshots. Screenshot turns are
  routed here instead of the text model, because a text-only model still answers
  politely when handed an image, inventing what is on screen. *Auto* uses the
  provider's vision model (`google/gemini-3.8-flash` on commandcode API,
  `gemini-4-argon` on opencode-go). `deepseek` and the CLI providers have no
  vision endpoint and say so instead of guessing.
- **Code answers** — every coding problem is answered in **C++17**, one complete
  `class Solution` in a fenced ```` ```cpp ```` block with the headers it needs, at
  most three bullets before it. Other languages only if you type that request.
  The overlay colours the block (keywords, types, functions, strings, numbers,
  comments) and labels it **C++**.
- **Engine / audio source** — Parakeet on the Neural Engine (default) or
  whisper.cpp; system audio (default) or the microphone. Switching restarts the
  recogniser live.
- **Provider / model** — switches the answer backend live.

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

## Manual-only answering

CloudyAI **listens to the call and answers only when you press ⌘J**. There is no
auto-answer mode: nothing is ever sent to a model without a keypress. Only
system audio is captured, so your own voice is not in the transcript.

Pressing ⌘J uses the newest utterance:

- if a question is still open or its decode is running, the live/pending text is
  used, so you can answer mid-question;
- otherwise the newest utterance from the last 20 seconds is answered, even if
  the question heuristic scores it low — it never walks back to an older
  question while a newer one exists;
- if the newest line was nothing but filler ("right, so, um"), the newest real
  line before it is answered instead;
- if nothing was heard in that window, it says so instead of answering stale
  text.

Every answer gets the **whole session transcript**, not just the last few
lines, capped at 12,000 characters and keeping the newest. That is what lets a
follow-up like "and what tradeoffs?" resolve against the question before it.

Pressing ⌘J twice, or while an answer is already streaming, does not restart the
request — it would throw away tokens already on screen.

## How the pipeline works

```
system audio ── ScreenCaptureKit helper (16 kHz mono) ──► CloudyVoice ── energy VAD ──► utterance ──► CloudyEar (Parakeet, ANE) ──► text
        │                                                                                          └── whisper-cli fallback
        │                                                                                          └── live caption (tail 4.5 s)
        ▼
  question heuristic ──► DeepSeek / opencode / commandcode ──► streaming answer ──► overlay```

- Only the **system output** is captured. Your microphone is off by default, so
  your own voice is never transcribed and the other participant is captured
  digitally instead of through the speakers.
- `silenceMs` (500 ms) closes an utterance; `maxSegmentMs` (15 s) forces a cut on
  continuous speech. The endpointing is deliberately shorter than the old
  700 ms: system audio is clean, and the final decode is ~140 ms.
- The question heuristic is advisory only: it decides whether the footer calls
  a line a question, never whether ⌘J spends a request.
- Starting a new request cancels the previous one. A stale answer mid-call is
  worse than none.

## Speech engine

Two local engines, switchable in Settings → Transcription:

| | Parakeet TDT 0.6B v2 (default) | whisper.cpp |
|---|---|---|
| Runtime | FluidAudio + CoreML on the Neural Engine | whisper.cpp on Metal |
| Model load | once at startup, stays in memory | ~0.33 s on every utterance |
| Decode a 3.4 s question | ~0.11 s | ~0.52 s |
| Disk | 452 MB, downloaded on first use | 141 MB (base.en) |
| Punctuation + capitals | yes | no |

Parakeet TDT v2 is the English-only checkpoint: NVIDIA's highest-recall 0.6B
model. It is the same model candyAI (the `handy` app) runs, but in CoreML rather
than GGUF, because FluidAudio only reads CoreML.

`npm run build:ear` compiles the helper (`native/CloudyEar`, a Swift package).
The first launch downloads the CoreML model to
`~/Library/Application Support/FluidAudio/Models`; the panel shows “loading
speech model…” while that happens. After that the model stays warm and each
utterance is one line over stdin to a long-lived process.

If the helper is missing, CloudyAI falls back to whisper.cpp and says so instead
of going silent. Force the fallback any time in Settings → Transcription →
Engine.

Measured on this M1 / 8 GB: a 3.4 s question decodes in ~110 ms with Parakeet TDT
v2 warm, against ~520 ms for whisper.cpp base.en, which also reloads its model on
every utterance.

## Configuration

`~/Library/Application Support/CloudyAI/config.json`

```jsonc
{
  "provider": "deepseek",            // opencode-go | commandcode-api | deepseek | opencode | commandcode
  "commandCodeApi": { "apiKey": "", "baseUrl": "https://api.commandcode.ai/provider/v1", "model": "deepseek/deepseek-v4-flash" },
  "deepseek": { "apiKey": "", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
  "opencode":  { "bin": "opencode",  "model": "deepseek/deepseek-chat", "timeoutMs": 90000 },
  "commandcode": { "bin": "commandcode", "args": ["-p", "{prompt}"], "timeoutMs": 90000 },
  "cloudyvoice": { "engine": "parakeet", "source": "system",
                  "bin": "whisper-cli", "modelPath": "", "threads": 4, "language": "en",
                  "silenceMs": 500, "minSpeechMs": 250, "maxSegmentMs": 15000,
                  "partialEveryMs": 900, "partialTailMs": 4500 },
  "overlay": { "width": 720, "height": 620, "opacity": 0.96 },
  "profile": "interview",            // interview | sales | generic
  "resumePath": ""                   // absolute path to a .txt/.md resume, optional
}
```

The API key is read from `OPENCODE_API_KEY`, `COMMANDCODE_API_KEY`, or
`DEEPSEEK_API_KEY` when present, so it never has to be written to disk.

### Why DeepSeek is the default

A direct HTTPS call answers in ~0.5-1.5 s. The CLI backends spawn a fresh
process per answer (~2-5 s), which is too slow for live use but useful when you
want the agent's full tool access. `opencode` is called as
`opencode run --format json --model <model> <prompt>`; `commandcode` uses the
argv template in config, so any CLI that takes a prompt as one argument works.

## Verify it

```bash
npm run smoke        # boots both windows, reports state, exits
npm test             # LLM, detection, picker, VAD lifecycle, tray
npx electron . --composer-test   # typed box, Enter-to-send, screenshot queue + Send
npx electron . --settings-test   # session-context controls and CV/JD bridge
npx electron . --shot-test       # capture the screen, save the image, answer from it
npm run build:ear    # compile the Parakeet helper (Swift package)
npm run build:audio  # compile the system-audio helper (ScreenCaptureKit)
npx electron . --sysaudio-test   # capture system audio, report frames + RMS
npx electron . --listen-test     # system audio -> VAD -> Parakeet -> transcript
CLOUDY_ENGINE=parakeet node test/cloudyvoice.test.js /tmp/q.wav   # real VAD + Parakeet
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
| `commandcode-api` | direct HTTPS to `api.commandcode.ai/provider/v1` | ~1-2 s |
| `deepseek` | direct HTTPS to `api.deepseek.com` | ~1-2 s |
| `opencode` | shells out to `opencode run` | 3-5 s |
| `commandcode` | shells out to a configurable CLI | 3-5 s |

`opencode-go`, `commandcode-api`, and `deepseek` stream token by token, so text
appears as it is generated. The two CLI backends buffer the entire answer before
returning, which is why they are not the default.

`commandcode-api` uses your own Command Code Provider API key (create one at
https://commandcode.ai/settings/keys) — it never reads the `commandcode` CLI's
stored login. The model picker lists the live catalogue from
`/provider/v1/models`, limited to models that answer on the OpenAI-compatible
`/chat/completions` route.

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

M1, 8 GB, measured rather than estimated, with the system-audio path:

| Stage | Time |
|---|---|
| pause that closes an utterance | 500 ms |
| Parakeet decode (~6 s question, measured) | **143 ms** |
| speech end → transcript in the panel (measured) | **643 ms** |
| transcript → first answer token | 1.4–3.0 s (provider) |

Before this pass the same pipeline used a 700 ms pause, a 100 ms chunk
quantiser, an 8 s caption tail and a caption decode that could sit in front of
the final. That put stop→final around 1.0–1.1 s.

Endpointing is configurable (`cloudyvoice.silenceMs`). 500 ms is the balance
used here: shorter starts splitting questions at natural breaths.

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

A copilot hears statements as well as questions, and answering every remark is
worse than staying silent. Each utterance is scored (`src/main/detection.js`):

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

## Typed questions and screenshots

The panel is not only a listener:

- **Type in the box at the bottom** and press `⏎` (`⇧⏎` for a new line). The
  text goes to the model exactly as written, with no waiting for speech and no
  question detection.
- **`📷` captures the screen under the pointer** and queues it as a thumbnail
  preview above the composer. Capture as many as you need (up to 5); click a
  thumbnail for a full-size look, `×` to drop one. Nothing is sent until you
  press `↵` / Send — the batch goes out with whatever text is in the box.
  If the box is empty, CloudyAI reads the screenshots and answers the most
  useful thing in them.
- The answer starts with **On screen:** (one line saying what is visible), then
  works from the image. If the screen has no explicit question, it describes
  what is there and gives the next useful step instead of saying “no question
  detected”.
- The overlay sets content protection, so the panel itself is never in the
  screenshot — what the model sees is the window behind it. Verified with
  `electron . --shot-test`, which saves the exact image sent.
- Screenshots need a vision model. `opencode-go` models read images; DeepSeek's
  chat API is text-only.
- On the first capture macOS asks for **Screen Recording**. If it was denied,
  the panel says exactly which switch to flip rather than failing silently.

## Session context

Settings → **Session context** feeds the model what it needs to answer as *you*
for one session:

- **Custom instructions** — a free-form system prompt for the session. It is
  appended to the built-in rules inside `<session_instructions>` and takes
  priority where the two conflict. Example: *“I am interviewing for a Staff
  Backend Engineer role. Answer as me, in the first person, with at most three
  bullets, and prefer Go and Postgres examples.”*
- **CV** — upload a PDF, `.txt` or `.md`. The text is extracted once, cached,
  and sent with every question so answers use your real projects, employers and
  numbers. Uploads are copied into `<userData>/context`, so deleting the
  original from Downloads does not empty the context.
- **Job description** — upload a PDF/text file or paste the posting. Answers are
  angled toward that role's wording, stack and priorities, without inventing
  experience you do not have.

Both documents are capped (20k characters) and sent as `<job_description>` and
`<resume>` blocks ahead of the transcript. Scanned PDFs with no selectable text
are rejected with a message asking you to paste the text instead.

Answers are always written **in the first person** — the reply is read out loud
by the candidate ("I built…", "I'd start with…"), never as an assistant
describing them. The default interview prompt also enforces a headline sentence,
2-4 bullets and at most one concrete example, so answers stay scannable and
anchored in specifics rather than broad generalities.

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

- **System audio requires Screen & System Audio Recording permission.** If it is
  denied, capture fails closed with an instruction — it never silently falls
  back to the microphone.
- **A rebuild needs the permission granted again** (ad-hoc signing has no stable
  team identity). Delete the old CloudyAI row with **−** if a stale, generic-icon
  row is left behind, then grant the new prompt once.
- **The microphone is off by default.** Enable Settings → Audio source →
  Microphone only if you want to transcribe people in the room.
- The overlay is excluded from screenshots and live ScreenCaptureKit captures on
  macOS 27 (verified with both a one-shot SCK screenshot and a live SCStream).
  Content protection is still best-effort on older macOS versions.
- Screenshot answering needs a vision model: `opencode-go` handles images,
  DeepSeek's chat API does not.
- whisper.cpp is only the fallback now. Parakeet beats it on English accuracy and
  latency; keep whisper for machines where the helper cannot be built.

## Files

```
src/main/index.js            app lifecycle, IPC, answer flow
src/main/windows.js          overlay + capture windows, tray
src/main/pick.js             which utterance ⌘J answers (tested in isolation)
src/main/stt/CloudyVoice.js  VAD + utterance segmentation
src/main/stt/CloudyEar.js    long-lived Parakeet helper client
native/CloudyEar/            Swift package: Parakeet TDT 0.6B v2 via FluidAudio
src/main/audio/CloudyAudio.js  system-audio helper client (PCM frames)
native/CloudyAudio/          Swift package: ScreenCaptureKit system audio only
scripts/build-ear.sh         builds the Parakeet helper
scripts/build-audio.sh       builds the system-audio helper
src/main/llm/*               DeepSeek SSE + CLI backends
src/main/prompts.js          prompt profiles
src/renderer/overlay/*       the panel
src/renderer/capture/*       microphone + AudioWorklet (optional source)
```

## Legal note

Clause AI is GPL-3.0. CloudyAI is an independent implementation: the shipped
bundle was inspected to learn the overlay/audio/UX approach, and no source text
or prompt wording was copied. The prompt profiles here were written fresh.
