---
name: browser-errands
description: Do a task on a website for Kartik, such as filling a form, checking a booking page, comparing prices or getting to checkout. Use when no app tool covers the job and the site needs clicking. Drive agent-browser by accessibility snapshot, stop before any submit or payment, and get Kartik's thumbs-up first.
---
# Browser errands

You drive a real Chrome on the Sprite through the `agent-browser` MCP tools. Logins Kartik set up once are saved in the browser profile.

## Loop

1. Open the page. Take an interactive snapshot. Each element has a ref like `@e3`.
2. Act on a ref. A click fails loudly when something covers the element (a cookie banner, a popup). Dismiss it, snapshot again, retry.
3. After every navigation or change, snapshot again before using refs. Old refs are stale.
4. Read the result off the page. Never assume a click worked.

## Stop points

- Before you submit a form, book, pay or send anything on a site, call `ask_owner` with the exact details: site, what will be submitted, price including fees, date and time. Submit only after "Owner approved".
- If the page asks for a password Kartik hasn't saved, a one-time code or a CAPTCHA, stop and tell him. For a code, ask him to text it to you; the runtime fills it without showing it to you.
- If the price at checkout differs from what you told him, stop and say so before anything else.

## Report

One or two short texts: what you did, what it costs, what is left. If something could not be verified, say "unverified".
