---
name: browser-errands
description: Do a task on a website for Kartik, such as filling a form, checking a booking page, comparing prices or getting to checkout. Use when no app tool covers the job and the site needs clicking. Drive agent-browser by accessibility snapshot, stop before any submit or payment, and get Kartik's thumbs-up first.
---
# Browser errands

You drive a real Chrome on the Sprite through Peril's `browser_*` tools. Logins Kartik set up once are saved in the browser profile.

## Loop

1. `browser_open` the page, then `browser_snapshot`. Each element has a ref like `@e3`.
2. Act on a ref with `browser_click`, `browser_fill` or `browser_press`. A click fails loudly when something covers the element (a cookie banner, a popup). Dismiss it, snapshot again, retry.
3. After every navigation or change, snapshot again before using refs. Old refs are stale.
4. Read the result off the page. Never assume a click worked.

## Stop points

- To submit a form, book, pay or send anything on a site, call `browser_submit` with the ref and `what`: site, what happens, price including fees, date and time. It waits for Kartik's 👍. `browser_click` refuses buttons like these.
- If the page asks for a one-time code, call `await_code`. Kartik texts the code to Peril, and you call `fill_code` with the input's ref. You never see the code.
- If the page asks for a password Kartik hasn't saved, or shows a CAPTCHA, stop and tell him.
- If the price at checkout differs from what you told him, stop and say so before anything else.

## Report

One or two short texts: what you did, what it costs, what is left. If something could not be verified, say "unverified".
