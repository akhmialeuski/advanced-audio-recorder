# Get an AssemblyAI API key

**AssemblyAI** is one of the six [transcription](../transcription.md) engines. It takes a recording of up to ten hours as one job, labels the speakers, and bills about **$0.21 per audio hour** on its flagship model. This guide gets a key, links it in the plugin, and checks that a transcript comes back.

- [Why AssemblyAI](#why-assemblyai)
- [Step 1: Copy the API key from the AssemblyAI dashboard](#step-1-copy-the-api-key-from-the-assemblyai-dashboard)
- [Step 2: Configure AssemblyAI for transcription](#step-2-configure-assemblyai-for-transcription)
- [How AssemblyAI handles your audio](#how-assemblyai-handles-your-audio)
- [Verify it works](#verify-it-works)
- [Troubleshooting](#troubleshooting)

## Why AssemblyAI

AssemblyAI is the engine to reach for when a meeting has many speakers in it:

- **Ten hours in one job.** The whole meeting is transcribed in one piece, so speaker numbering stays consistent from the first minute to the last. Files are sent whole up to **2.2 GB**.
- **Speaker diarization.** Turn on **Speaker diarization** to get per-speaker labels, which you can then rename like any other engine's.
- **No decode before upload.** The recording goes up in the container it was recorded in, the default `webm` included.
- **Per-word timing on every run**, recorded in the JSON file output.
- **Term biasing.** A [custom dictionary](../transcription.md#biasing-recognition-toward-your-own-terms) is sent as `keyterms_prompt`, which helps the model spell names, jargon, and acronyms the way you do. AssemblyAI bills it as an extra.

| Property                | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| Engine name in settings | **AssemblyAI**                                                     |
| Default base URL        | `https://api.assemblyai.com` (EU: `https://api.eu.assemblyai.com`) |
| Default model           | `assemblyai-stt-3-7`                                               |
| Max file size           | 2.2 GB per job (uploaded whole)                                    |
| Max length              | Ten hours per job                                                  |
| Diarization             | Supported (off by default), about $0.02 per hour extra             |
| Language hint           | The first code in **Language**, or detection when it is empty      |
| Word-level timestamps   | Returned on every run                                              |
| Custom dictionary       | Sent as keyterms, about $0.05 per hour extra                       |
| Cost                    | About $0.21 per audio hour, or $0.15 on `universal-2`              |

---

## Step 1: Copy the API key from the AssemblyAI dashboard

1. Open **[www.assemblyai.com/dashboard](https://www.assemblyai.com/dashboard)** in your browser and sign in, or create an account.
2. Open the **API Keys** page.
3. Copy your key.

> Usage and billing live in the AssemblyAI dashboard, so check there if a request comes back rejected for quota.

---

## Step 2: Configure AssemblyAI for transcription

In Obsidian, open **Settings > Advanced Audio Recorder** and scroll to the **Transcription** section.

1. Turn on **Enable transcription**.
2. Set **Transcription engine** to **AssemblyAI**.
3. Open **Engines** and then the **AssemblyAI** page.
4. Leave **Base URL** at `https://api.assemblyai.com`, or set `https://api.eu.assemblyai.com` when your account uses the EU region.
5. On the **AssemblyAI API key** row, click **Link...**. In Obsidian's secret picker choose **Add secret...** (it opens straight away while the keychain is empty), enter an ID such as `assemblyai-api-key`, paste your key as the secret, and save. The key is kept in Obsidian's keychain on this device; the plugin stores only the ID.
6. Under **Model**, pick `assemblyai-stt-3-7` (the default) or `universal-2`. Use the **Model catalogue** entry below it to add another id or drop one, and follow the **AssemblyAI model list** link at the end of the **Model** row's description to AssemblyAI's [speech model guide](https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model).
7. (Optional) Back in **Transcription**, turn on **Speaker diarization** for meetings and interviews.
8. (Optional) Turn on **Transcribe after recording** to transcribe every new recording automatically.

| Field                    | What to enter                                       |
| ------------------------ | --------------------------------------------------- |
| **Transcription engine** | AssemblyAI                                          |
| **Base URL**             | `https://api.assemblyai.com` (default)              |
| **AssemblyAI API key**   | The key you copied from the dashboard               |
| **Model**                | `assemblyai-stt-3-7` (default)                      |
| **Speaker diarization**  | On for meetings and interviews, off for one speaker |

For the shared output settings (destination, file format, in-note formatting, timestamps, speaker formatting), see the [transcription guide](../transcription.md#output-where-the-transcript-goes).

---

## How AssemblyAI handles your audio

AssemblyAI transcribes a recording as a job with three steps, and the progress dialog stays open through all of them:

1. The recording is uploaded to AssemblyAI as it is.
2. A transcript is queued for the upload, naming the model, the language, the speaker labels, and the keyterms.
3. The plugin reads the job's status every three seconds until it completes, then reads the transcript back sentence by sentence.

Each sentence becomes one transcript line with its own timecode and, when diarization is on, its speaker. The job has the whole **Request timeout** to complete, and cancelling the run ends the wait at once.

The cost of a run is the model's rate plus the extras the run asks for. A two-hour meeting on the flagship with speaker labels and a dictionary comes to:

```text
(0.21 + 0.02 + 0.05) USD per hour * 2 hours = 0.56 USD
```

The [cost estimate](../transcription.md#cost-estimates) in the **Transcribe audio** dialog adds the same extras before the run starts.

---

## Verify it works

1. Open a note and record a short clip, or open an existing audio file in your vault.
2. Make sure **AssemblyAI** is the selected engine and its key is linked.
3. With an audio file active, run **Transcribe audio** from the command palette (this command appears only when transcription is enabled and the active file is audio).
4. Watch the progress dialog. When it finishes, the transcript is inserted into the note and written to a sidecar file, depending on your **Transcript output** settings.

If a transcript appears with clickable timecodes, and with speaker labels when diarization is on, AssemblyAI is working.

---

## Troubleshooting

| Symptom                                                         | Likely cause and fix                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401` / `Unauthorized`                                          | The key is wrong or truncated. Copy it again from the [AssemblyAI dashboard](https://www.assemblyai.com/dashboard) and store it in the secret linked on **AssemblyAI API key** (edit it on **Settings > Keychain**), with no spaces. |
| `AssemblyAI could not transcribe the recording: ...`            | The job itself failed, and the text after the colon is AssemblyAI's own reason, such as a recording with no speech in it.                                                                                                            |
| `Timed out waiting for AssemblyAI to transcribe the recording.` | The job did not complete within **Request timeout**. Raise that setting (up to 60 minutes) and run the transcription again.                                                                                                          |
| The transcript is in the wrong language                         | Detection picked another language. Set **Language** to the code of the recording, or pick `universal-2` for a language the flagship model does not cover.                                                                            |
| Some dictionary terms were not sent                             | A phrase may hold at most 6 words, and all phrases together at most 1000 words on the flagship and 200 on `universal-2`. The notice names how many terms were sent.                                                                  |
| The cost is higher than the model's rate                        | Speaker labels and keyterms are billed as extras. Turn off **Speaker diarization**, or select no dictionary, for a run that needs neither.                                                                                           |
| Connection or network errors                                    | AssemblyAI is a cloud engine and needs internet. For fully offline transcription, use [local whisper.cpp](local-whisper-cpp.md).                                                                                                     |

> **Key privacy.** Your AssemblyAI API key is kept in Obsidian's keychain (**Settings > Keychain**) on this device, not in the plugin's `data.json`, and is never written to diagnostics. The keychain does not sync, so on another device link the key once more under the same ID. If you need everything to stay offline, use the [local whisper.cpp engine](local-whisper-cpp.md) instead.
