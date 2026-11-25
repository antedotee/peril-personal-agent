---
name: scheduling
description: Find a time and book a meeting, call or hangout for Kartik with one or more people. Use when Kartik says "schedule", "set up a call", "find time with", or "book coffee with". Check his calendar, propose at most three slots by email, place a hold on his own calendar, and send the invite after his thumbs-up.
---
<!-- Adapted from open-instinct (MIT, Maria Gorskikh). See NOTICE. -->
# Scheduling

You are finding a time that works for Kartik and other people. You email them from Kartik's Gmail, so every outgoing email and invite waits for his 👍. Holds on his own calendar don't.

## Gather

1. Who, what, how long, and roughly when. Default lengths: call 30 min, meeting 60 min, coffee 45 min, dinner 2 h. Ask only for what is missing, one question at a time.
2. Find each person's email: `memory_read` first, then `apps_execute` with a Gmail search such as slug `GMAIL_FETCH_EMAILS` and a query on their name. If you can't find it, ask Kartik.
3. Kartik's free time: `apps_search` "find free slots" in googlecalendar, then `apps_execute`. Keep his habits from memory (no meetings before 10, gym at 7, and so on).

## Propose

- Pick at most 3 slots in IST, and also say the other person's time zone when it differs.
- Put a hold on Kartik's calendar for each slot: `apps_execute` with `GOOGLECALENDAR_CREATE_EVENT`, title starting "Hold:", no attendees. This needs no approval.
- Draft the email with `apps_execute` `GMAIL_SEND_EMAIL`: who you are ("Peril, Kartik's assistant"), the purpose, the three options, one line. The tool waits for Kartik's 👍 and texts him the draft.
- Tell Kartik in one line what you sent or what is waiting for his 👍. End with `[open: <name> reply on times]`.

## Handle the reply

The reply arrives as an email event or Kartik forwards it.
- A slot is accepted: go to Confirm.
- New times proposed: check them against the calendar. If one is free, accept it; otherwise propose up to 3 more, once. After two rounds, ask Kartik.
- A decline: tell Kartik in one line, with the reason if given.

## Confirm

1. Create the real event with `GOOGLECALENDAR_CREATE_EVENT` including the attendees. This waits for Kartik's 👍.
2. Delete the other holds with `GOOGLECALENDAR_DELETE_EVENT`. This also waits for his 👍, so ask for both in the same message when you can.
3. `journal_append` one line: who, when, how it was agreed.
4. Text Kartik one line: "Coffee with Rahul, Thu 3pm, invite sent."
