# Get an Anthropic (Claude) API key for LLM post-processing

Anthropic (Claude) is one of the three **LLM post-processing** providers. After a transcript is produced, the plugin can send it to a Claude model to **clean it up**, **summarize** it, or run a **custom instruction**. Claude is not a transcription engine - it never turns audio into text. It only rewrites or summarizes text that one of the transcription engines already produced. This guide walks you through creating an Anthropic account, generating an API key, and wiring it into the plugin.

Unlike the OpenAI and Gemini LLM providers - which **reuse** their respective transcription keys - Anthropic has **its own dedicated key field**. You enter the Anthropic key separately, and you can use Claude for post-processing no matter which engine produced the transcript (Whisper API, Deepgram, Gemini, or local `whisper.cpp`).

- [What it is for](#what-it-is-for)
- [Before you start](#before-you-start)
- [Step 1: Create an Anthropic account](#step-1-create-an-anthropic-account)
- [Step 2: Set up billing and credits](#step-2-set-up-billing-and-credits)
- [Step 3: Create an API key](#step-3-create-an-api-key)
- [Step 4: Configure the plugin](#step-4-configure-the-plugin)
- [Choosing a model](#choosing-a-model)
- [Choosing a task](#choosing-a-task)
- [Step 5: Verify on a sample transcript](#step-5-verify-on-a-sample-transcript)
- [Settings summary](#settings-summary)
- [Troubleshooting](#troubleshooting)
- [Related pages](#related-pages)

## What it is for

LLM post-processing is an optional, second pass that runs **after** transcription. When you enable it and pick **Anthropic (Claude)** as the provider, the finished transcript is sent to a Claude model with one of three instructions:

- **Clean up** - fix punctuation, capitalization, and obvious speech-to-text errors, add paragraph breaks, and remove filler, while preserving the exact wording, speaker labels, and timestamps.
- **Summarize** - condense the transcript into key points and action items as Markdown bullet lists.
- **Custom** - send your own verbatim instruction (e.g. "rewrite as meeting notes").

The default Claude model is **`claude-opus-4-8`**. Requests use Anthropic's Messages API at `https://api.anthropic.com/v1`.

> Anthropic charges per token. The plugin makes one request per transcript (long transcripts may be split into several requests), so cost depends on the length of your recordings and how often you transcribe. Start with a small credit and watch your usage.

![Settings tab with LLM post-processing set to the Anthropic (Claude) provider, showing the Anthropic key field, base URL, and model picker](../images/use-case-anthropic-settings.png)
*Figure: The Anthropic provider configured under Settings > Transcription > LLM post-processing.*

## Before you start

| Requirement               | Detail                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Transcription enabled** | LLM post-processing lives inside the **Transcription** section and only runs after one. |
| **A working engine**      | Any engine produces the transcript Claude then processes (cloud or offline).            |
| **An Anthropic account**  | Free to create; you add billing or credits to make API calls.                           |
| **Anthropic API credit**  | Pay-as-you-go. The API is billed separately from a Claude.ai chat subscription.         |
| **Internet connection**   | Claude is a cloud API. Only the transcript text is sent - never your audio.             |

> A Claude.ai chat subscription (Pro/Max) does **not** include API access. API usage is billed separately through the Anthropic Console. You need API credit even if you already pay for the chat app.

## Step 1: Create an Anthropic account

1. Open the Anthropic Console at **`https://console.anthropic.com`**.
2. Sign up with an email address or a Google account, and verify your email.
3. Complete any organization setup prompts (you can use the personal default).

![Anthropic Console sign-in page](../images/use-case-anthropic-console-signin.png)
*Figure: The Anthropic Console landing page where you create your account.*

## Step 2: Set up billing and credits

The API requires prepaid credit or a billing method before it will answer requests.

1. In the Console, open **Settings > Billing** (or **Plans & Billing**).
2. Add a payment method and purchase credit, or enable pay-as-you-go.
3. Confirm a positive balance is shown.

![Anthropic Console billing page showing a credit balance](../images/use-case-anthropic-billing.png)
*Figure: Add credit on the Billing page so the API can answer requests.*

> If you skip this step, the plugin's requests fail with a credit/balance error. See [Troubleshooting](#troubleshooting).

## Step 3: Create an API key

1. Go to **`https://console.anthropic.com/settings/keys`** (Console > **Settings > API Keys**).
2. Click **Create Key**, give it a recognizable name (e.g. `obsidian-aar`), and create it.
3. **Copy the key now.** Anthropic shows the full key only once. Keys typically start with `sk-ant-`.
4. Store it somewhere safe. If you lose it, delete it and create a new one.

![Anthropic Console API Keys page with a Create Key button](../images/use-case-anthropic-create-key.png)
*Figure: Generate a new key on the API Keys page and copy it immediately.*

> Treat the key like a password. Anyone who has it can spend your credit. Never paste it into a note, commit it to a repository, or share it. The plugin stores it locally in `data.json` (see [Settings summary](#settings-summary)).

## Step 4: Configure the plugin

1. Open **Settings > Advanced Audio Recorder** and scroll to the **Transcription** section.
2. Turn on **Enable transcription** if it is off, and confirm an engine is configured.
3. Scroll to the **LLM post-processing** subsection and turn on **Enable LLM post-processing**.
4. Set **LLM provider** to **Anthropic (Claude)**.
5. Confirm the **LLM base URL** reads `https://api.anthropic.com/v1`. It auto-fills the Anthropic default when you switch providers; only change it if you front Anthropic with a proxy.
6. Paste your key into the **Anthropic API key** field. This is Anthropic's **own** field - it is not shared with any transcription key.
7. Pick a **model** (see [Choosing a model](#choosing-a-model)).
8. Pick a **Task** and review its prompt (see [Choosing a task](#choosing-a-task)).
9. Optionally adjust **Max output tokens** (default `4096`, range `512`-`32000`).

![LLM post-processing subsection expanded with provider Anthropic, the Anthropic key field, model picker, and Max output tokens slider](../images/use-case-anthropic-llm-fields.png)
*Figure: The Anthropic provider fields inside the LLM post-processing subsection.*

> **Shared vs. own keys.** OpenAI's LLM provider reuses the Whisper API key, and Gemini's LLM provider reuses the Gemini transcription key. **Anthropic does not** - it has a dedicated key field, because there is no Anthropic transcription engine to borrow a key from. See [Shared API keys](../llm-post-processing.md#shared-api-keys).

## Choosing a model

The model picker is seeded with the current Claude family and is editable - use **Add custom model** to add a newer id, and **Remove selected** to drop one. The catalogue link opens Anthropic's model list.

| Model               | Notes                                                                           |
| ------------------- | ------------------------------------------------------------------------------- |
| `claude-opus-4-8`   | **Default.** Most capable; best for nuanced cleanup and high-quality summaries. |
| `claude-sonnet-4-6` | Balanced quality and cost; a strong everyday choice for cleanup.                |
| `claude-haiku-4-5`  | Fastest and cheapest; good for short transcripts and bulk processing.           |

- **Catalogue:** the authoritative, current Claude model list is at `https://docs.anthropic.com/en/docs/about-claude/models`.
- Model ids change over time. If a seeded id is retired, use **Add custom model** to enter the new id exactly as Anthropic publishes it.

![Model picker dropdown for the Anthropic provider with Add custom model and Remove selected actions](../images/use-case-anthropic-model-picker.png)
*Figure: Pick a Claude model, or add a custom id with the catalogue link.*

## Choosing a task

The **Task** dropdown selects what Claude does with the transcript. Each task has its own editable prompt.

| Task          | What Claude does                                                                  | Prompt behavior                                                                 |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Clean up**  | Fixes punctuation/capitalization, adds paragraphs, removes filler; keeps wording. | Ships with a default prompt; the transcript language is appended automatically. |
| **Summarize** | Condenses the transcript into key points and action items as bullet lists.        | Ships with a default prompt; the transcript language is appended automatically. |
| **Custom**    | Follows your own instruction verbatim, in a larger editor.                        | Sent exactly as written - no language clause is added, so you control language. |

- The cleanup and summary prompts are editable but ship with sensible defaults. The plugin appends the transcript's language to them automatically, so the result stays in the source language.
- The custom instruction is sent **verbatim** in a larger editor - include any language, tone, or formatting directives yourself.

![Task dropdown set to Clean up with the editable prompt field visible](../images/use-case-anthropic-task.png)
*Figure: Choose Clean up, Summarize, or Custom; each has its own editable prompt.*

For a deeper explanation of the tasks and prompts, see [LLM post-processing](../llm-post-processing.md).

## Step 5: Verify on a sample transcript

1. Make sure transcription and LLM post-processing are both enabled and Anthropic is configured.
2. Pick a **short** audio file (a 30-60 second voice note keeps cost and time low).
3. Open it, then run **Transcribe active audio file** from the command palette - or right-click the file in the **File Explorer** and choose the transcription action.
4. Watch the progress dialog. Transcription runs first; the final band of the progress bar is the LLM post-processing pass.
5. When it finishes, open the resulting note/transcript and confirm Claude cleaned up or summarized the text as expected.

![Transcription progress dialog showing the LLM post-processing stage near the end of the bar](../images/use-case-anthropic-progress.png)
*Figure: The progress dialog; the final segment of the bar is Claude's post-processing pass.*

> If the result looks truncated or empty, raise **Max output tokens** and try again - Claude's reply is capped by that value. See [Troubleshooting](#troubleshooting).

## Settings summary

| Setting                        | Value for Anthropic                                                    |
| ------------------------------ | ---------------------------------------------------------------------- |
| **Enable transcription**       | On (post-processing runs inside transcription)                         |
| **Enable LLM post-processing** | On                                                                     |
| **LLM provider**               | `Anthropic (Claude)`                                                   |
| **LLM base URL**               | `https://api.anthropic.com/v1` (auto-filled default)                   |
| **Anthropic API key**          | Your `sk-ant-…` key (Anthropic's own field; not shared)                |
| **Model**                      | `claude-opus-4-8` (default) / `claude-sonnet-4-6` / `claude-haiku-4-5` |
| **Task**                       | `Clean up` (default) / `Summarize` / `Custom`                          |
| **Max output tokens**          | `4096` default; range `512`-`32000`                                    |

> **Where the key is stored.** The key lives in the plugin's `data.json` on this device. It is never written into the **System info** diagnostics report. Avoid syncing `data.json` to untrusted locations. Only the transcript **text** is sent to Anthropic - your audio never leaves your machine for the LLM step.

## Troubleshooting

| Symptom                                         | Likely cause and fix                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / authentication / invalid key            | The key is wrong, has a stray space, or was revoked. Re-copy it from the Console and paste it cleanly.                                 |
| Credit / balance / "insufficient credits" error | No API credit. Add billing at `https://console.anthropic.com/settings/billing` (Console > **Settings > Billing**) and purchase credit. |
| `404` / model not found                         | The model id is retired or misspelled. Open the catalogue and use **Add custom model** with the exact current id.                      |
| Result is cut off or empty                      | The reply hit **Max output tokens**. Raise it (up to `32000`), shorten the input, or pick a model with a larger limit.                 |
| `429` / rate limit                              | Too many requests too quickly, or a low tier. Wait and retry, or raise your account's rate limits in the Console.                      |
| Request times out                               | LLM requests are bounded by an internal timeout. Shorten the transcript, lower **Max output tokens**, or retry.                        |
| The LLM step never runs                         | **Enable LLM post-processing** is off, or transcription itself failed first. Confirm both are enabled and the engine works.            |
| Output is in the wrong language (Custom task)   | The custom instruction is sent verbatim with no language clause. State the desired language in your instruction.                       |
| Paid for Claude.ai but still get a credit error | A chat subscription does not include API access. Add API credit separately in the Console.                                             |

If transcription itself fails before Claude runs, fix that first - see the engine guides and [Transcription](../transcription.md#troubleshooting).

## Related pages

- [LLM post-processing](../llm-post-processing.md) - the full reference for tasks, prompts, providers, shared keys, base URLs, and token limits.
- [Transcription](../transcription.md) - engines, [diarization](../transcription.md#speakers-and-diarization), output formats, and destinations.
- [Use cases & how-tos](index.md) - all the API-key and setup guides in one place.
- [OpenAI / Whisper API key](openai-whisper-api-key.md) and [Google Gemini key](gemini-api-key.md) - the two LLM providers whose keys are **shared** with transcription, unlike Anthropic.
- [Settings reference](../settings-reference.md) - every setting, option, and default in one table.
