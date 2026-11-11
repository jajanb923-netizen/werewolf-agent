# Werewolf agent — make.fun bounty `werewolf-agent-01`

A deterministic, no-model-call Werewolf agent for the make.fun bounty
[Build the best Werewolf agent](https://make.fun/bounty/werewolf-agent-01)
($500 total, 20 paid places, 1st $100; a place needs a mean score above the
house baseline, Claude Opus 5.5 asked plainly).

## What it does

`main.ts` (Node 22, standard library only) plays one seat in 30 games of
8-player Werewolf against seven house players (claude-haiku-5-5, low effort).
It makes **no model calls at all** — every decision is pure logic over the
env's view of that game — so a trial costs $0 of inference and is fully
deterministic given the views and `MAKEFUN_TRIAL_SEED`.

- Rebuilds the game state from the view's public log on every decision.
- Suspicion scoring from day votes (who voted for revealed villagers vs
  revealed wolves, who voted together), speeches (accusations, defences,
  role claims), night deaths (who the dead had accused), and the seer's own
  inspections. A second seer claim is certain proof when I am the seer.
- Seer: inspect the top suspect each night; reveal a found wolf at once in
  debate, naming the night inspected.
- Doctor: protect the credible seer claimant, else the loudest wolf-accuser.
- Villager: accuse the top suspect with cited evidence, consolidate the vote
  on a suspect instead of splitting it, abstain on day 1 with no evidence.
- Werewolf: kill by agreement — copy the partner's night vote when voting
  second; when voting first, pick the obvious target (credible seer claimant,
  then the loudest accuser of me or my partner). By day, blend in, push
  suspicion onto villagers using their own voting record, deflect from my
  partner, never vote for my partner.
- Statements are short and factual, citing names, votes and deaths.

## Run locally

From inside the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/werewolf-agent --driver process
```

## Status

Built 2026-11-11, not submitted. Local test results (kit env server +
deterministic stub house players, since `grade-local` refuses to run
without a provider API key for the house seats — see Limits below):
all 3 practice trials finished 30/30 games in ~5 s each, 0 fallbacks,
0 house errors. Scores: trial-0 **467** (wolf 933, village 0),
trial-1 **533** (wolf 867, village 200), trial-2 **533** (wolf 1000,
village 67); mean **511**. Re-running trial-0 twice with the same seed
produced byte-identical `state.json` exports (deterministic replay).

## Limits (honest)

- The stub house players vote/speak by seeded hash, not by reasoning, so
  these scores do **not** predict the score against the real
  claude-haiku-5-5 house players. In stub world the other six villagers
  vote almost at random, which is why village win rates are low; the real
  house players read statements and vote on reasoning, so the agent's
  evidence-citing speeches should matter more there — but that is
  untested here, because no Anthropic/OpenAI API key was available to
  run the real house players locally.
- The house baseline (claude-opus-5-5, plainly asked) could not be run
  for comparison for the same reason: it needs a provider key. So whether
  this entry beats the baseline — the prize condition — is unknown.
- Wolf play is the strong side in these tests (933–1000); village play
  is the weak side (0–200). The entry's prize chances hinge on the
  village half against the real house players.

Submission still needs, from the user: a make.fun account (Solana keypair
+ API key, or a connected account), a public GitHub repository created
after the competition opened (the user's account is jajanb923-netizen,
per memory) — or a source bundle as the no-GitHub fallback — and the
AI-transcript bundle for the sessions that built this entry. No model
API key is needed — the entry makes no model calls.
