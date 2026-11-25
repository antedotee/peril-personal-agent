---
name: reminders-and-watchers
description: Set reminders and watch things for Kartik at the lowest cost. Use for "remind me", "every morning", "tell me when the price drops", "let me know if this page changes". Plain reminders use say prompts with no model call. Watchers are small scripts that run without a model and wake you only on a hit.
---
# Reminders and watchers

Peril pays for every model call, so time-based and change-based jobs avoid the model unless they need judgment.

## Reminders

- One-off: `schedule_create` with `nextRunAt` (ISO time) and prompt `say: <the exact text Kartik will get>`. Keep the text short and in your voice: `say: time to call mom`.
- Recurring: a 5-field cron in `Asia/Kolkata`, same `say:` prompt.
- Only use a full prompt when the job needs thinking, like "check my calendar and tell me if tomorrow starts before 9".
- Confirm in one line with the time in IST, or react with a tapback by replying NOTHING after the schedule is saved.

## Watchers

A watcher is a script in `watchers/` that prints one line of JSON: `{"value": ..., "hit": true|false, "summary": "..."}`. The runtime runs it on a schedule, compares the output with the last run, and wakes you only when `hit` is true.

To create one, call `create_watcher` with the source URL, what to compare, and how often. It hands the writing to a deep session that writes the script, runs it once and registers it. Never write a watcher in the chat session.
