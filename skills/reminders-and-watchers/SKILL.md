---
name: reminders-and-watchers
description: Set reminders and watch things for Kartik at the lowest cost. Use for "remind me", "every morning", "tell me when the price drops", "let me know if this page changes". Plain reminders use say prompts with no model call. Watchers are small scripts that run without a model and wake you only on a hit.
---
# Reminders and watchers

Peril pays for every model call, so time-based and change-based jobs avoid the model unless they need judgment.

## Reminders

- One-off: `schedule_create` with `at` (an ISO time) and prompt `say: <the exact text Kartik will get>`. Keep the text short and in your voice: `say: time to call mom`.
- Recurring: a 5-field cron in `Asia/Kolkata`, same `say:` prompt.
- Only use a full prompt when the job needs thinking, like "check my calendar and tell me if tomorrow starts before 9".
- Confirm in one line with the time in IST, or react with a tapback by replying NOTHING after the schedule is saved.

## Watchers

A watcher is a spec, not code: a public URL, what to pull out, and a condition. Plain code checks it on a schedule and wakes you only when the condition holds and the value changed.

1. `web_fetch` the page once to see where the value sits.
2. Call `watcher_create` with:
   - `spec.url`: the page or JSON API.
   - `spec.extract`: `{ "kind": "regex", "pattern": "₹\\s*([\\d,]+)" }` for a value in page text, `{ "kind": "json", "path": "data.price" }` for an API, or `{ "kind": "text" }` to watch the whole page.
   - `spec.condition`: `lt` or `gt` with a number, `eq` or `contains` with text, or `changed`.
   - `everyMinutes`: 60 or more unless Kartik needs it faster. The minimum is 5.
3. The tool reads the page once and returns the value it found. If that is not the value Kartik means, `watcher_remove` it and try again.
4. Tell Kartik in one line what you're watching and how often.
