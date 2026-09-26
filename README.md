# SimpleSummarizer

SimpleSummarizer keeps long SillyTavern chats from forgetting earlier events.

It groups messages into batches, summarizes them, and puts the useful parts back into context. You can let it run automatically or manage everything from the scroll icon in the wand menu.

Enjoy :) -moki

## Features

- Batch summaries with importance scores, recall keywords, and memorable quotes
- Character memories for private knowledge or limited perspectives
- Automatic processing after a batch is complete
- A comprehensive recap for carrying a story into a fresh chat
- Context Archives for bringing summaries from older chats into a new one
- Optional message trimming to save context tokens
- A separate connection profile for summary generation

The main batch summary covers shared events. Character-only details stay in their character memories so the same information is not repeated in both places.

## Context Archives

Comprehensive summaries contain a complete recap for reading and a prompt-safe backbone made from shared, unrestricted memories. Private or conditional memories stay separate.

The Archives tab can bring comprehensive summaries from other chats into the current one. It supports a token budget with priority, balanced, or context-weighted trimming.

## Smart Memory

Each batch can have:

- **Importance** — Higher-value events are more likely to stay in context.
- **Recall keywords** — Optional memories can return when the current scene mentions a matching word or phrase.
- **Character memories** — Facts, reactions, and quotes known only to certain characters.
- **Card and tag rules** — Limit a memory to selected character cards or SillyTavern tags.

Older batches still work and default to normal shared memory.

## Settings Worth Checking

- **Batch Size** — Messages per batch; 6 by default. Changing it after processing clears that chat's summaries so ranges cannot overlap.
- **Auto-Process and Buffer** — Summarize completed batches while leaving the newest messages alone.
- **Message Trimming** — Hide older messages only after summaries cover them.
- **Connection Profile** — Let summaries use a cheaper or faster model.
- **Show Summaries in Chat** — Show or hide batch markers.

## Macros

Drop these into prompts, world info, or author's notes:

- `{{comprehensive_summary}}` — Prompt-safe story backbone
- `{{comprehensive_summary_with_quotes}}` — Backbone plus pinned shared quotes
- `{{comprehensive_archive_summary}}` — Complete recap, including scoped memories
- `{{batch_summaries}}` — Currently eligible batch and character memories
- `{{batch_count}}` — Number of processed batches

## Slash Commands

- `/summarizer-modal`
- `/summarizer-toggle`
- `/summarizer-process`
- `/summarizer-comprehensive`
- `/summarizer-view-comprehensive`
- `/summarizer-status`
- `/summarizer-clear`

## Installation

Open **Extensions → Install Extension** in SillyTavern and paste:

```
https://github.com/mokimoko/SillyTavern-SimpleSummarizer
```

Reload SillyTavern if prompted.

## Notes

- Auto mode is off by default.
- Editing or swiping a summarized message marks its batch for rebuilding.
- Deleting a message rebuilds that batch and every later batch because message indexes shift.
- Full archive recaps are not prompt-safe; use the normal comprehensive-summary macro in prompts.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT. See [LICENSE](LICENSE).
