# Get a Mistral API key

Mistral runs two things this plugin uses, and one key reaches both. **Mistral Voxtral** is one of the five [transcription](../transcription.md) engines: it takes a recording of up to three hours in a single request, labels the speakers, and bills about **$0.003 per audio minute**. **Mistral** is one of the four [LLM post-processing](../llm-post-processing.md) providers, which cleans up, summarizes, or translates the transcript afterwards. Both are configured on their own page under **Engines**, and both read the same base URL and the same **Mistral API key**, so you enter it once. This guide takes you from a blank settings tab to a working transcript.

- [Why Voxtral](#why-voxtral)
- [Step 1: Create the API key in the Mistral console](#step-1-create-the-api-key-in-the-mistral-console)
- [Step 2: Configure Voxtral for transcription](#step-2-configure-voxtral-for-transcription)
- [How Voxtral handles your audio](#how-voxtral-handles-your-audio)
- [Reuse the same key for LLM post-processing](#reuse-the-same-key-for-llm-post-processing)
- [Verify it works](#verify-it-works)
- [Troubleshooting](#troubleshooting)
- [Related guides](#related-guides)

## Why Voxtral

Voxtral is the engine to reach for when a long recording has several speakers in it:

- **Three hours in one request.** The whole meeting is transcribed in one piece, so speaker numbering stays consistent from the first minute to the last. Files are sent whole up to **1 GB**, which is a separate ceiling from the three hours and is reached first only by an uncompressed recording.
- **Speaker diarization.** Turn on **Speaker diarization** to get per-speaker labels, which you can then rename like any other engine's.
- **Cheap per minute.** About **$0.003 per audio minute**, which undercuts Deepgram and OpenAI-hosted Whisper for a whole-file diarizing run.
- **Term biasing.** A [custom dictionary](../transcription.md#biasing-recognition-toward-your-own-terms) is sent as `context_bias`, up to 100 terms per request, which helps the model spell names, jargon, and acronyms the way you do.
- **One key, two features.** The same key transcribes audio **and** drives Mistral-based [LLM post-processing](../llm-post-processing.md).

| Property                | Value                                                               |
| ----------------------- | ------------------------------------------------------------------- |
| Engine name in settings | **Mistral Voxtral**                                                 |
| Default base URL        | `https://api.mistral.ai/v1`                                         |
| Default model           | `voxtral-mini-latest`                                               |
| Max file size           | 1 GB per request (uploaded whole)                                   |
| Diarization             | Supported (off by default)                                          |
| Language hint           | Not sent, because the engine detects the spoken language itself     |
| Word-level timestamps   | Not available, so the JSON output carries segment times             |
| Cost                    | About $0.003 per audio minute                                       |
| Reused for              | Mistral [LLM post-processing](../llm-post-processing.md) (same key) |

---

## Step 1: Create the API key in the Mistral console

1. Open **[console.mistral.ai](https://console.mistral.ai)** in your browser and sign in.
2. Select **API Keys** in the left sidebar.
3. Click **Create new key**.
4. Give it a name (for example `Obsidian audio recorder`) and set an expiration date.
5. Click **Create new key** and copy the key straight away. It is shown once and cannot be read back after you close the dialog.

> API access is enabled by default with no credit card, under usage and rate limits. Your usage and any billing live in the Mistral console, so check there if a request comes back rejected for quota.

---

## Step 2: Configure Voxtral for transcription

In Obsidian, open **Settings > Advanced Audio Recorder** and scroll to the **Transcription** section.

1. Turn on **Enable transcription**.
2. Set **Transcription engine** to **Mistral Voxtral**.
3. Open **Engines** and then the **Mistral Voxtral** page.
4. Leave **Base URL** at `https://api.mistral.ai/v1` unless you are routing requests through a gateway.
5. Paste your key into **Mistral API key**.
6. Under **Model**, pick `voxtral-mini-latest` (the default). Use the **Model catalogue** entry to add another id, drop one, or follow the **Voxtral model list** link to the [Mistral audio guide](https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription).
7. (Optional) Back in **Transcription**, turn on **Speaker diarization** for meetings and interviews.
8. (Optional) Turn on **Transcribe after recording** to transcribe every new recording automatically.

You will notice that whatever you type into **Language** does not reach this engine. That is expected, and the reason is below.

| Field                    | What to enter                                       |
| ------------------------ | --------------------------------------------------- |
| **Transcription engine** | Mistral Voxtral                                     |
| **Base URL**             | `https://api.mistral.ai/v1` (default)               |
| **Mistral API key**      | The key you copied from the console                 |
| **Model**                | `voxtral-mini-latest` (default)                     |
| **Speaker diarization**  | On for meetings and interviews, off for one speaker |

For the shared output settings (destination, file format, in-note formatting, timestamps, speaker formatting), see the [transcription guide](../transcription.md#output-where-the-transcript-goes).

---

## How Voxtral handles your audio

A few behaviors are specific to this engine and worth knowing before you transcribe a long meeting:

- **The engine detects the language itself.** Mistral refuses a language hint alongside the timestamp granularity that makes the response carry timed segments, and the plugin needs those segments for timecodes, so the granularity is sent and the hint is not. **Language** stays editable with that reason under it, because auto chapters fall back to the same field when a transcript carries no detected language, and whatever you had typed there is left alone for the engines that do read it.
- **Container conversion.** `mp3`, `wav`, `m4a`, `flac`, and `ogg` are uploaded untouched. Any other container, including the **WebM** this plugin records by default, is decoded to **16 kHz mono WAV** first, which costs time and memory on a long recording. Recording in MP3 or M4A skips that step.
- **Segment-level timing only.** The endpoint takes a request for per-word timing but returns nothing that carries individual words, so **Word-level timestamps** is shown disabled here and the JSON file output holds segment times.
- **No speech translation.** There is no translating operation on this endpoint, so **Translate speech to English** is disabled. Use the [translation task](../llm-post-processing.md) of LLM post-processing on the finished transcript instead.
- **Term biasing is capped at 100 entries.** The endpoint takes no spaces inside a term, so a multi-word entry is joined with underscores the way Mistral's own examples write them (`affordable_health_care`). Terms beyond the cap are reported in a notice rather than dropped silently.
- **Request timeout.** Each request honors the **Request timeout** setting (default 10 minutes, range 1-60). A three-hour recording is one request, so raise it if a long job is aborted.

---

## Reuse the same key for LLM post-processing

Mistral is also one of the four [LLM post-processing](../llm-post-processing.md) engines, alongside OpenAI, Anthropic, and Gemini. The **Mistral** page under **Engines** is a second catalogue over the same account: the `voxtral-*` ids transcribe and the `mistral-*` ids write, so the two pages hold separate model lists but the same endpoint and the same key.

To enable it:

1. In the **Transcription** section, open the **LLM post-processing** subsection.
2. Turn on **Enable LLM post-processing**.
3. Pick a **Task**: Clean up (default), Summarize, Translate, or Custom.
4. Set **Post-processing engine** to **Mistral**.
5. Open **Engines** and then **Mistral** to pick a **Model** (default `mistral-medium-latest`, with `mistral-small-latest` and `mistral-large-latest` seeded) and adjust **Max output tokens** if needed (default 4096, range 512-200000, with the model's own maximum as the real limit).

The key field on that page is the one you already filled in, because it belongs to the account rather than to either engine.

See the [LLM post-processing guide](../llm-post-processing.md) for the full set of tasks, prompts, and provider options.

---

## Verify it works

1. Open a note and record a short clip, or open an existing audio file in your vault.
2. Make sure **Mistral Voxtral** is the selected engine and your key is pasted in.
3. With an audio file active, run **Transcribe audio** from the command palette (this command appears only when transcription is enabled and the active file is audio).
4. Watch the progress dialog. When it finishes, the transcript is inserted into the note and written to a sidecar file, depending on your **Transcript output** settings.

If a transcript appears with clickable timecodes, and with speaker labels when diarization is on, Voxtral is working.

---

## Troubleshooting

| Symptom                                             | Likely cause and fix                                                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Unauthorized`                              | The key is wrong, truncated, or expired. Create a fresh one at [console.mistral.ai](https://console.mistral.ai) and paste it into **Mistral API key** with no spaces.                        |
| `429` / rate-limit error                            | You hit the free-mode rate limits. Wait and retry, or raise your limits in the Mistral console.                                                                                              |
| `404` / model not found                             | The model id is unknown to your account. Pick `voxtral-mini-latest` or another id from the [Mistral audio guide](https://docs.mistral.ai/studio/audio/speech_to_text/offline_transcription). |
| A language code has no effect on the transcript     | Expected on this engine, which detects the spoken language itself. Pick another engine if you need to force a language code.                                                                 |
| **Word-level timestamps** cannot be turned on       | Expected: this endpoint returns segment times and nothing finer. Use the [Whisper API](openai-whisper-api-key.md) if you need per-word timing in the JSON output.                            |
| A WebM recording takes a long time before uploading | It is being decoded to WAV first, because the endpoint does not read that container. Record in MP3 or M4A to skip the decode.                                                                |
| The file is refused as too large                    | The decode expands the recording in memory, and this device has a ceiling. Convert it to one of the accepted containers, or [split it](../splitting.md) into parts.                          |
| Recording is refused as too long for one request    | Longer than the three hours one request carries. The length is measured once the recording is decoded, before anything is uploaded. [Split it](../splitting.md) into parts first.            |
| Request times out on a long recording               | Raise **Request timeout** (up to 60 minutes). A three-hour recording is one request, and its deadline never falls below 20 minutes but is still capped by that setting.                      |
| Connection or network errors                        | Voxtral is a cloud engine and needs internet. For fully offline transcription, use [local whisper.cpp](local-whisper-cpp.md).                                                                |

> **Key privacy.** Your Mistral API key is stored in the plugin's `data.json` on this device and is never written to diagnostics. Avoid syncing `data.json` to untrusted locations. If you need everything to stay offline, use the [local whisper.cpp engine](local-whisper-cpp.md) instead.

---

## Related guides

- [Transcription](../transcription.md) - engines, diarization, output formats, and destinations.
- [LLM post-processing](../llm-post-processing.md) - clean up, summarize, translate, or apply a custom instruction.
- [Deepgram API key](deepgram-api-key.md) - the other whole-file diarizing engine, with per-word timing.
- [Google Gemini API key](gemini-api-key.md) - another engine whose key is shared with LLM post-processing.
- [Local whisper.cpp (offline)](local-whisper-cpp.md) - private, offline transcription with no API key.
- [Settings reference](../settings-reference.md) - every setting, its options, and its default.
