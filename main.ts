// werewolf-agent-01 entry: a deterministic, no-model-call Werewolf agent.
//
// Plays one seat in 30 games of 8-player Werewolf against seven house players
// (claude-haiku-5-5, low effort). No model calls at all: every decision is pure
// logic over the env's view of that game, so the trial costs $0 of inference
// and is deterministic given the views and MAKEFUN_TRIAL_SEED.
//
// How it plays:
//   - Rebuilds the whole game state from the view's public log on every
//     decision (no cross-decision memory, so replay is trivially identical).
//   - Suspicion scoring: day votes (who voted for revealed villagers vs
//     revealed wolves, who voted together), speeches (accusations, defences,
//     role claims), night deaths (who the dead had accused), and the seer's
//     own inspections. A second werewolf claim is certain proof when I am
//     the seer; a claim that contradicts a revealed role is strong proof.
//   - Seer: inspect the top suspect each night; reveal a found wolf at once
//     in debate, naming the night inspected, and vote for it.
//   - Doctor: protect the credible seer claimant, else the loudest
//     wolf-accuser; never reveal the role.
//   - Villager: accuse the top suspect with cited evidence, vote to
//     consolidate a plurality on a suspect (never split the vote when a
//     suspect already leads), abstain on day 1 with no evidence.
//   - Werewolf: kill by agreement — copy the partner's night vote when I vote
//     second (the partner sees mine when I vote first, so I pick the obvious
//     target: a credible seer claimant, then the loudest accuser of me or my
//     partner). By day, blend in: push suspicion onto villagers using their
//     own voting record, deflect from my partner, never vote for my partner,
//     and join the leading villager bandwagon.
//   - Statements are short, factual and cite names, votes and deaths, so the
//     house players can follow the reasoning.
//
// Determinism: tie-breaks come only from a seeded hash of
// MAKEFUN_TRIAL_SEED + game + label. No wall clock, no Math.random, no
// network except the env at MAKEFUN_ENV_URL. Decisions are answered
// sequentially, one game at a time, in the order /observe lists them.
//
// Run by the grader as `node /bot/main.ts` with this directory at /bot;
// Node 22 standard library only (global fetch).

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: Role | null;
}

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  text?: string | null;
  target?: Seat | null;
  died?: Seat | null;
  role?: Role | null;
  order?: Seat[];
  round?: number;
  tally?: { seat: Seat; votes: number }[];
  winner?: string | null;
  [k: string]: unknown;
}

interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: Role;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat | null } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: { winner: string | null } | null;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- seeded hash

/** FNV-1a hash of a string, as an unsigned 32-bit integer. Deterministic. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SEED = process.env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';

/** Deterministic tie-break rank for a seat in a game: lower sorts first. */
function tieKey(game: number, label: string, seat: Seat): number {
  return hash32(`${SEED}|g${game}|${label}|s${seat}`);
}

/** Sort seats by score descending, then by the seeded tie-break. */
function rankByScore(
  scores: Map<Seat, number>,
  seats: Seat[],
  game: number,
  label: string,
): Seat[] {
  return seats.slice().sort((a, b) => {
    const d = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (d !== 0) return d;
    return tieKey(game, label, a) - tieKey(game, label, b);
  });
}

// ---------------------------------------------------------------- view helpers

const nameOf = (view: View, seat: Seat): string =>
  view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

const living = (view: View): Seat[] =>
  view.players.filter((p) => p.alive).map((p) => p.seat);

const roleOf = (view: View, seat: Seat): Role | null =>
  view.players.find((p) => p.seat === seat)?.role ?? null;

const isWolf = (v: View, s: Seat): boolean => v.you.role === 'werewolf' && v.you.partner?.seat === s;

function speeches(view: View): LogEntry[] {
  return view.log.filter((e) => e.kind === 'speech' && typeof e.text === 'string');
}

function low(text: string): string {
  return text.toLowerCase();
}

/** Seats that claimed a role in speech, with the claim text. */
function roleClaims(view: View, roleWord: string): { seat: Seat; text: string }[] {
  const out: { seat: Seat; text: string }[] = [];
  for (const e of speeches(view)) {
    const t = low(e.text as string);
    if (e.seat === undefined) continue;
    if (t.includes(`i am the ${roleWord}`) || t.includes(`i'm the ${roleWord}`) || t.includes(`i am ${roleWord}`)) {
      out.push({ seat: e.seat, text: e.text as string });
    }
  }
  return out;
}

/** Seats a speaker accused of being a wolf, from speech text. */
function accusations(view: View): { seat: Seat; target: Seat; day: number }[] {
  const out: { seat: Seat; target: Seat; day: number }[] = [];
  for (const e of speeches(view)) {
    if (e.seat === undefined || typeof e.text !== 'string') continue;
    const t = low(e.text);
    // "X is a wolf / werewolf", "vote X", "X is the wolf" — match a named player.
    for (const p of view.players) {
      if (p.seat === e.seat) continue;
      const n = low(p.name);
      if (
        t.includes(`${n} is a wolf`) ||
        t.includes(`${n} is a werewolf`) ||
        t.includes(`${n} is the wolf`) ||
        t.includes(`${n} is the werewolf`) ||
        t.includes(`vote ${n}`) ||
        t.includes(`exile ${n}`)
      ) {
        out.push({ seat: e.seat, target: p.seat, day: e.day });
      }
    }
  }
  return out;
}

/** How many speeches each living seat has made (a proxy for influence). */
function speechCounts(view: View): Map<Seat, number> {
  const m = new Map<Seat, number>();
  for (const e of speeches(view)) {
    if (e.seat !== undefined) m.set(e.seat, (m.get(e.seat) ?? 0) + 1);
  }
  return m;
}

/** Votes cast today so far, in order (log entries of the current day). */
function todayVotes(view: View): { seat: Seat; target: Seat | null }[] {
  return view.log
    .filter((e) => e.kind === 'vote' && e.day === view.day && e.seat !== undefined)
    .map((e) => ({ seat: e.seat as Seat, target: e.target ?? null }));
}

/** Current debate round (1 or 2), from how many turns today have been taken. */
function debateRound(view: View): number {
  const debate = [...view.log].reverse().find((e) => e.kind === 'debate' && e.day === view.day);
  const orderLen = debate?.order?.length ?? living(view).length;
  const turns = view.log.filter(
    (e) => e.day === view.day && (e.kind === 'speech' || e.kind === 'pass'),
  ).length;
  return turns < orderLen ? 1 : 2;
}

/** Has this seat already spoken today (so a second statement would repeat)? */
function spokeToday(view: View, seat: Seat): boolean {
  return view.log.some(
    (e) => e.day === view.day && e.kind === 'speech' && e.seat === seat,
  );
}

// ---------------------------------------------------------------- suspicion

interface Analysis {
  scores: Map<Seat, number>;
  knownWolves: Seat[];
  cleared: Set<Seat>;
  seerClaimants: Seat[];
  doctorClaimants: Seat[];
}

/**
 * Suspicion scores for every living seat except me. Higher = more likely a
 * werewolf. Built only from this game's public log + my private results.
 */
function analyze(view: View, game: number): Analysis {
  const me = view.you.seat;
  const scores = new Map<Seat, number>();
  const knownWolves: Seat[] = [];
  const cleared = new Set<Seat>();
  for (const s of living(view)) {
    if (s !== me) scores.set(s, 0);
  }
  const add = (s: Seat, n: number): void => {
    if (scores.has(s)) scores.set(s, (scores.get(s) ?? 0) + n);
  };

  // My own private knowledge.
  if (view.you.role === 'seer' && view.seerResults) {
    for (const r of view.seerResults) {
      if (r.werewolf) {
        knownWolves.push(r.seat);
        add(r.seat, 1000);
      } else {
        cleared.add(r.seat);
        add(r.seat, -1000);
      }
    }
  }
  if (view.you.role === 'werewolf' && view.you.partner) {
    // Never suspect my partner; keep them out of every accusation.
    scores.delete(view.you.partner.seat);
  }

  // Role claims.
  const seerClaims = roleClaims(view, 'seer');
  const doctorClaims = roleClaims(view, 'doctor');
  if (view.you.role === 'seer') {
    // I am the seer, so any other seer claimant is certainly a wolf.
    for (const c of seerClaims) if (c.seat !== me) add(c.seat, 500);
  } else if (seerClaims.length === 1) {
    // Exactly one player claims to be the seer and nobody contradicts
    // them: trust the inspection they named. A wolf claiming seer risks
    // an immediate counter-claim from the real seer, so a lone claim is
    // more often true than not — and it is the village's best lead.
    const c = seerClaims[0]!;
    const t = low(c.text);
    if (/wolf|werewolf/.test(t)) {
      for (const p of view.players) {
        if (p.alive && (t.includes(`inspected ${low(p.name)}`) || t.includes(`checked ${low(p.name)}`) || t.includes(`inspect ${low(p.name)}`))) {
          add(p.seat, 400);
        }
      }
    }
  } else {
    // Two seer claims: at least one lies. Judge each by what it claimed.
    if (seerClaims.length >= 2) {
      for (const c of seerClaims) add(c.seat, 120);
    }
    for (const c of seerClaims) {
      // A claimant whose named inspection target was revealed a wolf is credible.
      const t = low(c.text);
      for (const p of view.players) {
        if (p.role === 'werewolf' && t.includes(low(p.name))) add(c.seat, -150);
        if ((p.role === 'villager' || p.role === 'seer' || p.role === 'doctor') && t.includes(low(p.name)) && /wolf|werewolf/.test(t)) {
          add(c.seat, 250); // claimed a revealed villager is a wolf: lying
        }
      }
    }
  }
  if (view.you.role === 'doctor') {
    for (const c of doctorClaims) if (c.seat !== me) add(c.seat, 500);
  } else if (doctorClaims.length >= 2) {
    for (const c of doctorClaims) add(c.seat, 100);
  }

  // Day votes: who voted for revealed wolves (village-like) vs revealed
  // villagers (wolf-like), and who voted together with a known wolf.
  const voteEntries = view.log.filter((e) => e.kind === 'vote' && e.seat !== undefined);
  for (const e of voteEntries) {
    const voter = e.seat as Seat;
    const target = e.target;
    if (target === undefined || target === null) continue;
    const tr = roleOf(view, target);
    if (tr === 'werewolf') add(voter, -120);
    else if (tr !== null) add(voter, 25); // voted out a revealed villager/seer/doctor
    if (target === me && view.you.role !== 'werewolf') add(voter, 20);
    for (const w of knownWolves) {
      // Voted the same way as a known wolf on the same day.
      const sameDay = voteEntries.some(
        (o) => o.day === e.day && o.seat === w && o.target === target,
      );
      if (sameDay && voter !== w) add(voter, 40);
    }
  }

  // Speeches: accusations, defences, and what the dead said.
  const accs = accusations(view);
  for (const a of accs) {
    const tr = roleOf(view, a.target);
    if (tr === 'werewolf') add(a.seat, -60); // accused a real wolf
    else if (tr !== null) add(a.seat, 20); // accused a revealed villager
    else if (knownWolves.includes(a.target)) add(a.seat, -60);
    if (a.target === me && view.you.role !== 'werewolf') add(a.seat, 15);
  }
  // Defending a revealed wolf in speech.
  for (const e of speeches(view)) {
    const t = low(e.text as string);
    for (const p of view.players) {
      if (p.role !== 'werewolf' || e.seat === undefined) continue;
      const n = low(p.name);
      if (t.includes(`${n} is not a wolf`) || t.includes(`${n} is not a werewolf`) || t.includes(`trust ${n}`) || t.includes(`${n} is innocent`)) {
        add(e.seat, 60);
      }
    }
  }
  // The dead speak truth: a dead seer's accusations, and whoever the night
  // victims had accused (the wolves silence their accusers).
  for (const a of accs) {
    const accuserRole = roleOf(view, a.seat);
    if (accuserRole === 'seer') add(a.target, 80);
  }
  for (const e of view.log.filter((x) => x.kind === 'dawn' && x.died !== undefined && x.died !== null)) {
    const victim = e.died as Seat;
    for (const a of accs) {
      if (a.seat === victim && a.day < e.day) add(a.target, 50);
    }
  }
  // Evasiveness: passing both rounds of a day, repeatedly.
  const passCounts = new Map<Seat, number>();
  for (const e of view.log.filter((x) => x.kind === 'pass' && x.seat !== undefined)) {
    passCounts.set(e.seat as Seat, (passCounts.get(e.seat as Seat) ?? 0) + 1);
  }
  for (const [s, n] of passCounts) if (n >= 2) add(s, 5 * (n - 1));

  // A player exiled as a villager was pushed by wolves; the voters who
  // pushed hardest on them already scored above. Nothing extra here.

  return {
    scores,
    knownWolves: knownWolves.filter((s) => living(view).includes(s)),
    cleared,
    seerClaimants: seerClaims.map((c) => c.seat),
    doctorClaimants: doctorClaims.map((c) => c.seat),
  };
}

/** The village's-eye suspicion (used by a werewolf to pick a plausible victim of suspicion). */
function villageViewScores(view: View, game: number): Map<Seat, number> {
  // Re-run the analysis as if I were a villager: hide my wolf knowledge.
  const copy: View = {
    ...view,
    you: { ...view.you, role: 'villager', partner: null },
    seerResults: null,
    wolfVotes: null,
  };
  return analyze(copy, game).scores;
}

// ---------------------------------------------------------------- decisions

function fold(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

function clamp(text: string, max: number): string {
  const f = fold(text);
  return [...f].length > max ? [...f].slice(0, max).join('').trim() : f;
}

function fallback(p: Pending): Record<string, unknown> {
  return p.decision === 'speak'
    ? { game: p.game, decision: 'speak', pass: true }
    : { game: p.game, decision: p.decision, target: null };
}

function pickTarget(options: Seat[], ranked: Seat[]): Seat | null {
  for (const s of ranked) if (options.includes(s)) return s;
  return options.length > 0 ? options[0]! : null;
}

// ---- night: kill (werewolf)

function decideKill(view: View, game: number, options: Seat[]): Seat | null {
  const partner = view.you.partner;
  // If my partner already voted tonight, agree with them: agreement is
  // what makes a kill happen at all.
  if (partner && view.wolfVotes) {
    const pv = view.wolfVotes.find(
      (v) => v.night === view.day && v.seat === partner.seat && v.target !== null,
    );
    if (pv && pv.target !== null && options.includes(pv.target)) return pv.target;
  }
  // I vote first (or alone): pick the obvious target my partner will agree on.
  const analysis = analyze(view, game);
  const seerClaimants = analysis.seerClaimants.filter((s) => living(view).includes(s));
  if (seerClaimants.length > 0) {
    const ranked = rankByScore(new Map(seerClaimants.map((s) => [s, 1] as [Seat, number])), seerClaimants, game, 'kill-seer');
    const t = pickTarget(options, ranked);
    if (t !== null) return t;
  }
  // The loudest accuser of me or my partner.
  const accs = accusations(view);
  const accCount = new Map<Seat, number>();
  for (const a of accs) {
    if (a.target === view.you.seat || (partner && a.target === partner.seat)) {
      accCount.set(a.seat, (accCount.get(a.seat) ?? 0) + 1);
    }
  }
  if (accCount.size > 0) {
    const ranked = rankByScore(accCount, [...accCount.keys()], game, 'kill-accuser');
    const t = pickTarget(options, ranked);
    if (t !== null) return t;
  }
  // A credible doctor claimant next.
  const docClaimants = analysis.doctorClaimants.filter((s) => living(view).includes(s));
  if (docClaimants.length > 0) {
    const t = pickTarget(options, docClaimants);
    if (t !== null) return t;
  }
  // Otherwise the most talkative living non-wolf (influence), seeded.
  const counts = speechCounts(view);
  const ranked = rankByScore(counts, options, game, 'kill-talk');
  return ranked.length > 0 ? ranked[0]! : null;
}

// ---- night: protect (doctor)

function decideProtect(view: View, game: number, options: Seat[]): Seat | null {
  const analysis = analyze(view, game);
  // Protect a credible seer claimant first.
  const seerClaimants = analysis.seerClaimants.filter((s) => options.includes(s));
  if (seerClaimants.length > 0) return seerClaimants[0]!;
  // Else the loudest accuser of the top suspect (the wolves' likely target).
  const ranked = rankByScore(analysis.scores, living(view).filter((s) => s !== view.you.seat), game, 'protect-suspect');
  const accs = accusations(view);
  const accCount = new Map<Seat, number>();
  for (const a of accs) accCount.set(a.seat, (accCount.get(a.seat) ?? 0) + 1);
  const loud = rankByScore(accCount, [...accCount.keys()].filter((s) => options.includes(s)), game, 'protect-loud');
  if (loud.length > 0 && (accCount.get(loud[0]!) ?? 0) > 0) return loud[0]!;
  if (ranked.length > 0 && options.includes(ranked[ranked.length - 1]!)) {
    // The least suspicious living player is a plausible wolf target too;
    // but the loudest villager is the better guess. Fall through.
  }
  // Seeded pick among the options (night 1, no information yet).
  const sorted = options.slice().sort((a, b) => tieKey(game, 'protect-seed', a) - tieKey(game, 'protect-seed', b));
  return sorted.length > 0 ? sorted[0]! : null;
}

// ---- night: inspect (seer)

function decideInspect(view: View, game: number, options: Seat[]): Seat | null {
  const analysis = analyze(view, game);
  const inspected = new Set((view.seerResults ?? []).map((r) => r.seat));
  const uninspected = options.filter((s) => !inspected.has(s));
  const ranked = rankByScore(analysis.scores, uninspected.length > 0 ? uninspected : options, game, 'inspect');
  return ranked.length > 0 ? ranked[0]! : null;
}

// ---- day: vote

function decideVote(view: View, game: number, options: Seat[]): Seat | null {
  const analysis = analyze(view, game);
  const myRole = view.you.role;

  if (myRole === 'werewolf') {
    // Never vote my partner. Join the leading villager bandwagon, or start
    // one on the villager the village already doubts most.
    const villageScores = villageViewScores(view, game);
    const candidates = options.filter((s) => s !== view.you.partner?.seat);
    const ranked = rankByScore(villageScores, candidates, game, 'wolf-vote');
    const tally = new Map<Seat, number>();
    for (const v of todayVotes(view)) {
      if (v.target !== null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
    }
    // If my partner leads the vote, vote for the villager with the most
    // votes to force a tie (a tie exiles nobody).
    const partnerVotes = view.you.partner ? tally.get(view.you.partner.seat) ?? 0 : 0;
    if (partnerVotes > 0) {
      const byTally = candidates
        .slice()
        .sort((a, b) => (tally.get(b) ?? 0) - (tally.get(a) ?? 0) || tieKey(game, 'wolf-tie', a) - tieKey(game, 'wolf-tie', b));
      if ((tally.get(byTally[0]!) ?? 0) > 0) return byTally[0]!;
    }
    // Otherwise join the villager with the most votes already, if any.
    const byTally = candidates
      .slice()
      .sort((a, b) => (tally.get(b) ?? 0) - (tally.get(a) ?? 0) || tieKey(game, 'wolf-tally', a) - tieKey(game, 'wolf-tally', b));
    if ((tally.get(byTally[0]!) ?? 0) >= 1 && (villageScores.get(byTally[0]!) ?? 0) >= 0) return byTally[0]!;
    return ranked.length > 0 ? ranked[0]! : null;
  }

  // Village side.
  if (analysis.knownWolves.length > 0) {
    const t = pickTarget(options, analysis.knownWolves);
    if (t !== null) return t;
  }
  const ranked = rankByScore(analysis.scores, options.filter((s) => !analysis.cleared.has(s)), game, 'vote');
  if (ranked.length === 0) return null;
  const top = ranked[0]!;
  const topScore = analysis.scores.get(top) ?? 0;

  // Consolidate: if another suspect already has votes and is close in
  // suspicion, join them so the vote is not split.
  const tally = new Map<Seat, number>();
  for (const v of todayVotes(view)) {
    if (v.target !== null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
  }
  let best = top;
  let bestKey = topScore + 40 * (tally.get(top) ?? 0);
  for (const s of ranked.slice(1, 4)) {
    const key = (analysis.scores.get(s) ?? 0) + 40 * (tally.get(s) ?? 0);
    if (key > bestKey) {
      best = s;
      bestKey = key;
    }
  }
  // Day 1 with no real evidence: abstain rather than exile a villager on
  // a guess — unless the village is already consolidating on a suspect, or
  // I have a real suspect, or votes are already landing on me. An
  // abstention never stops an exile (the house players vote), it only
  // removes my one vote — and one vote can break a tie that would exile
  // a villager, including me.
  if (view.day === 1 && topScore < 40) {
    const leader = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (leader && leader[1] >= 2 && (analysis.scores.get(leader[0]) ?? 0) >= 15) return leader[0];
    const votesOnMe = tally.get(view.you.seat) ?? 0;
    if (votesOnMe > 0 || topScore >= 15) return best;
    return null;
  }
  return best;
}

// ---- day: speak

function decideSpeak(view: View, game: number, maxChars: number): string | null {
  const me = view.you.seat;
  const myRole = view.you.role;
  const round = debateRound(view);
  const analysis = analyze(view, game);
  const ranked = rankByScore(
    analysis.scores,
    living(view).filter((s) => s !== me && !analysis.cleared.has(s)),
    game,
    'speak',
  );
  const top = ranked.length > 0 ? ranked[0]! : null;
  const topScore = top !== null ? analysis.scores.get(top) ?? 0 : 0;

  // Seer: reveal a found wolf at once, with the night inspected.
  if (myRole === 'seer' && analysis.knownWolves.length > 0) {
    const wolf = analysis.knownWolves[0]!;
    const res = (view.seerResults ?? []).find((r) => r.seat === wolf && r.werewolf);
    const cleared = [...analysis.cleared]
      .filter((s) => living(view).includes(s))
      .map((s) => nameOf(view, s))
      .slice(0, 2);
    let text = `I am the seer. I inspected ${nameOf(view, wolf)} on night ${res?.night ?? view.day - 1} and they are a werewolf. Vote ${nameOf(view, wolf)} today.`;
    if (cleared.length > 0) text += ` ${cleared.join(' and ')} I checked and they are not wolves.`;
    return clamp(text, maxChars);
  }

  // Round 2: only speak again to defend myself, answer a new claim, or
  // reinforce a found wolf. Otherwise pass — repeating myself helps no one.
  if (round === 2) {
    const accusers = accusations(view)
      .filter((a) => a.target === me && a.day === view.day)
      .map((a) => nameOf(view, a.seat));
    if (accusers.length > 0) {
      const tail =
        top !== null
          ? ` ${nameOf(view, top)} is the one the record points at, not me.`
          : '';
      return clamp(
        `I am not a wolf. ${accusers.join(' and ')} accused me today with no evidence — that is how a wolf starts a bandwagon.${tail}`,
        maxChars,
      );
    }
    if (analysis.knownWolves.length > 0) {
      return clamp(`Vote ${nameOf(view, analysis.knownWolves[0]!)} — I already gave the reason.`, maxChars);
    }
    // A seer claim appeared this round: judge it out loud.
    const claims = analysis.seerClaimants.filter((s) => s !== me && living(view).includes(s));
    if (claims.length > 0 && myRole !== 'seer') {
      const c = claims[claims.length - 1]!;
      return clamp(
        `${nameOf(view, c)} claims to be the seer. If that is true, their target is worth a vote; if two of us claim it, one is lying. Watch who they point at.`,
        maxChars,
      );
    }
    return null;
  }

  // Round 1.
  if (myRole === 'werewolf') {
    const villageScores = villageViewScores(view, game);
    const partner = view.you.partner?.seat;
    const candidates = living(view).filter((s) => s !== me && s !== partner);
    const vranked = rankByScore(villageScores, candidates, game, 'wolf-speak');
    const target = vranked.length > 0 ? vranked[0]! : null;
    // If my partner is being accused, deflect to the villager the village
    // already doubts, without defending my partner directly.
    const partnerAccused = partner !== undefined && accusations(view).some((a) => a.target === partner && a.day === view.day);
    if (partnerAccused && target !== null && target !== partner) {
      return clamp(
        `I am not convinced by the case on ${nameOf(view, partner!)}. ${nameOf(view, target)} has been pushing votes that landed on villagers — that is where I would look.`,
        maxChars,
      );
    }
    if (target !== null) {
      // Cite the target's own voting record when it exists.
      const badVote = view.log.find(
        (e) => e.kind === 'vote' && e.seat === target && e.target !== null && roleOf(view, e.target) !== null && roleOf(view, e.target) !== 'werewolf',
      );
      if (badVote && badVote.target !== null) {
        return clamp(
          `${nameOf(view, target)} voted to exile ${nameOf(view, badVote.target)}, who turned out to be a ${roleOf(view, badVote.target)}. That is a wolf's vote. I vote ${nameOf(view, target)}.`,
          maxChars,
        );
      }
      return clamp(
        `${nameOf(view, target)} has been steering suspicion without evidence while villagers die. I think ${nameOf(view, target)} is a wolf.`,
        maxChars,
      );
    }
    return null;
  }

  // Village side, round 1.
  if (top !== null && topScore >= 40) {
    const badVote = view.log.find(
      (e) => e.kind === 'vote' && e.seat === top && e.target !== null && roleOf(view, e.target) !== null && roleOf(view, e.target) !== 'werewolf',
    );
    if (badVote && badVote.target !== null) {
      return clamp(
        `${nameOf(view, top)} voted to exile ${nameOf(view, badVote.target)}, who was a ${roleOf(view, badVote.target)}. I think ${nameOf(view, top)} is a wolf — vote ${nameOf(view, top)}.`,
        maxChars,
      );
    }
    const acc = accusations(view).find((a) => a.seat === top);
    if (acc) {
      return clamp(
        `${nameOf(view, top)} keeps accusing villagers — they pushed ${nameOf(view, acc.target)} with no evidence. I think ${nameOf(view, top)} is a wolf.`,
        maxChars,
      );
    }
    return clamp(
      `I have been watching ${nameOf(view, top)}: their votes and their words do not add up. I think ${nameOf(view, top)} is a wolf — vote them.`,
      maxChars,
    );
  }
  if (top !== null && topScore >= 15) {
    return clamp(
      `No one is proven yet, but ${nameOf(view, top)} worries me most so far. Watch their next vote and see who they protect with it.`,
      maxChars,
    );
  }
  // Day 1, nothing to go on: say so plainly and ask for evidence, so the
  // house players have something to react to.
  if (view.day === 1) {
    return clamp(
      'No one has shown anything yet. Let us hear everyone out before we vote — a rushed exile on day 1 only helps the wolves.',
      maxChars,
    );
  }
  return null;
}

// ---------------------------------------------------------------- run loop

async function envPost(envUrl: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${envUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function decide(p: Pending, game: number): Record<string, unknown> {
  const view = p.view;
  if (!view.you.alive) return fallback(p);
  switch (p.decision) {
    case 'speak': {
      const text = decideSpeak(view, game, p.max_chars ?? 500);
      return text === null
        ? { game: p.game, decision: 'speak', pass: true }
        : { game: p.game, decision: 'speak', text };
    }
    case 'vote': {
      const target = decideVote(view, game, p.options ?? []);
      return { game: p.game, decision: 'vote', target };
    }
    case 'kill': {
      const target = decideKill(view, game, p.options ?? []);
      return { game: p.game, decision: 'kill', target };
    }
    case 'protect': {
      const target = decideProtect(view, game, p.options ?? []);
      return { game: p.game, decision: 'protect', target };
    }
    case 'inspect': {
      const target = decideInspect(view, game, p.options ?? []);
      return { game: p.game, decision: 'inspect', target };
    }
  }
}

async function run(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  let decisions = 0;
  let fallbacks = 0;
  for (;;) {
    const r = await envPost(envUrl, '/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    // Answer pending decisions sequentially, in the order listed. Each is
    // pure computation over its own game's view, so order across games
    // cannot change any game's outcome.
    for (const p of obs.pending) {
      decisions += 1;
      let act: Record<string, unknown>;
      try {
        act = decide(p, p.game);
      } catch {
        act = fallback(p);
      }
      let posted = await envPost(envUrl, '/act', act);
      if (posted.status !== 200) {
        fallbacks += 1;
        posted = await envPost(envUrl, '/act', fallback(p));
        if (posted.status !== 200) throw new Error(`POST /act answered ${posted.status} for game ${p.game}`);
      }
    }
    // No pending decisions and not done: /observe long-polls, so loop again.
  }
  process.stdout.write(
    `werewolf-agent: ${decisions} decisions, ${fallbacks} fallbacks, trial done\n`,
  );
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
