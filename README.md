# SimpleSummarizer

Long chats blow past your context window, and the model starts forgetting what happened fifty messages ago. SimpleSummarizer fixes that without you having to babysit it.

It chops your chat into batches, summarizes each one (with memorable quotes pulled out), and injects those summaries back into context so the model keeps its memory of older events. When the story gets really long, roll everything up into a single comprehensive summary, which you can access from a new, fresh chat.

Enjoy :) -moki

---

## How It Works

Messages are grouped into **batches** (default 6 messages each). Once a batch is complete, it gets summarized into a few factual sentences plus any standout quotes. Those summaries are injected into your prompt, while the original older messages are hidden from context, so the model remembers what happened without paying the full token cost.

**Comprehensive summary** — Once you have a stack of batch summaries, condense them into one running overview of the whole story. Good for very long chats where even the batch summaries add up.

**Auto mode** — Let it process new batches on its own as you play. It waits for streaming to finish and leaves the last couple of messages alone (they're still "active"), so it won't interrupt the scene.

## The Modal

Open it from the wand menu (the scroll icon) or `/summarizer-modal`. Five tabs:

- **Batches** — View, edit, regenerate, or delete individual batch summaries. See which are processed and which need attention.
- **Comprehensive** — View and edit the rolled-up summary, or regenerate it from the current batches.
- **Pinned Quotes** — Pin the quotes you want kept around. Pinned quotes stick regardless of how summaries shuffle.
- **Archives** — Pull comprehensive summaries from *other* chats into this one (see below).
- **Settings** — Everything below.

## Context Archives

Assign comprehensive summaries from your previous chats to inject into the current one. Handy for ongoing storylines across multiple chats, or shared-world setups where past events should carry over. Set a token budget and pick an overflow strategy (priority, balanced, or context-weighted) for when your assigned archives exceed it.

## Settings

In the Settings tab of the modal.

- **Batch Size** — How many messages per batch (default 6).
- **Summary Lengths** — Target length for establishment, batch, and comprehensive summaries.
- **Auto Mode & Buffer** — Toggle auto-processing and set how many recent messages to leave untouched.
- **Message Exclusion** — How many older messages get hidden once summarized, by batch count or raw message count. Keep the first and last N batches visible.
- **Connection Profile** — Use a separate API connection/preset for summarization, so you can run a cheap/fast model for summaries and your main model for roleplay.
- **Display** — Show or hide summary markers in the chat.

## Macros

Drop these into prompts, world info, or author's notes:

- `{{comprehensive_summary}}` — The comprehensive summary text.
- `{{comprehensive_summary_with_quotes}}` — Same, with memorable quotes appended.
- `{{batch_summaries}}` — All batch summaries currently being injected.
- `{{batch_count}}` — Number of processed batches.

## Slash Commands

- `/summarizer-modal` — Open the modal
- `/summarizer-toggle` — Enable/disable for the current chat
- `/summarizer-process` — Process all unprocessed batches
- `/summarizer-comprehensive` — Generate the comprehensive summary
- `/summarizer-view-comprehensive` — Open the modal on the Comprehensive tab
- `/summarizer-status` — Print status (batch counts, processed/dirty, etc.)
- `/summarizer-clear` — Clear all summaries for the current chat

## Installation

Use SillyTavern's built-in extension installer:

1. Open **Extensions** → **Install Extension**
2. Paste this URL:
   ```
   https://github.com/mokimoko/SillyTavern-SimpleSummarizer
   ```
3. Click **Install** and reload if prompted

## Tips

- Set a cheap, fast model as the connection profile. Summaries don't need your best model, and you'll save time and tokens.
- Auto mode is off by default. Turn it on once you've confirmed your batch size and connection profile feel right.
- Editing a message that's already summarized marks its batch dirty, so it'll re-process. Deleting messages does the same.
