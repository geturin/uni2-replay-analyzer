// Confirmed native capture/restore: state+0xC/+0x4C0 hold each side's
// cumulative victory-mark count; +0x10/+0x4C4 hold ten mark slots.
// A snapshot belongs to the START of its round, not to that round's end.
export function decodeVictoryMark(rawMark) {
  const type = ({ 1: "ko", 2: "ko", 3: "perfect", 4: "timeup", 6: "double-ko" })[rawMark] || "unknown";
  return { type, rawMark: Number.isInteger(rawMark) ? rawMark : null, source: type === "unknown" ? null : "native-victory-mark" };
}

const validState = (state) => state?.valid === true
  && [state.scoreP1, state.scoreP2].every((v) => Number.isInteger(v) && v >= 0 && v <= 10)
  && state.winMarksP1?.length === state.scoreP1 && state.winMarksP2?.length === state.scoreP2;
const scores = (state) => [state.scoreP1, state.scoreP2];
const preservesHistory = (before, after) => ["winMarksP1", "winMarksP2"]
  .every((key) => before[key].every((mark, i) => mark === after[key][i]));

/** Derive only transitions justified by two snapshots; FT2's final round is labelled separately. */
export function deriveRoundResults(rounds, matchWinner) {
  const warnings = [];
  const results = rounds.map((round, index) => {
    const before = round.startState, after = rounds[index + 1]?.startState;
    const unknown = { winner: null, outcome: "unknown", scoreBefore: validState(before) ? scores(before) : null,
      scoreAfter: null, source: null, finish: null };
    if (!validState(before)) { warnings.push(`第 ${index + 1} 回合胜利标记计数无效。`); return unknown; }
    if (!after) return unknown;
    if (!validState(after) || !preservesHistory(before, after)) {
      warnings.push(`第 ${index + 1} 回合前后的胜利标记记录不连续。`); return unknown;
    }
    const delta = [after.scoreP1-before.scoreP1, after.scoreP2-before.scoreP2];
    let winner = null;
    if (delta[0] === 1 && delta[1] === 0) winner = "p1";
    if (delta[0] === 0 && delta[1] === 1) winner = "p2";
    if (winner) {
      const rawMark = winner === "p1" ? after.winMarksP1[before.scoreP1] : after.winMarksP2[before.scoreP2];
      return { winner, outcome: "win", scoreBefore: scores(before), scoreAfter: scores(after), source: "next-round-state", finish: decodeVictoryMark(rawMark) };
    }
    const mark1 = after.winMarksP1[before.scoreP1], mark2 = after.winMarksP2[before.scoreP2];
    if (delta.every((v) => v === 1) && mark1 === mark2 && [4,6].includes(mark1)) {
      return { winner: null, outcome: "draw", scoreBefore: scores(before), scoreAfter: scores(after), source: "next-round-state", finish: decodeVictoryMark(mark1) };
    }
    warnings.push(`第 ${index + 1} 回合胜利标记变化 ${delta.join("/")} 不属于已验证的单局结果。`);
    return unknown;
  });

  const first = rounds[0]?.startState, last = rounds.at(-1)?.startState;
  const winnerIndex = matchWinner === "p1" ? 0 : matchWinner === "p2" ? 1 : -1;
  const knownPrefix = results.slice(0,-1).every((r) => r.outcome === "win" && r.source === "next-round-state");
  let finalScore = null;
  // The final snapshot precedes the final fight. Do not invent its finishing
  // move, HP, duration or resources. Only a coherent standard FT2 can use the
  // saved match winner to infer one additional victory mark.
  if ([2,3].includes(rounds.length) && winnerIndex >= 0 && validState(first) && validState(last)
      && first.scoreP1 === 0 && first.scoreP2 === 0 && knownPrefix
      && scores(last)[winnerIndex] === 1 && scores(last)[1-winnerIndex] <= 1
      && last.scoreP1+last.scoreP2 === rounds.length-1) {
    finalScore = scores(last);
    finalScore[winnerIndex]++;
    results[results.length-1] = { winner: matchWinner, outcome: "win", scoreBefore: scores(last), scoreAfter: finalScore,
      source: "match-winner-ft2", finish: null };
  }
  const complete = finalScore !== null;
  const firstRoundWinner = validState(first) && first.scoreP1 === 0 && first.scoreP2 === 0 ? results[0]?.winner || null : null;
  const winnerRoundPath = complete ? results.map((r) => r.winner === matchWinner ? "W" : "L").join("") : null;
  const trajectory = winnerRoundPath === "WW" ? "sweep" : winnerRoundPath === "LWW" ? "reverse-sweep"
    : winnerRoundPath === "WLW" ? "split-win" : null;
  return { results, warnings, scoreP1: finalScore?.[0] ?? null, scoreP2: finalScore?.[1] ?? null,
    scoreSource: complete ? "round-state-plus-match-winner" : null,
    sequenceComplete: complete, firstRoundWinner, winnerRoundPath, trajectory,
    knownRoundResults: results.filter((r) => r.outcome !== "unknown").length,
    observedFinishes: results.filter((r) => r.finish?.type && r.finish.type !== "unknown").length };
}
