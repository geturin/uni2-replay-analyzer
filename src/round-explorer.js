import { ownerContext } from "./analytics.js";
import { CHARACTER_BY_ID } from "./replay-parser.js";
import { getSteamDisplayName, validSteamId64 } from "./steam-profile.js";
import { stageNameJa, musicNameJa } from "./replay-names.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
const pad = (value) => String(value).padStart(2, "0");
const dialog = () => document.querySelector("#match-detail");
let trigger = null;

// Keep this entry point while callers migrate from the former round explorer.
export function openRoundExplorer(match, ownerId) {
  const context = ownerContext(match, ownerId);
  if (!context) return;
  trigger = document.activeElement;
  document.querySelector("#detail-title").textContent = `${context.owner.character} vs ${context.opponent.character}`;
  renderMatchDetail(match, context);
  if (!dialog().open) dialog().showModal();
  document.querySelector("#close-detail").focus();
}

/** Require coherent scoreboard transitions plus the recorded final winner. */
export function confirmedScore(result) {
  if (result?.scoreSource !== "round-state-plus-match-winner") return null;
  const { scoreP1, scoreP2 } = result;
  return Number.isInteger(scoreP1) && scoreP1 >= 0 && Number.isInteger(scoreP2) && scoreP2 >= 0
    ? [scoreP1, scoreP2] : null;
}

function scoreFromPerspective(result, context) {
  const score = confirmedScore(result);
  if (!score) return "未解析";
  return scorePair(score, context);
}

function scorePair(score, context) {
  if (!Array.isArray(score) || score.length !== 2 || score.some((value) => !Number.isInteger(value) || value < 0)) return "未解析";
  return context.ownerSide === "p1" ? `${score[0]} – ${score[1]}` : `${score[1]} – ${score[0]}`;
}

function renderMatchDetail(match, context) {
  const resultLabel = context.result === "win" ? "胜利" : context.result === "loss" ? "失利" : "未解析";
  const rounds = Array.from({ length: Math.max(match.rounds?.length || 0, match.roundCount || 0) }, (_, index) => match.rounds?.[index] || { index: index + 1 });
  const timestamp = match.timestamp;
  const dateLabel = timestamp ? `${timestamp.year}-${pad(timestamp.month)}-${pad(timestamp.day)} ${pad(timestamp.hour)}:${pad(timestamp.minute)}:${pad(timestamp.second)}` : "日期未记录";
  document.querySelector("#detail-body").innerHTML = `
    <div class="detail-matchup">
      ${detailPlayer(context.owner, context.ownerSide, "分析玩家", context.result === "win")}
      <div class="detail-versus" aria-hidden="true">VS</div>
      ${detailPlayer(context.opponent, context.opponentSide, "对手", context.result === "loss")}
    </div>
    <div class="detail-match-meta"><time>${escape(dateLabel)}</time><span>录像 ${escape(match.slot + 1)}</span>${matchMetadata(match.metadata)}</div>
    <div class="detail-stats">
      <div><span>你的赛果</span><b class="${context.result}">${resultLabel}</b></div>
      <div><span>整场比分 · 你 / 对手</span><b data-match-score>${scoreFromPerspective(match.result, context)}</b></div>
      <div><span>记录回合数</span><b>${rounds.length}</b></div>
      <div><span>你的所在侧</span><b>${context.ownerSide === "p1" ? "1P" : "2P"}</b></div>
    </div>
    <section class="detail-rounds" aria-labelledby="detail-rounds-title">
      <div class="section-heading"><div><span>ROUND RESULTS</span><h3 id="detail-rounds-title">逐回合赛果</h3></div></div>
      <div class="round-results-table">
        <div class="round-result-row round-result-head"><span>回合</span><span>比分变化 · 你 / 对手</span><span>胜者</span><span>结束方式</span><span>开局 EXS · 你 / 对手</span></div>
        ${rounds.length ? rounds.map((round, index) => roundResultRow(round, index, context)).join("") : '<div class="empty-state compact">此录像尚无可显示的回合记录。</div>'}
      </div>
      <p class="sample-note">比分与 EXS 按「你 / 对手」显示。EXS 为回合开始时的能量；末局如由整场赛果推导，会单独标记。</p>
    </section>`;
}

function roundResultRow(round, index, context) {
  const result = round.result;
  const winner = result?.winner;
  const known = winner === "p1" || winner === "p2";
  const won = known && winner === context.ownerSide;
  const label = result?.outcome === "draw" ? "平局" : known ? won ? "你" : "对手" : "未解析";
  const sourceNote = result?.source === "match-winner-ft2" ? '<small class="round-source-note">整场赛果推导</small>' : "";
  const before = scorePair(result?.scoreBefore, context);
  const after = scorePair(result?.scoreAfter, context);
  const score = before === "未解析" && after === "未解析" ? "未解析" : `${before} <span aria-label="变为">→</span> ${after}`;
  const finishLabels = { ko: "KO", perfect: "PERFECT", timeup: "TIME UP", "double-ko": "双 KO" };
  const finish = finishLabels[result?.finish?.type] || (result?.source === "match-winner-ft2" ? "未记录" : "未解析");
  return `<div class="round-result-row" data-round-index="${index}"><strong>R${index + 1}</strong><b data-round-score>${score}</b><div><span data-round-winner class="${known ? won ? "win" : "loss" : "muted"}">${label}</span>${sourceNote}</div><span class="round-finish ${finish === "PERFECT" ? "perfect" : ""}">${finish}</span>${roundExs(round.startState, context)}</div>`;
}

function roundExs(startState, context) {
  const p1 = startState?.valid === false ? null : startState?.exsP1;
  const p2 = startState?.valid === false ? null : startState?.exsP2;
  const ordered = context.ownerSide === "p1" ? [p1, p2] : [p2, p1];
  return `<div class="round-exs"><span class="round-exs-label">开局 EXS</span>${ordered.map((raw, index) => {
    const known = Number.isInteger(raw) && raw >= 0 && raw <= 20000;
    const value = known ? `${Number((raw / 100).toFixed(2))}%` : "—";
    return `<div class="exs-gauge ${index ? "opponent" : "owner"}" aria-label="${index ? "对手" : "你"}的开局 EXS ${known ? value : "未解析"}"><span>${value}</span><i aria-hidden="true" style="--exs:${known ? raw / 200 : 0}%"></i></div>`;
  }).join("")}</div>`;
}

function matchMetadata(metadata) {
  if (!metadata) return "";
  const mode = ({ local: "本地对战", ranked: "排位赛", player: "玩家房间", adhoc: "ADHOC", casual: "休闲赛" })[metadata.mode];
  const stage = stageNameJa(metadata.stageId);
  const music = musicNameJa(metadata.musicId);
  return (mode ? `<span>${mode}</span>` : "") + (metadata.battleVersion ? `<span>Ver. ${escape(metadata.battleVersion)}</span>` : "")
    + `<span data-stage-name>舞台 · <span lang="ja">${escape(stage || "名称未记录")}</span></span>`
    + `<span data-music-name>BGM · <span lang="ja">${escape(music || "曲名未记录")}</span></span>`;
}

function detailPlayer(player, side, label, won) {
  const character = player.character || "未知角色";
  const characterId = CHARACTER_BY_ID.indexOf(character);
  const source = characterId >= 0 ? `./assets/faces/face_chr${String(characterId).padStart(3, "0")}_${side === "p2" ? "2p" : "1p"}.bmp` : `./assets/characters/${encodeURIComponent(character)}.png`;
  const steamId = validSteamId64(player);
  const name = escape(getSteamDisplayName(player));
  const displayName = steamId ? `<a href="https://steamcommunity.com/profiles/${steamId}" target="_blank" rel="noopener noreferrer">${name} ↗</a>` : name;
  return `<article class="detail-player ${won ? "winner" : ""}"><span>${label} · ${side === "p1" ? "1P" : "2P"}</span><img class="avatar" src="${source}" alt="${escape(character)}" /><div><h3>${escape(character)}</h3><p>${displayName}</p>${Number.isInteger(player.rip) ? `<small>录像中的 RIP ${player.rip.toLocaleString()}</small>` : ""}</div></article>`;
}

document.querySelector("#close-detail").addEventListener("click", () => dialog().close());
dialog().addEventListener("close", () => trigger?.focus());
dialog().addEventListener("click", (event) => {
  if (event.target !== dialog()) return;
  const rect = dialog().getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog().close();
});
