import { deriveRoundResults } from "./round-results.js";

export const RECORD_SIZE = 0x7a88;
export const EXPECTED_RECORDS = 400;
export const EXPECTED_RAW_SIZE = RECORD_SIZE * EXPECTED_RECORDS;

export const CHARACTER_BY_ID = Object.freeze([
  "Hyde",
  "Linne",
  "Waldstein",
  "Carmine",
  "Orie",
  "Gordeau",
  "Merkava",
  "Vatista",
  "Seth",
  "Yuzuriha",
  "Hilda",
  "Eltnum",
  "Nanase",
  "Byakuya",
  "Akatsuki",
  "Chaos",
  "Wagner",
  "Enkidu",
  "Londrekia",
  "Tsurugi",
  "Uzuki",
  "Mika",
  "Kaguya",
  "Kuon",
  "Phonon",
  "Ogre",
  "Izumi",
]);

const MAGIC = "MBTLReplayFile";
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_SIZE = 16 * 1024 * 1024;
const ROUND_HEADER_SIZE = 0x8c;
const ROUND_STATE_SIZE = 0xb90;
const INPUT_TRACK_COUNT = 4;
const textDecoder = new TextDecoder("shift_jis", { fatal: false });

export async function parseReplayFile(file, onProgress = () => {}, options = {}) {
  if (!file || file.size === 0) throw new Error("文件为空。请选择 REP-DATA。 ");
  if (file.size > MAX_FILE_SIZE) throw new Error("文件过大，不像有效的 REP-DATA。");

  onProgress("读取文件…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
  let raw = bytes;

  if (gzip) {
    onProgress("解压 gzip 容器…");
    raw = await decompressGzip(bytes);
  }

  if (raw.byteLength > MAX_DECOMPRESSED_SIZE) {
    throw new Error("解压结果超过安全限制，已停止处理。");
  }

  onProgress("解析对局资料与回合状态…");
  const parsed = parseReplayData(raw, options);
  return {
    ...parsed,
    source: {
      fileName: file.name,
      compressed: gzip,
      sourceBytes: bytes.byteLength,
      rawBytes: raw.byteLength,
      lastModified: file.lastModified || null,
    },
  };
}

export function parseReplayData(input, options = {}) {
  const raw = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (raw.byteLength > MAX_DECOMPRESSED_SIZE) throw new Error("数据超过 16 MiB 解析上限。");
  if (raw.byteLength < RECORD_SIZE || raw.byteLength % RECORD_SIZE !== 0) {
    throw new Error(`解压后大小 ${raw.byteLength.toLocaleString()} B 不是 0x7A88 的整数倍。`);
  }

  const recordCapacity = raw.byteLength / RECORD_SIZE;
  const parsedMatches = [];
  const errors = [];
  let emptySlots = 0;

  for (let slot = 0; slot < recordCapacity; slot += 1) {
    const start = slot * RECORD_SIZE;
    try {
      const match = parseRecord(raw.subarray(start, start + RECORD_SIZE), slot);
      if (match) parsedMatches.push(match);
      else emptySlots += 1;
    } catch (error) {
      errors.push({ slot, message: error.message });
    }
  }

  if (!parsedMatches.length) throw new Error("没有找到有效的 MBTLReplayFile 录像记录。");

  parsedMatches.sort((a, b) => b.timestamp.sortValue - a.timestamp.sortValue);
  const ownerCandidates = getOwnerCandidates(parsedMatches);
  const highestFrequency = ownerCandidates[0]?.matches ?? 0;
  const candidates = ownerCandidates.filter((candidate) => candidate.matches === highestFrequency);
  const rounds = parsedMatches.flatMap((match) => match.rounds);
  const dataset = {
    allMatches: parsedMatches,
    ownerCandidates,
    ownerInference: {
      method: "account-frequency",
      ambiguous: candidates.length !== 1,
      frequency: highestFrequency,
      margin: highestFrequency - (ownerCandidates[1]?.matches ?? 0),
      inferredOwnerId: ownerCandidates[0]?.accountId ?? null,
      manuallySelected: false,
    },
    recordCapacity,
    errors,
    quality: {
      validRecords: parsedMatches.length,
      emptySlots,
      invalidSlots: errors.length,
      totalRounds: rounds.length,
      mismatchedRounds: rounds.filter((round) => round.alignmentDelta !== 0).length,
      auxiliaryRounds: rounds.filter((round) => round.tracks.slice(2).some((track) => track.runs > 0)).length,
      warningCount: parsedMatches.reduce((sum, match) => sum + match.warnings.length, 0),
    },
    format: {
      outerVersion: parsedMatches[0]?.formatVersion ?? null,
      buildCode: parsedMatches[0]?.buildCode ?? null,
      recordSize: RECORD_SIZE,
      inputLayout: "four-counted-tracks",
      inputMapping: "unverified",
      durationBasis: "input-duration-at-60hz",
    },
  };
  const selected = selectReplayOwner(dataset, options.ownerId ?? ownerCandidates[0]?.accountId ?? null);
  selected.ownerInference.manuallySelected = options.ownerId !== undefined && options.ownerId !== null;
  return selected;
}

// Keep every structurally valid record so perspective changes need no reread.
export function selectReplayOwner(dataset, accountId) {
  const ownerId = accountId === null ? null : Number(accountId);
  if (ownerId !== null && !dataset.ownerCandidates.some((candidate) => candidate.accountId === ownerId)) {
    throw new Error("所选玩家不在录像数据中。");
  }
  const allMatches = dataset.allMatches.map((match) => ({
    ...match,
    p1: { ...match.p1, isOwner: ownerId !== null && match.p1.accountId === ownerId },
    p2: { ...match.p2, isOwner: ownerId !== null && match.p2.accountId === ownerId },
  }));
  const matches = allMatches.filter(hasRecognizableOwnerSide);
  return {
    ...dataset, allMatches, matches, ownerId,
    skippedUnowned: allMatches.length - matches.length,
    ownerInference: { ...dataset.ownerInference, manuallySelected: true },
  };
}

export function hasRecognizableOwnerSide(match) {
  return Boolean(match.p1.isOwner) !== Boolean(match.p2.isOwner);
}

function parseRecord(bytes, slot) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0x278, MAGIC.length) !== MAGIC) return null;

  const roundCount = view.getUint32(0x354, true);
  const timestamp = readSystemTime(view, 0x112);
  // The native replay-list character filter reads these two symmetric
  // player-structure fields. +0x134 is the stage selection.
  const p1CharId = view.getUint32(0x148, true);
  const p2CharId = view.getUint32(0x1e8, true);
  const p1Id = view.getUint32(0x138, true);
  const p2Id = view.getUint32(0x1d8, true);
  const p1SteamId64 = view.getBigUint64(0x138, true);
  const p2SteamId64 = view.getBigUint64(0x1d8, true);

  if (roundCount === 0) return null;
  if (roundCount > 5) throw new Error("回合数超出已验证范围 1–5。");
  if (!timestamp.valid) throw new Error("录像时间字段不是有效的 SYSTEMTIME。");

  const rounds = parseRounds(view, roundCount);
  const totalFrames = rounds.reduce((sum, round) => sum + round.frames, 0);
  const totalInputRuns = rounds.reduce((sum, round) => sum + round.p1.runs + round.p2.runs, 0);
  const neutralFrames = rounds.reduce(
    (sum, round) => sum + round.p1.neutralFrames + round.p2.neutralFrames,
    0,
  );

  const warnings = rounds.flatMap((round) => round.warnings.map((message) => `第 ${round.index} 回合：${message}`));
  const matchResult = readResultMetadata(view);
  const derived = deriveRoundResults(rounds, matchResult.winner);
  rounds.forEach((round, index) => { round.result = derived.results[index]; });
  warnings.push(...derived.warnings);
  if (!CHARACTER_BY_ID[p1CharId] || !CHARACTER_BY_ID[p2CharId]) warnings.push("包含未映射角色 ID。");
  if (!p1Id && !p2Id) warnings.push("双方均无账号 ID，无法归入账号视角。");
  const formatVersion = view.getUint32(0x000, true);
  const payloadVersion = view.getUint32(0x288, true);
  if (formatVersion !== 5 || payloadVersion !== 0xc0000003) warnings.push("格式标记未在本批真实样本中验证。");

  return {
    slot,
    formatVersion,
    payloadVersion,
    buildCode: view.getUint32(0x004, true),
    metadata: readMatchMetadata(view),
    timestamp,
    roundCount,
    rounds,
    totalFrames,
    durationSeconds: totalFrames / 60,
    totalInputRuns,
    neutralFrames,
    totalInputChanges: rounds.reduce((sum, round) => sum + round.p1.inputChanges + round.p2.inputChanges, 0),
    warnings,
    p1: readPlayer(bytes, "p1", p1Id, p1SteamId64, p1CharId, 0x184),
    p2: readPlayer(bytes, "p2", p2Id, p2SteamId64, p2CharId, 0x224),
    result: { ...matchResult, ...Object.fromEntries(Object.entries(derived).filter(([key]) => !["results", "warnings"].includes(key))) },
  };
}

// Verified save/restore and script consumers; see METADATA_FINDINGS.zh-CN.md.
function readMatchMetadata(view) {
  const modeCode = view.getUint8(0x104);
  const modes = { 0: "local", 100: "ranked", 101: "player", 102: "adhoc", 103: "casual" };
  const stageId = view.getUint32(0x134, true), payloadStageId = view.getUint32(0x2a4, true);
  const musicRaw = view.getUint32(0x2a8, true);
  const major = view.getUint8(4), minorBcd = view.getUint8(5);
  const versionValid = major >= 1 && major <= 99 && (minorBcd >> 4) <= 9 && (minorBcd & 15) <= 9;
  return { modeCode, mode: modes[modeCode] || null,
    battleVersion: versionValid ? `${major}.${minorBcd.toString(16).padStart(2,"0")}` : null,
    battleVersionRaw: [major, minorBcd],
    stageId, payloadStageId, stageConsistent: stageId === payloadStageId,
    musicId: musicRaw <= 0x7fffffff ? musicRaw : null, musicRaw,
    payloadBytes: view.getUint32(0x124, true),
    source: "native-replay-metadata" };
}

function readPlayer(bytes, side, accountId, steamId64, characterId, replayLabelOffset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ripRaw = view.getUint32(side === "p1" ? 0x140 : 0x1e0, true);
  return {
    side,
    accountId,
    // The replay embeds the complete CSteamID value, not merely an inferred ID.
    steamId64: accountId ? String(steamId64) : null,
    // +0x184/+0x224 is a replay label/signature chosen in-game. It is not the
    // player's Steam persona name and must never be presented as one.
    replayLabel: readShiftJis(bytes, replayLabelOffset, 32),
    steamName: null,
    characterId,
    character: CHARACTER_BY_ID[characterId] || `Character ${characterId}`,
    // Native replay rows show RIP only in ranked mode; other modes use placeholders.
    rip: view.getUint8(0x104) === 100 && ripRaw !== 0xffffffff ? ripRaw : null,
    ripRaw,
  };
}

function parseRounds(view, count) {
  const rounds = [];
  let roundOffset = 0x358;

  for (let index = 0; index < count; index += 1) {
    requireRange(view, roundOffset, ROUND_HEADER_SIZE, `第 ${index + 1} 回合头`);
    let cursor = roundOffset + ROUND_HEADER_SIZE;
    const tracks = [];
    for (let trackIndex = 0; trackIndex < INPUT_TRACK_COUNT; trackIndex += 1) {
      const track = readCountedTrack(view, cursor, index + 1, trackIndex + 1);
      tracks.push(track);
      cursor = track.endOffset;
    }
    const suffixOffset = cursor;
    requireRange(view, suffixOffset, ROUND_STATE_SIZE, `第 ${index + 1} 回合 0xB90 数据块`);
    if (view.getUint32(suffixOffset, true) !== ROUND_STATE_SIZE) {
      throw new Error(`第 ${index + 1} 回合第四轨后缺少 0xB90 标记。`);
    }
    const [p1, p2] = tracks;
    const warnings = tracks.flatMap((track) => track.warnings.map((message) => `轨 ${track.index}：${message}`));
    if (p1.frames !== p2.frames) warnings.push("双方输入持续计数不一致。");
    if (!p1.runs || !p2.runs) warnings.push("至少一条玩家轨为空。");
    if (tracks.slice(2).some((track) => track.runs)) warnings.push("存在辅助轨输入，其用途尚未确认。");

    rounds.push({
      index: index + 1,
      offset: roundOffset,
      frames: Math.max(p1.frames, p2.frames),
      alignmentDelta: Math.abs(p1.frames - p2.frames),
      p1,
      p2,
      tracks,
      startState: readRoundStartState(view, suffixOffset),
      randomSeeds: Array.from({ length: 11 }, (_, word) => view.getInt32(roundOffset + word * 4, true)),
      headerWords: Array.from({ length: ROUND_HEADER_SIZE / 4 }, (_, word) => view.getUint32(roundOffset + word * 4, true)),
      stateBlock: { offset: suffixOffset, byteLength: ROUND_STATE_SIZE, decoded: false, partiallyDecoded: true, decodedFields: ["victory-mark-counts", "victory-mark-history", "round-start-exs"] },
      endOffset: suffixOffset + ROUND_STATE_SIZE,
      warnings,
    });
    roundOffset = suffixOffset + ROUND_STATE_SIZE;
  }

  return rounds;
}

function readRoundStartState(view, offset) {
  const scoreP1 = view.getUint32(offset + 0xc, true), scoreP2 = view.getUint32(offset + 0x4c0, true);
  const valid = scoreP1 <= 10 && scoreP2 <= 10;
  return { scoreP1, scoreP2, valid, source: "native-round-start-state",
    winMarksP1: valid ? Array.from({ length: scoreP1 }, (_, i) => view.getUint32(offset + 0x10 + i*4, true)) : [],
    winMarksP2: valid ? Array.from({ length: scoreP2 }, (_, i) => view.getUint32(offset + 0x4c4 + i*4, true)) : [],
    // Native SetSpGauge/GetComboGauge map entity+0xB0; stored at the
    // start of the round. Values are hundredths of one displayed EXS unit.
    exsP1: view.getInt32(offset + 0x974, true), exsP2: view.getInt32(offset + 0x9fc, true),
    exsSource: "native-round-start-sp-gauge" };
}

function readCountedTrack(view, countOffset, roundIndex, trackIndex) {
  requireRange(view, countOffset, 4, `第 ${roundIndex} 回合轨 ${trackIndex} 数量`);
  const runs = view.getUint32(countOffset, true);
  const offset = countOffset + 4;
  const endOffset = offset + runs * 2;
  requireRange(view, offset, runs * 2, `第 ${roundIndex} 回合轨 ${trackIndex} 输入`);
  let frames = 0;
  let neutralFrames = 0;
  let activeRuns = 0;
  let inputChanges = 0;
  let previousMask = null;
  let currentNeutralFrames = 0;
  let longestNeutralFrames = 0;
  let zeroDurationRuns = 0;
  let oversizedDurationRuns = 0;
  const entries = [];
  const bitFrames = Array(8).fill(0);
  const maskHistogram = new Map();

  for (let cursor = offset; cursor < endOffset; cursor += 2) {
    const duration = view.getUint8(cursor);
    const mask = view.getUint8(cursor + 1);
    entries.push({ startFrame: frames, duration, mask });
    if (duration === 0) zeroDurationRuns += 1;
    if (duration > 248) oversizedDurationRuns += 1;
    // A held mask can span multiple 248-frame records. Encoder splits and
    // zero-duration records do not represent a new sustained input.
    if (duration > 0) {
      if (previousMask !== null && previousMask !== mask) inputChanges += 1;
      previousMask = mask;
    }
    frames += duration;
    if (mask === 0) {
      neutralFrames += duration;
      currentNeutralFrames += duration;
      longestNeutralFrames = Math.max(longestNeutralFrames, currentNeutralFrames);
    } else {
      if (duration > 0) currentNeutralFrames = 0;
      activeRuns += 1;
    }
    for (let bit = 0; bit < 8; bit += 1) if (mask & (1 << bit)) bitFrames[bit] += duration;
    maskHistogram.set(mask, (maskHistogram.get(mask) || 0) + duration);
  }
  const warnings = [];
  if (zeroDurationRuns) warnings.push(`包含 ${zeroDurationRuns} 个零持续项，已按数量保留。`);
  if (oversizedDurationRuns) warnings.push(`包含 ${oversizedDurationRuns} 个超出已验证上限 248 的持续项。`);
  return {
    index: trackIndex, countOffset, offset, endOffset, frames, runs,
    activeRuns, neutralFrames, inputChanges, longestNeutralFrames,
    bitFrames, entries, warnings, maskHistogram: Object.fromEntries(maskHistogram),
  };
}

function requireRange(view, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) throw new Error(`${label}超过记录边界。`);
}

// Confirmed from uni2.exe's replay-list rendering path: when winner display is
// enabled, 0 marks the first player and 1 marks the second player.
function readResultMetadata(view) {
  const rawWinner = view.getInt32(0x130, true);
  const winner = rawWinner === 0 ? "p1" : rawWinner === 1 ? "p2" : null;
  return {
    winner,
    rawWinner,
    scoreP1: null,
    scoreP2: null,
    scoreSource: null,
    confidence: winner ? "native-confirmed" : "unmapped",
  };
}

export function inferOwnerId(matches) {
  const ranked = getOwnerCandidates(matches);
  if (!ranked.length) return null;
  const highestFrequency = ranked[0].matches;
  const candidates = ranked.filter((candidate) => candidate.matches === highestFrequency);
  if (candidates.length !== 1) {
    throw new Error(
      `无法唯一识别本机玩家：${candidates.length} 个账号同为最高频（${highestFrequency} 次）。`,
    );
  }
  return candidates[0].accountId;
}

function getOwnerCandidates(matches) {
  const players = new Map();
  for (const match of matches) {
    const seen = new Set();
    for (const player of [match.p1, match.p2]) {
      const { accountId } = player;
      if (!accountId || seen.has(accountId)) continue;
      seen.add(accountId);
      if (!players.has(accountId)) players.set(accountId, { accountId, steamId64: player.steamId64 ?? null, matches: 0 });
      players.get(accountId).matches += 1;
    }
  }
  return [...players.values()].sort((a, b) => b.matches - a.matches || a.accountId - b.accountId);
}

function readSystemTime(view, offset) {
  const values = Array.from({ length: 8 }, (_, i) => view.getUint16(offset + i * 2, true));
  const [year, month, dayOfWeek, day, hour, minute, second, milliseconds] = values;
  // Validate the calendar without local DST normalization. SYSTEMTIME has no
  // independently verified time zone in this format.
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  const valid = year >= 2000 && year <= 2200 && dayOfWeek <= 6
    && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === milliseconds;
  const sortValue = new Date(year, month - 1, day, hour, minute, second, milliseconds).getTime();
  return { year, month, dayOfWeek, day, hour, minute, second, milliseconds, sortValue, valid, timezone: "unspecified" };
}

function readShiftJis(bytes, offset, maxLength) {
  let end = offset;
  const limit = Math.min(bytes.length, offset + maxLength);
  while (end < limit && bytes[end] !== 0) end += 1;
  return textDecoder.decode(bytes.subarray(offset, end)).trim();
}

function readAscii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

async function decompressGzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 gzip 解压，请使用最新版 Chrome、Edge 或 Firefox。");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DECOMPRESSED_SIZE) {
        await reader.cancel();
        throw new Error("解压结果超过 16 MiB 安全限制，已停止处理。");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (size > MAX_DECOMPRESSED_SIZE) throw error;
    throw new Error("gzip 容器损坏或不完整。", { cause: error });
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
