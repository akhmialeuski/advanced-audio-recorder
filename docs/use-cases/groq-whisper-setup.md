# Use Groq (free tier) with the Whisper API engine

Groq hosts the open Whisper speech-to-text models behind an **OpenAI-compatible** API, so you can point the plugin's **Whisper API** engine at Groq instead of OpenAI and transcribe for free during Groq's generous free tier. This guide walks you through signing up, creating a key, and configuring the **Whisper API** engine to use Groq's `whisper-large-v3` and `whisper-large-v3-turbo` models.

- [Why Groq](#why-groq)
- [Before you start](#before-you-start)
- [Step 1: Create a Groq account](#step-1-create-a-groq-account)
- [Step 2: Create an API key](#step-2-create-an-api-key)
- [Step 3: Configure the Whisper API engine](#step-3-configure-the-whisper-api-engine)
- [Step 4: Pick a Groq model](#step-4-pick-a-groq-model)
- [Step 5: Verify with a short recording](#step-5-verify-with-a-short-recording)
- [What Groq does and does not do](#what-groq-does-and-does-not-do)
- [Troubleshooting](#troubleshooting)
- [Security and privacy](#security-and-privacy)
- [Related guides](#related-guides)

## Why Groq

Groq runs the same Whisper models OpenAI exposes, but on its own fast inference hardware and behind an endpoint that speaks the OpenAI API dialect. For this plugin that means three things:

- **Free to start.** Groq offers a free tier, so you can transcribe real recordings without entering a credit card up front. Heavy or production use moves to pay-as-you-go.
- **Fast.** Groq's hardware returns Whisper transcripts quickly, which is noticeable on longer recordings.
- **Drop-in compatible.** Because Groq implements the OpenAI transcription API, the plugin's existing **Whisper API** engine works against it unchanged - you only swap the **base URL**, the **API key**, and the **model**. No separate engine, no extra setup.

The trade-off is the same as OpenAI's Whisper API: there is **no speaker diarization**, and each request is capped at **25 MB** (the plugin handles larger files automatically - see [What Groq does and does not do](#what-groq-does-and-does-not-do)).

---

## Before you start

You need:

- The plugin installed and enabled in Obsidian on **desktop or mobile** (the Whisper API engine is a cloud engine, so it works on both). See [Getting started](../getting-started.md).
- Transcription enabled: open **Settings > Advanced Audio Recorder > Transcription** and turn **Enable transcription** on. See [Transcription](../transcription.md).
- A web browser to reach the Groq Console.

This whole setup is the same **Whisper API** engine documented in the [OpenAI / Whisper API guide](openai-whisper-api-key.md); the only differences are the three values you enter (base URL, key, model). If you already followed that guide for OpenAI, you can switch to Groq just by changing those three fields.

---

## Step 1: Create a Groq account

1. Open the Groq Console at <https://console.groq.com> in your browser.
2. Sign up (you can use an existing Google or GitHub login).
3. Confirm your email if prompted.

The free tier is active immediately; you do not need to add billing to start transcribing.

---

## Step 2: Create an API key

1. Go to the API keys page at <https://console.groq.com/keys>.
2. Click **Create API Key** (Groq may ask you to name the key - call it `obsidian` or similar so you can recognize it later).
3. **Copy the key immediately.** Groq shows the full key only once. It starts with `gsk_`.
4. Store it somewhere safe (a password manager). If you lose it, delete the old key and create a new one.

> Treat the key like a password. Anyone with it can spend against your Groq account.

---

## Step 3: Configure the Whisper API engine

1. Open **Settings > Advanced Audio Recorder > Transcription**.
2. Make sure **Enable transcription** is on.
3. Set **Engine** to **Whisper API (OpenAI-compatible)**.
4. In **Base URL**, replace the default OpenAI URL with Groq's:
    - `https://api.groq.com/openai/v1`
5. Paste your Groq key (the `gsk_…` value) into **Whisper API key**.
6. Set the **model** (next step) and choose your **Language** and **Transcript output** options as usual.

The exact field labels, order, and conditional rows are described in the [Transcription](../transcription.md) guide; the table below lists only the values specific to Groq.

| Field               | Value to enter                                 | Notes                                                                            |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| **Engine**          | `Whisper API (OpenAI-compatible)`              | Same engine used for OpenAI; only the three values below differ.                 |
| **Base URL**        | `https://api.groq.com/openai/v1`               | Groq's OpenAI-compatible endpoint. Note the `/openai/v1` path.                   |
| **Whisper API key** | your `gsk_…` key                               | Created in [Step 2](#step-2-create-an-api-key).                                  |
| **Model**           | `whisper-large-v3` or `whisper-large-v3-turbo` | Pick from the list or add a custom id - see [Step 4](#step-4-pick-a-groq-model). |

> The **Language** field defaults to `auto` (auto-detect). Set an ISO code such as `en`, `ru`, or `es` if auto-detection picks the wrong language. **Speaker diarization** stays disabled and greyed out for the Whisper API engine - Groq does not return speakers.

---

## Step 4: Pick a Groq model

The model picker seeds a few suggested ids and lets you **Add custom model** or **Remove selected**. For Groq, choose one of the large Whisper models - they support `verbose_json` with segment timestamps, which the plugin requires.

| Model                        | Use it for                                                 | Trade-off                                |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `whisper-large-v3`           | Best accuracy, full multilingual support.                  | Slightly slower than the turbo variant.  |
| `whisper-large-v3-turbo`     | Fast multilingual transcription at near-large-v3 accuracy. | Marginally lower accuracy on hard audio. |
| `distil-whisper-large-v3-en` | English-only, smallest/fastest distilled model.            | English only; not for other languages.   |

`whisper-large-v3` and `whisper-large-v3-turbo` are pre-seeded in the model list, so you can usually select one directly. If a model you want is not listed, click **Add custom model**, type the exact id (for example `whisper-large-v3-turbo`), and select it. If Groq later renames or adds a model, use **Add custom model** with the new id; the model catalogue link in settings opens the OpenAI speech-to-text reference (<https://platform.openai.com/docs/guides/speech-to-text>) for the API shape, while Groq's own model list is on the Groq Console.

> **Important:** The model must return `verbose_json` **with timestamps**. The plugin relies on timed segments to build clickable timecode links and sidecar files. The large Whisper models above all qualify; OpenAI's newer `gpt-4o-transcribe` family does **not** and is intentionally not offered.

---

## Step 5: Verify with a short recording

1. Record a short clip (10-20 seconds) with the ribbon **microphone** icon, or open an existing audio file in a note.
2. With the audio file active, run **Transcribe audio** from the command palette - or enable **Transcribe after recording** in settings so new recordings transcribe automatically.
3. The transcription progress dialog appears with a progress bar, an elapsed timer, **Cancel**, and **Minimize** (sending the job to the status bar so you can keep working; click the status bar to reopen it).
4. When it finishes, the transcript is inserted into the note and/or written as a sidecar file, according to your **Transcript output** settings.

If the transcript looks right, Groq is configured. For output formatting, destinations, timecode links, and optional LLM cleanup or summary, see [Transcription](../transcription.md) and [LLM post-processing](../llm-post-processing.md).

---

## What Groq does and does not do

Groq runs through the plugin's **Whisper API** engine, so it inherits that engine's behavior:

- **Per-request limit: 25 MB.** Files at or under 25 MB are uploaded in their original container. Larger recordings are automatically resampled to 16 kHz mono and split into upload-sized WAV chunks, transcribed separately, and stitched onto one timeline - you do not split them by hand.
- **No diarization.** The Whisper API does not label speakers, so **Speaker diarization** is disabled and greyed out for this engine. For speaker labels in meetings and interviews, use [Deepgram](deepgram-api-key.md) or [Google Gemini](gemini-api-key.md) instead.
- **Word-level timestamps** can be enabled; they are recorded in the JSON sidecar output only.
- **Upload chunk size** (Whisper API only) defaults to **24 MB** and ranges 1-24 MB. It is sized to stay under Groq's/OpenAI's 25 MB hard limit; leave it at the default unless you have a reason to lower it.
- **Request timeout** defaults to **10 minutes** (range 1-60). A single request that runs longer is aborted and reported, so a hung endpoint fails the part instead of stalling the whole job.

| Capability             | Groq via Whisper API                        |
| ---------------------- | ------------------------------------------- |
| Cost                   | Free tier, then pay-as-you-go               |
| Diarization (speakers) | No                                          |
| Max file per request   | 25 MB (larger files auto-chunked)           |
| Offline                | No (cloud API)                              |
| Word timestamps        | Yes (JSON sidecar only)                     |
| Best for               | Fast, accurate single-speaker transcription |

---

## Troubleshooting

| Symptom                                                | Likely cause and fix                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / "Invalid API key" / "Unauthorized"             | The key is wrong, has extra spaces, or was revoked. Re-copy it from <https://console.groq.com/keys> and paste it again, or create a new key.    |
| `404` / "model not found" / wrong base URL             | Check the **Base URL** is exactly `https://api.groq.com/openai/v1` (note `/openai/v1`), and that the **model** id matches a current Groq model. |
| "model does not support verbose_json" or empty timings | The selected model cannot return timed segments. Switch to `whisper-large-v3` or `whisper-large-v3-turbo`.                                      |
| `429` / "rate limit" / "Too Many Requests"             | Groq's free tier has per-minute request and token limits. Wait and retry, transcribe fewer files at once, or upgrade your Groq plan.            |
| Transcript is in the wrong language                    | Set **Language** to the correct ISO code (`en`, `ru`, `es`, …) instead of `auto`.                                                               |
| Request times out on a long file                       | Raise **Request timeout** (up to 60 minutes). The plugin already chunks files over 25 MB, so each request stays small.                          |
| Speaker labels are missing                             | Expected - the Whisper API has no diarization. Use [Deepgram](deepgram-api-key.md) or [Gemini](gemini-api-key.md) for speakers.                 |

If a problem persists, see the [Troubleshooting](../troubleshooting.md) guide and the [Bug reporting guide](../BUG_REPORTING_GUIDE.md). Include the **System info** report - it never contains your API key.

---

## Security and privacy

- Your Groq key is stored in the plugin's `data.json` on this device and is **never** written into the **System info** diagnostics report.
- Avoid syncing `data.json` to untrusted locations, since it holds your key.
- Groq is a cloud service: audio you transcribe is uploaded to Groq's servers. For fully offline transcription that never touches the network, use the [Local whisper.cpp](local-whisper-cpp.md) engine instead.

---

## Related guides

- [OpenAI / Whisper API key](openai-whisper-api-key.md) - the same engine pointed at OpenAI; the base concepts are identical.
- [Transcription](../transcription.md) - engines, output formats, destinations, and the progress dialog.
- [LLM post-processing](../llm-post-processing.md) - clean up or summarize the Groq transcript with an LLM.
- [Deepgram](deepgram-api-key.md) and [Google Gemini](gemini-api-key.md) - engines that support speaker diarization.
- [Use cases & how-tos](index.md) - all setup and workflow guides.
