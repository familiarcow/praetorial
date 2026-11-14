# Write a custom bet with your own AI

Praetorial's "Anything else" bet is settled by an AI judge that reads public web pages after the deadline. The fields have to be
exact, so the easiest way to fill them in is to let your own AI (ChatGPT, Claude, or any agent) do it:

1. Copy the prompt below (or press **Copy prompt** in the bet form).
2. Paste it into your AI and replace `<<< DESCRIBE YOUR BET HERE >>>` with your bet, in your own words.
3. Answer any questions it asks. It replies with a block of JSON.
4. In the bet form, paste that JSON into **Paste from your AI** and press **Fill the form**. The form fills in and runs the
   same checks as typing it yourself; fix anything it flags, then press Next.

This page is also on the Praetorial site at `/guide/custom-bet` (no login needed); the bet form links to it.

## The prompt

```text
You are helping me set up a bet on Praetorial. An AI judge will settle it by reading public web pages after the deadline, so every part must be checkable by a stranger.

My bet, in my own words:
<<< DESCRIBE YOUR BET HERE >>>

Turn it into a bet that follows these rules:
1. Claim: one sentence that will be clearly true or false, naming who or what, what must happen, and the date. No opinions ("best", "popular"), no "soon" or "next week".
2. Question: one YES or NO question the judge answers. YES means the claim happened.
3. Deadline: one exact date and time in UTC, written like 2027-12-31T23:59Z. It must be in the future.
4. Sources: at least two public web pages from different websites that will report the result. Use public sources neither of us can edit: no personal accounts, blogs or pages either bettor controls.
5. Evidence: the judge only counts what those public sources publish before the deadline (and up to 7 days after it, if they report late). Say in "what_counts" anything that should or should not count, like "a preorder does not count".
6. If the bet is about something I or the other bettor do, rewrite it as something an outside source reports, or tell me it cannot be judged.

If anything is unclear, ask me first. When it is clear, reply with only the JSON below, no other text:

{
  "claim": "one sentence, with the date",
  "question": "one YES or NO question",
  "deadline_utc": "YYYY-MM-DDTHH:MMZ",
  "sources": [
    { "name": "site name", "url": "https://..." },
    { "name": "another site", "url": "https://..." }
  ],
  "what_counts": ["optional rule, one per item"],
  "can_settle_early": true
}

"can_settle_early" is true if the bet can be settled as soon as it happens, false if only at the deadline.
```

## The fields

| Field | Required | What it is |
| --- | --- | --- |
| `claim` | yes | One sentence that will be clearly true or false, with the date. |
| `question` | no | The one YES or NO question the judge answers. Left out: the judge checks the claim as written. |
| `deadline_utc` | yes | The exact deadline in UTC, like `2027-12-31T23:59Z`. Must be in the future. |
| `sources` | yes | At least two public pages from different websites, each `{ "name", "url" }`. Neither bettor may be able to edit them. |
| `what_counts` | no | A list of short rules about what does or doesn't count. |
| `can_settle_early` | no | `true` (default): settles as soon as it happens. `false`: only at the deadline. |

Anything else in the JSON is ignored. If a required field is missing or the JSON is broken, the form says so and nothing is filled in.

## What the judge counts as evidence

Only what the listed public sources publish about the claim, before the deadline (late reports are accepted for 7 days after it).
Personal accounts or pages either bettor controls do not count, and an opinion cannot be judged.

## Worked examples

### 1. A product launch

You tell your AI:

> I bet Apple sells a foldable iPhone before the end of 2027.

It answers:

```json
{
  "claim": "Apple makes a foldable iPhone available to buy in the US by December 31, 2027.",
  "question": "Did Apple make a foldable iPhone available to buy in the US by December 31, 2027?",
  "deadline_utc": "2027-12-31T23:59Z",
  "sources": [
    {
      "name": "Apple Newsroom",
      "url": "https://www.apple.com/newsroom/"
    },
    {
      "name": "Reuters",
      "url": "https://www.reuters.com/technology/"
    }
  ],
  "what_counts": [
    "A preorder or an announcement alone does not count; it must be on sale in the US."
  ],
  "can_settle_early": true
}
```

### 2. An interest-rate decision

You tell your AI:

> My friend thinks the Fed won't cut rates in the first half of 2027. I think it will.

It answers:

```json
{
  "claim": "The US Federal Reserve announces a cut to the federal funds target range between January 1, 2027 and June 30, 2027.",
  "question": "Did the Federal Reserve announce a cut to the federal funds target range between January 1, 2027 and June 30, 2027?",
  "deadline_utc": "2027-06-30T23:59Z",
  "sources": [
    {
      "name": "Federal Reserve",
      "url": "https://www.federalreserve.gov/newsevents/pressreleases.htm"
    },
    {
      "name": "Associated Press",
      "url": "https://apnews.com/hub/federal-reserve"
    }
  ],
  "what_counts": [
    "Only a decision announced by the Federal Open Market Committee counts.",
    "A cut of any size counts."
  ],
  "can_settle_early": true
}
```

### 3. A space mission

You tell your AI:

> Bet: NASA lands astronauts on the Moon with Artemis by the end of 2028.

It answers:

```json
{
  "claim": "NASA's Artemis program lands at least one astronaut on the surface of the Moon by December 31, 2028.",
  "question": "Did a NASA Artemis mission land at least one astronaut on the surface of the Moon by December 31, 2028?",
  "deadline_utc": "2028-12-31T23:59Z",
  "sources": [
    {
      "name": "NASA",
      "url": "https://www.nasa.gov/humans-in-space/artemis/"
    },
    {
      "name": "Associated Press",
      "url": "https://apnews.com/hub/space-exploration"
    }
  ],
  "what_counts": [
    "The landing must be crewed; an uncrewed lander does not count."
  ],
  "can_settle_early": false
}
```
