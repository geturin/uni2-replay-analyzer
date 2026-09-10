// All statistics describe the imported replay sample from the local player's
// perspective. Unknown outcomes never enter a win-rate denominator. Repeated
// games against the same person are not independent population observations.

export function ownerContext(match, ownerId) {
  if (ownerId === null || ownerId === undefined || String(ownerId) === "0") return null;
  const p1IsOwner = match?.p1?.accountId != null && String(match.p1.accountId) === String(ownerId);
  const p2IsOwner = match?.p2?.accountId != null && String(match.p2.accountId) === String(ownerId);
  if (p1IsOwner === p2IsOwner || !match.p1 || !match.p2) return null;
  const ownerSide = p1IsOwner ? "p1" : "p2";
  const opponentSide = p1IsOwner ? "p2" : "p1";
  const winner = match.result?.winner;
  const won = winner === "p1" || winner === "p2" ? winner === ownerSide : null;
  return {
    ownerSide, opponentSide, owner: match[ownerSide], opponent: match[opponentSide],
    won, result: won === null ? "unknown" : won ? "win" : "loss",
  };
}

/** Date filters use the calendar date saved in the replay, with both ends inclusive. */
export function filterMatches(matches, ownerId, filters = {}) {
  const query = String(filters.search || "").trim().toLocaleLowerCase();
  const opponentId = String(filters.opponent || "").trim();
  const from = validDateKey(filters.from);
  const to = validDateKey(filters.to);
  const filtered = matches.filter((match) => {
    const context = ownerContext(match, ownerId);
    if (!context) return false;
    const { owner, opponent, ownerSide, result } = context;
    const searchable = [opponent.steamName, opponent.replayLabel, opponent.accountId, opponent.steamId64]
      .filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filters.character && filters.character !== "all" && opponent.character !== filters.character) return false;
    if (filters.ownCharacter && filters.ownCharacter !== "all" && owner.character !== filters.ownCharacter) return false;
    if (filters.result && filters.result !== "all" && result !== filters.result) return false;
    if (filters.side && filters.side !== "all" && ownerSide !== filters.side) return false;
    if (opponentId && opponentId !== "all" && ![opponent.accountId, opponent.steamId64]
      .some((id) => id !== null && id !== undefined && String(id) === opponentId)) return false;
    if (filters.rounds && filters.rounds !== "all" && String(match.roundCount) !== String(filters.rounds)) return false;
    if (filters.opening === "won" && match.result?.firstRoundWinner !== ownerSide) return false;
    if (filters.opening === "lost" && (!["p1", "p2"].includes(match.result?.firstRoundWinner) || match.result.firstRoundWinner === ownerSide)) return false;
    if (filters.trajectory === "comeback" && !(match.result?.trajectory === "reverse-sweep" && result === "win")) return false;
    if (filters.trajectory === "reversed" && !(match.result?.trajectory === "reverse-sweep" && result === "loss")) return false;
    if (filters.trajectory === "sweep" && !(match.result?.trajectory === "sweep" && result === "win")) return false;
    if (filters.finish) {
      const matched = match.rounds?.some((round) => round.result?.source === "next-round-state"
        && (filters.finish === "perfect-win" ? round.result.finish?.type === "perfect" && round.result.winner === ownerSide
          : filters.finish === "perfect-loss" ? round.result.finish?.type === "perfect" && round.result.winner === context.opponentSide
          : filters.finish === "timeup" ? round.result.finish?.type === "timeup" : false));
      if (!matched) return false;
    }
    if (from || to) {
      const date = matchDateKey(match);
      if (!date || (from && date < from) || (to && date > to)) return false;
    }
    if (filters.duration && filters.duration !== "all") {
      const seconds = durationOf(match);
      if (seconds === null) return false;
      if (filters.duration === "short" && seconds >= 90) return false;
      if (filters.duration === "medium" && (seconds < 90 || seconds >= 150)) return false;
      if (filters.duration === "long" && seconds < 150) return false;
    }
    return true;
  });
  return filtered.sort((a, b) => {
    if (filters.sort === "duration") {
      const difference = (durationOf(b) ?? -1) - (durationOf(a) ?? -1);
      if (difference) return difference;
    }
    return compareTime(a, b, filters.sort === "oldest" ? 1 : -1);
  });
}

export function summarize(matches, ownerId) {
  const results = matches.map((match) => {
    const context = ownerContext(match, ownerId);
    return context ? { match, won: context.won, ownerSide: context.ownerSide } : null;
  }).filter(Boolean).sort((a, b) => compareTime(a.match, b.match, 1));
  const matchesList = results.map(({ match }) => match);
  const counts = resultCounts(results);
  const opponents = new Set();
  const characterCounts = new Map();
  let durationSeconds = 0;
  let durationSamples = 0;
  let rounds = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let currentStreak = { won: null, count: 0 };
  for (const { match, won } of results) {
    const context = ownerContext(match, ownerId);
    const identity = playerIdentity(context.opponent);
    if (identity) opponents.add(identity);
    const character = context.owner.character;
    if (character) characterCounts.set(character, (characterCounts.get(character) || 0) + 1);
    const seconds = durationOf(match);
    if (seconds !== null) { durationSeconds += seconds; durationSamples += 1; }
    if (Number.isInteger(match.roundCount) && match.roundCount > 0) rounds += match.roundCount;
    // A missing outcome interrupts a streak; skipping it would invent continuity.
    currentStreak = won === null ? { won: null, count: 0 }
      : { won, count: currentStreak.won === won ? currentStreak.count + 1 : 1 };
    if (won === true) longestWin = Math.max(longestWin, currentStreak.count);
    if (won === false) longestLoss = Math.max(longestLoss, currentStreak.count);
  }
  const knownResults = results.filter(({ won }) => won !== null);
  const recent = resultCounts(knownResults.slice(-10));
  const previous = resultCounts(knownResults.slice(-20, -10));
  return {
    ...counts, total: counts.matches, durationSeconds, durationSamples,
    averageSeconds: durationSamples ? durationSeconds / durationSamples : null,
    rounds, opponents: opponents.size,
    characters: [...characterCounts].map(([character, count]) => ({ character, count }))
      .sort((a, b) => b.count - a.count || a.character.localeCompare(b.character)),
    matchesList, results, recent, previous,
    recentDelta: recent.known === 10 && previous.known === 10 ? recent.winRate - previous.winRate : null,
    currentStreak, longestWin, longestLoss,
  };
}

/** Gameplay-facing statistics from confirmed scoreboard transitions. */
export function roundStats(matches, ownerId) {
  const result = { wins: 0, losses: 0, draws: 0, unknown: 0, observed: 0, inferred: 0,
    openingWon: { matches: 0, wins: 0, losses: 0 }, openingLost: { matches: 0, wins: 0, losses: 0 },
    comebackWins: 0, comebackLosses: 0, sweeps: 0, coherentFt2Matches: 0,
    perfectWins: 0, perfectLosses: 0, timeups: 0, knownFinishes: 0, totalRounds: 0 };
  for (const match of matches) {
    const context=ownerContext(match,ownerId);
    if (!context) continue;
    const first=match.result?.firstRoundWinner;
    if (["p1","p2"].includes(first) && context.won !== null) {
      const group=first===context.ownerSide ? result.openingWon : result.openingLost;
      group.matches++; group[context.won ? "wins" : "losses"]++;
    }
    if (match.result?.sequenceComplete) result.coherentFt2Matches++;
    if (match.result?.trajectory==="reverse-sweep" && context.won !== null) result[context.won ? "comebackWins":"comebackLosses"]++;
    if (match.result?.trajectory==="sweep" && context.won === true) result.sweeps++;
    for (const round of match.rounds || []) {
      result.totalRounds++;
      const detail=round.result;
      if (!detail || !["next-round-state","match-winner-ft2"].includes(detail.source)) { result.unknown++; continue; }
      if (detail.outcome==="draw") result.draws++;
      else if (["p1","p2"].includes(detail.winner)) result[detail.winner===context.ownerSide ? "wins":"losses"]++;
      else { result.unknown++; continue; }
      result[detail.source==="next-round-state" ? "observed":"inferred"]++;
      if (detail.source==="next-round-state" && ["ko","perfect","timeup","double-ko"].includes(detail.finish?.type)) {
        result.knownFinishes++;
        if (detail.finish.type==="perfect" && detail.winner) result[detail.winner===context.ownerSide ? "perfectWins":"perfectLosses"]++;
        if (detail.finish.type==="timeup") result.timeups++;
      }
    }
  }
  return result;
}

/** Sparse own-character × opponent-character cells; rates and intervals are percentages. */
export function matchupStats(matches, ownerId, { minSample = 10 } = {}) {
  const groups = new Map();
  for (const match of matches) {
    const context = ownerContext(match, ownerId);
    if (!context) continue;
    const ownCharacter = context.owner.character || "Unknown";
    const character = context.opponent.character || "Unknown";
    const key = JSON.stringify([ownCharacter, character]);
    if (!groups.has(key)) groups.set(key, {
      ownCharacter, character, opponentCharacter: character,
      results: [], opponents: new Set(), knownOpponents: new Set(), matchesList: [],
    });
    const group = groups.get(key);
    group.results.push({ won: context.won });
    group.matchesList.push(match);
    const identity = playerIdentity(context.opponent);
    if (identity) {
      group.opponents.add(identity);
      if (context.won !== null) group.knownOpponents.add(identity);
    }
  }
  return [...groups.values()].map((group) => {
    const counts = resultCounts(group.results);
    return {
      ownCharacter: group.ownCharacter, character: group.character, opponentCharacter: group.character,
      ...counts, interval: wilsonInterval(counts.wins, counts.known),
      lowSample: counts.known < minSample,
      opponents: group.opponents.size, knownOpponents: group.knownOpponents.size,
      matchesList: [...group.matchesList].sort((a, b) => compareTime(a, b, -1)),
    };
  }).sort((a, b) => b.matches - a.matches || a.ownCharacter.localeCompare(b.ownCharacter)
    || a.character.localeCompare(b.character));
}

/**
 * Split the complete dataset before applying UI filters. Consecutive saved
 * timestamps over 30 minutes apart begin a new session; exactly 30 does not.
 * These are browsing groups, not a claim that a lobby or set was recorded.
 */
export function sessionStats(matches, ownerId, { gapMinutes = 30 } = {}) {
  const gap = Number.isFinite(gapMinutes) && gapMinutes > 0 ? gapMinutes * 60_000 : 30 * 60_000;
  const ordered = matches.filter((match) => ownerContext(match, ownerId))
    .sort((a, b) => compareTime(a, b, 1));
  const groups = [];
  for (const match of ordered) {
    const time = timestampOf(match);
    const previous = groups.at(-1);
    // Undated records cannot establish a time gap and each get their own group.
    if (!previous || time === null || previous.end === null || time - previous.end > gap) {
      groups.push({ start: time, end: time, matchesList: [match] });
    } else {
      previous.end = time;
      previous.matchesList.push(match);
    }
  }
  return groups.map((group, index) => ({
    id: `session-${group.start ?? "undated"}-${group.matchesList[0].slot ?? index}`,
    start: group.start, end: group.end,
    ...summarize(group.matchesList, ownerId),
  })).sort((a, b) => {
    if (a.start === null) return b.start === null ? 0 : 1;
    if (b.start === null) return -1;
    return b.start - a.start;
  });
}

/** Review candidates are ordered by saved losses, then observed win rate. */
export function reviewPriorities(matches, ownerId, { minKnown = 10, minOpponents = 3, limit = 4 } = {}) {
  return matchupStats(matches, ownerId, { minSample: minKnown })
    .filter((cell) => cell.known >= minKnown && cell.knownOpponents >= minOpponents && cell.losses > 0)
    .sort((a, b) => b.losses - a.losses || a.winRate - b.winRate || b.known - a.known
      || a.ownCharacter.localeCompare(b.ownCharacter) || a.character.localeCompare(b.character))
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((cell) => ({
      ...cell,
      reason: `${cell.known} 场已知赛果中有 ${cell.losses} 场败局，涉及 ${cell.knownOpponents} 位对手。`,
    }));
}

// Wilson's 95% interval is a sample-size aid, not a prediction of future wins
// or a correction for selection bias / repeated-opponent dependence.
export function wilsonInterval(wins, known) {
  if (!Number.isInteger(known) || known <= 0 || !Number.isInteger(wins) || wins < 0 || wins > known) return null;
  const z = 1.959963984540054;
  const p = wins / known;
  const denominator = 1 + z * z / known;
  const center = (p + z * z / (2 * known)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / known + z * z / (4 * known * known)) / denominator;
  return { low: Math.max(0, center - margin) * 100, high: Math.min(1, center + margin) * 100 };
}

function resultCounts(results) {
  const wins = results.filter(({ won }) => won === true).length;
  const losses = results.filter(({ won }) => won === false).length;
  const known = wins + losses;
  return { matches: results.length, wins, losses, known, unknown: results.length - known,
    winRate: known ? 100 * wins / known : null };
}

function playerIdentity(player) {
  // Prefer the account ID so the same opponent with/without hydrated Steam
  // metadata cannot count as two people. Never group identities by nickname.
  if (player?.accountId && String(player.accountId) !== "0") return `account:${player.accountId}`;
  return player?.steamId64 ? `steam:${player.steamId64}` : null;
}

function durationOf(match) {
  if (Number.isFinite(match.durationSeconds) && match.durationSeconds >= 0) return match.durationSeconds;
  return Number.isFinite(match.totalFrames) && match.totalFrames >= 0 ? match.totalFrames / 60 : null;
}

function timestampOf(match) {
  return Number.isFinite(match.timestamp?.sortValue) ? match.timestamp.sortValue : null;
}

function compareTime(a, b, direction) {
  const aTime = timestampOf(a);
  const bTime = timestampOf(b);
  if (aTime === null) return bTime === null ? 0 : 1;
  if (bTime === null) return -1;
  return (aTime - bTime) * direction;
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

function matchDateKey(match) {
  const { year, month, day } = match.timestamp || {};
  if (![year, month, day].every(Number.isInteger)) return null;
  return validDateKey(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}
