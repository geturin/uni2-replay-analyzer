import { CHARACTER_BY_ID, parseReplayFile, selectReplayOwner } from "./replay-parser.js";
import { filterMatches, summarize, matchupStats, sessionStats, reviewPriorities, roundStats } from "./analytics.js";
import { deriveRoundResults } from "./round-results.js";
import { openRoundExplorer, confirmedScore } from "./round-explorer.js";
import {
  getSteamDisplayName,
  hydrateSteamNames,
  validSteamId64,
} from "./steam-profile.js";

const DEMO_OWNER_ID = 100000001;
const defaultFilters = () => ({ search: "", character: "", ownCharacter: "", result: "all", from: "", to: "", side: "", rounds: "", opening: "", trajectory: "", finish: "", opponent: "", sort: "newest", session: "" });
let datasetRevision = 0;
let steamNameController = null;

const state = {
  dataset: null,
  matches: [],
  activeTab: "overview",
  visibleMatches: 40,
  filters: defaultFilters(),
  rollingWindow: 20,
  minimumSample: 1,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  fileInput: $("#file-input"),
  landing: $("#landing"),
  loading: $("#loading-view"),
  loadingLabel: $("#loading-label"),
  dashboard: $("#dashboard"),
  dropZone: $("#drop-zone"),
  metrics: $("#metrics"),
  matchList: $("#match-list"),
  matchCount: $("#match-count"),
  loadMore: $("#load-more"),
  characterFilter: $("#character-filter"),
  resultFilter: $("#result-filter"),
  search: $("#match-search"),
  playerTable: $("#player-table"),
  characterGrid: $("#character-grid"),
  insightGrid: $("#insight-grid"),
  notice: $("#notice"),
  toast: $("#toast"),
};

$$('[data-open-file]').forEach((button) => button.addEventListener("click", () => elements.fileInput.click()));
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) loadFile(file);
  elements.fileInput.value = "";
});

for (const event of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
}
for (const event of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
}
elements.dropZone.addEventListener("drop", (e) => {
  const [file] = e.dataTransfer.files;
  if (file) loadFile(file);
});
elements.dropZone.addEventListener("click", (e) => {
  if (!e.target.closest("[data-open-file]")) elements.fileInput.click();
});

elements.search.addEventListener("input", (e) => updateFilter("search", e.target.value));
$$('[data-filter]').forEach((input) => input.addEventListener("change", () => updateFilter(input.dataset.filter, input.value)));
$("#load-demo").addEventListener("click", loadDemo);
$("#reset-filters").addEventListener("click", () => { state.filters = defaultFilters(); state.visibleMatches = 40; renderAll(); });
elements.dropZone.addEventListener("keydown", (event) => { if (event.target === elements.dropZone && ["Enter", " "].includes(event.key)) { event.preventDefault(); elements.fileInput.click(); } });
$("#owner-select").addEventListener("change", (event) => {
  steamNameController?.abort();
  state.dataset = selectReplayOwner(state.dataset, Number(event.target.value));
  state.matches = state.dataset.matches;
  state.filters = defaultFilters();
  state.visibleMatches = 40;
  renderAll();
  if (!state.dataset.isDemo) resolveSteamNamesForDataset(state.dataset, datasetRevision);
});
$("#minimum-sample").addEventListener("change", (e) => { state.minimumSample = Number(e.target.value); renderMatrix(); });
$("#rolling-window").addEventListener("change", (e) => { state.rollingWindow = Number(e.target.value); renderInsights(); });
$$('[data-preset]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.preset === "losses") state.filters.result = "loss";
  if (button.dataset.preset === "deciders") state.filters.rounds = "3";
  if (button.dataset.preset === "recent") {
    const latest = [...state.matches].sort((a,b) => b.timestamp.sortValue - a.timestamp.sortValue)[0];
    if (latest) {
      const ts = latest.timestamp;
      const date = new Date(ts.year, ts.month - 1, ts.day - 6, 12);
      state.filters.from = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
      state.filters.to = formatDate(ts);
    }
  }
  state.filters.session = "";
  state.visibleMatches = 40;
  renderAll();
}));
$("#filter-chips").addEventListener("click", (event) => {
  const button = event.target.closest('[data-clear-filter]');
  if (button) updateFilter(button.dataset.clearFilter, defaultFilters()[button.dataset.clearFilter]);
});
elements.dashboard.addEventListener("click", (event) => {
  const detail = event.target.closest('[data-detail]');
  if (detail) {
    const match = state.matches.find((m) => m.slot === Number(detail.dataset.detail));
    if (match) openRoundExplorer(match, state.dataset.ownerId);
    return;
  }
  const drill = event.target.closest('[data-drill]');
  if (!drill) return;
  for (const key of ["character", "ownCharacter", "opponent", "session", "result", "side", "rounds", "opening", "trajectory", "finish"]) {
    if (Object.hasOwn(drill.dataset, key)) state.filters[key] = drill.dataset[key];
  }
  state.visibleMatches = 40;
  renderAll();
  activateTab("matches");
  $("#matches-panel").scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? "instant" : "smooth", block: "start" });
});
elements.dashboard.addEventListener("keydown", (event) => {
  const point = event.target.closest('circle[data-detail]');
  if (point && ["Enter", " "].includes(event.key)) { event.preventDefault(); point.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
elements.loadMore.addEventListener("click", () => {
  state.visibleMatches += 60;
  renderMatches();
});

$$('[data-tab]').forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

function activateTab(name) {
  if (!$$('[data-tab]').some((tab) => tab.dataset.tab === name)) return;
  state.activeTab = name;
  $$(".tab").forEach((tab) => { tab.classList.toggle("active", tab.dataset.tab === name); tab.setAttribute("aria-current", tab.dataset.tab === name ? "page" : "false"); });
  $$(".tab-panel").forEach((panel) => {
    panel.hidden = panel.id !== `${name}-panel`;
  });
}

$("#export-json").addEventListener("click", () => {
  if (!state.dataset) return;
  const clean = filteredMatches()
    .filter((match) => getOwnerContext(match, state.dataset.ownerId))
    .map(serializeMatch);
  downloadBlob(JSON.stringify({ exportedAt: new Date().toISOString(), ownerId: state.dataset.ownerId, filters: state.filters, matches: clean }, null, 2), "uni2-replays-filtered.json", "application/json");
});

$("#export-csv").addEventListener("click", () => {
  if (!state.dataset) return;
  const rows = [
    ["slot", "date", "p1_steam_name", "p1_replay_label", "p1_account_id", "p1_steam_id64", "p1_character", "p2_steam_name", "p2_replay_label", "p2_account_id", "p2_steam_id64", "p2_character", "winner", "owner_result", "score_p1", "score_p2", "rounds", "score_source", "owner_round_path", "first_round_winner", "trajectory", "stage_id", "music_id", "observed_finishes", "mode", "battle_version", "p1_rip", "p2_rip"],
    ...filteredMatches().filter((match) => getOwnerContext(match, state.dataset.ownerId)).map((m) => [
      m.slot,
      formatDate(m.timestamp, true),
      m.p1.steamName || "",
      m.p1.replayLabel || "",
      m.p1.accountId,
      m.p1.steamId64 || "",
      m.p1.character,
      m.p2.steamName || "",
      m.p2.replayLabel || "",
      m.p2.accountId,
      m.p2.steamId64 || "",
      m.p2.character,
      m.result.winner || "",
      ownerResultLabel(m),
      confirmedScore(m.result)?.[0] ?? "",
      confirmedScore(m.result)?.[1] ?? "",
      m.roundCount,
      m.result.scoreSource || "",
      ownerRoundPath(m),
      m.result.firstRoundWinner || "",
      m.result.trajectory || "",
      m.metadata?.stageId ?? "",
      m.metadata?.musicId ?? "",
      m.rounds.map((round) => round.result?.finish?.type || "unknown").join("/"),
      m.metadata?.mode || "", m.metadata?.battleVersion || "", m.p1.rip ?? "", m.p2.rip ?? "",
    ]),
  ];
  downloadBlob(rows.map((r) => r.map(csvCell).join(",")).join("\n"), "uni2-replays.csv", "text/csv;charset=utf-8");
});

async function loadFile(file) {
  const revision = ++datasetRevision;
  steamNameController?.abort();
  steamNameController = null;
  showLoading(true);
  try {
    const parsed = await parseReplayFile(file, (label) => (elements.loadingLabel.textContent = label));
    if (revision !== datasetRevision) return;
    state.dataset = parsed;
    state.matches = parsed.matches;
    state.visibleMatches = 40;
    state.filters = defaultFilters();
    renderAll();
    showDashboard();
    resolveSteamNamesForDataset(parsed, revision);
    toast(`已在本地解析 ${parsed.matches.length} 场录像`);
  } catch (error) {
    if (revision !== datasetRevision) return;
    showLoading(false);
    elements.landing.hidden = false;
    toast(error.message, true);
  }
}

function loadDemo() {
  datasetRevision += 1;
  steamNameController?.abort();
  steamNameController = null;
  const matches = createDemoMatches();
  state.dataset = {
    isDemo: true,
    matches,
    ownerId: DEMO_OWNER_ID,
    recordCapacity: 400,
    errors: [],
    source: { fileName: "DEMO · REP-DATA", compressed: true, sourceBytes: 979467, rawBytes: 12547200 },
    format: { outerVersion: 5, buildCode: 0x3501, recordSize: 0x7a88 },
  };
  state.dataset.allMatches = matches;
  state.dataset.ownerCandidates = [{ accountId: DEMO_OWNER_ID, matches: matches.length }];
  state.matches = matches;
  state.visibleMatches = 40;
  state.filters = defaultFilters();
  renderAll();
  showDashboard();
  toast("当前显示匿名演示数据");
}

function resolveSteamNamesForDataset(dataset, revision) {
  const controller = new AbortController();
  steamNameController = controller;
  void hydrateSteamNames(dataset.allMatches || dataset.matches, { concurrency: 4, signal: controller.signal })
    .then(() => {
      if (controller.signal.aborted || revision !== datasetRevision) return;
      renderAll();
    })
    .catch((error) => {
      if (error?.name !== "AbortError") console.warn("Steam 昵称查询失败", error);
    })
    .finally(() => {
      if (steamNameController === controller) steamNameController = null;
    });
}

function renderAll() {
  fillDatasetHeader();
  fillCharacterFilter();
  fillOwnerSelect();
  $$('[data-filter]').forEach((input) => { input.value = state.filters[input.dataset.filter]; });
  elements.search.value = state.filters.search;
  elements.characterFilter.value = state.filters.character;
  elements.resultFilter.value = state.filters.result || elements.resultFilter.options[0]?.value || "";
  renderMetrics();
  renderMatches();
  renderPlayers();
  renderCharacters();
  renderInsights();
  renderOverview();
  renderMatrix();
  renderSessions();
  renderFilterSummary();
  renderNotice();
  activateTab(state.activeTab);
}

function fillDatasetHeader() {
  const { source, matches, format } = state.dataset;
  $("#dataset-title").textContent = source.fileName;
  const range = getDateRange(matches);
  $("#dataset-meta").textContent = state.dataset.isDemo ? `合成演示 · ${matches.length} 场 · ${range}` : `${source.compressed ? "GZIP" : "RAW"} · FORMAT ${format.outerVersion} · ${matches.length} MATCHES · ${range}`;
}

function renderNotice() {
  const known = state.matches.filter((m) => m.result.winner).length;
  const messages = [];
  if (state.dataset.ownerInference?.ambiguous && !state.dataset.ownerInference?.manuallySelected) messages.push("无法唯一推断本机账号：目前显示首个候选，请在「分析视角」确认玩家。");
  if (known < state.matches.length) messages.push(`${state.matches.length - known} 场胜负未知，未计入胜率。`);
  if (state.dataset.errors?.length) messages.push(`${state.dataset.errors.length} 个损坏或不支持的槽位未计入统计。`);
  if (state.dataset.skippedUnowned) messages.push(`${state.dataset.skippedUnowned} 场不属于当前视角或无法识别双方，已从当前分析排除。`);
  elements.notice.hidden = !messages.length;
  elements.notice.textContent = messages.join(" ");
}

function renderMetrics() {
  const summary = getOwnerSummary(filteredMatches(), state.dataset.ownerId);
  const opponents = getOpponentStats(filteredMatches(), state.dataset.ownerId);
  const topCharacter = summary.characters[0];
  const recent = takeKnownResults(summary.results, 10, true);

  elements.metrics.innerHTML = [
    metric("对局", summary.matches.toLocaleString(), `${summary.known} 场有赛果`, "purple"),
    metric("对手", opponents.length.toLocaleString(), steamProfileLink(summary.owner, "本机 Steam"), "pink"),
    metric("样本胜率", formatRate(summary.wins, summary.known), `${summary.wins}W / ${summary.losses}L · 未知 ${summary.matches - summary.known}`, "cyan"),
    metric("近 10 场", recent.length ? formatRate(countWins(recent), recent.length) : "—", topCharacter ? `${topCharacter.character} · ${topCharacter.count} 场` : "无角色记录", "gold"),
  ].join("");
}

function renderMatches() {
  const matches = filteredMatches();
  elements.matchCount.textContent = `${matches.length} 场`;
  const visible = matches.slice(0, state.visibleMatches);
  elements.matchList.innerHTML = visible.length
    ? visible.map(matchRow).join("")
    : `<div class="empty-state"><strong>没有符合条件的对局</strong><span>试试清除搜索或角色筛选。</span></div>`;
  elements.loadMore.hidden = visible.length >= matches.length;
}

function matchRow(match) {
  const context = getOwnerContext(match, state.dataset.ownerId);
  if (!context) return "";
  const result = match.result.winner;
  const ownerWon = result ? result === context.ownerSide : null;
  const parsedScore = confirmedScore(match.result);
  const score = parsedScore ? context.ownerSide === "p1" ? `${parsedScore[0]}–${parsedScore[1]}` : `${parsedScore[1]}–${parsedScore[0]}` : null;
  const outcome = ownerWon !== null
    ? `<span class="result-badge known ${ownerWon ? "win" : "loss"}">${ownerWon ? "WIN" : "LOSS"}${score ? ` · ${score}` : ""}</span>`
    : `<span class="result-badge">未解析</span>`;
  return `
    <div class="match-entry"><article class="match-row">
      <time><b>${formatDate(match.timestamp)}</b><small>${formatTime(match.timestamp)} · SLOT ${String(match.slot + 1).padStart(3, "0")}</small></time>
      ${playerCell(context.owner, ownerWon === true, false, true)}
      <div class="versus">VS</div>
      ${playerCell(context.opponent, ownerWon === false, true)}
      <div class="match-result">${outcome}</div>
      <div class="match-rounds"><b>${match.roundCount} 回合</b><small>${ownerRoundPath(match).split("").join(" · ")}</small></div>
    </article><button class="match-detail-button" data-detail="${match.slot}" aria-label="查看 ${formatDate(match.timestamp)} ${formatTime(match.timestamp)} 对战 ${escapeHtml(context.opponent.character)} 的对局详情">对局详情</button></div>`;
}

function playerCell(player, winner, reverse = false, isOwner = false) {
  const url = steamProfileUrl(player);
  const tag = url ? "a" : "div";
  const displayName = isOwner ? "你" : getSteamDisplayName(player);
  const linkAttributes = url
    ? ` href="${url}" target="_blank" rel="noopener noreferrer" title="打开${isOwner ? "你的" : ` ${escapeHtml(displayName)} 的`} Steam 主页" aria-label="打开${isOwner ? "你的" : ` ${escapeHtml(displayName)} 的`} Steam 主页"`
    : "";
  const replayLabel = String(player?.replayLabel || "").trim();
  const identityDetail = [replayLabel, player.character].filter(Boolean).join(" · ");
  return `<${tag} class="player-cell ${reverse ? "reverse" : ""} ${winner ? "winner" : ""}"${linkAttributes}>
    ${avatar(player.character, "normal", reverse ? "p2" : "p1")}
    <div><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(identityDetail)}${url ? " ↗" : ""}</small></div>
    ${winner ? '<span class="winner-mark">W</span>' : ""}
  </${tag}>`;
}

function renderPlayers() {
  const players = getOpponentStats(filteredMatches(), state.dataset.ownerId);
  if (!players.length) { elements.playerTable.innerHTML = '<div class="empty-state compact">没有符合筛选的对手记录</div>'; return; }
  elements.playerTable.innerHTML = `
    <div class="table-row table-head"><span>对手</span><span>VS</span><span>对手使用角色</span><span>本机战绩</span><span>本机胜率</span></div>
    ${players.map((p) => `
      <div class="table-row">
        ${opponentTablePlayer(p)}
        <strong>${p.matches}</strong>
        <span class="opponent-characters">${p.characters.map((item) => `
          <span class="mini-character" title="${item.count}/${p.matches} · ${formatRate(item.count, p.matches)}">
            ${avatar(item.character, "tiny")}<span>${item.character}<small>${item.count} · ${formatRate(item.count, p.matches)}</small></span>
          </span>`).join("")}</span>
        <span>${p.known ? `${p.wins}W · ${p.losses}L` : "—"}</span>
        <div><strong class="rate">${formatRate(p.wins, p.known)}</strong><button class="button button-ghost compact" data-drill data-opponent="${p.steamId64 || p.accountId}">查看对局 →</button></div>
      </div>`).join("")}`;
}

function opponentTablePlayer(player) {
  const url = steamProfileUrl(player);
  const tag = url ? "a" : "span";
  const displayName = getSteamDisplayName(player);
  const linkAttributes = url
    ? ` href="${url}" target="_blank" rel="noopener noreferrer" title="打开 ${escapeHtml(displayName)} 的 Steam 主页" aria-label="打开 ${escapeHtml(displayName)} 的 Steam 主页"`
    : "";
  const replayLabel = String(player?.replayLabel || "").trim();
  const detail = replayLabel || "无签名";
  return `<${tag} class="table-player"${linkAttributes}><b>${escapeHtml(displayName)}</b><small>${escapeHtml(detail)}${url ? " ↗" : ""}</small></${tag}>`;
}

function renderCharacters() {
  const stats = getOpponentCharacterStats(filteredMatches(), state.dataset.ownerId);
  if (!stats.length) { elements.characterGrid.innerHTML = '<div class="empty-state compact">没有符合筛选的角色记录</div>'; return; }
  const max = stats[0]?.matches || 1;
  elements.characterGrid.innerHTML = stats.map((item, index) => `
    <button class="character-card drilldown" data-drill data-character="${escapeHtml(item.character)}">
      <span class="rank">${String(index + 1).padStart(2, "0")}</span>
      ${avatar(item.character, "large")}
      <div class="character-copy">
        <h4>${item.character}</h4>
        <p>${item.matches} 场 · ${item.known ? `${item.wins}W / ${item.losses}L` : "无赛果"}</p>
        <div class="usage-bar"><i style="width:${(item.matches / max) * 100}%"></i></div>
      </div>
      <div class="character-rate">
        <strong>${formatRate(item.wins, item.known)}</strong>
        <small class="trend ${trendClass(item.recentDelta)}">${formatTrend(item.recentDelta, item.recentRate, item.recentCount)}</small>
      </div>
    </button>`).join("");
}

function renderInsights() {
  const summary = getOwnerSummary(filteredMatches(), state.dataset.ownerId);
  const results = summary.results.filter((item) => item.won !== null);
  const first10 = results.slice(-20, -10);
  const recent10 = takeKnownResults(results, 10, true);
  const firstRate = rateNumber(countWins(first10), first10.length);
  const recentRate = rateNumber(countWins(recent10), recent10.length);
  const delta = results.length >= 20 && first10.length && recent10.length ? recentRate - firstRate : null;
  const analyticsSummary = summarize(filteredMatches(), state.dataset.ownerId);
  const streaks = { current: analyticsSummary.currentStreak, longestWin: analyticsSummary.longestWin, longestLoss: analyticsSummary.longestLoss };
  const activity = calculateActivity(summary.matchesList);
  const rolling = rollingWinRate(results, state.rollingWindow);
  const hasSubset = Object.entries(state.filters).some(([key, value]) => key !== "sort" && value && value !== "all");

  elements.insightGrid.innerHTML = `
    <article class="insight-card signal"><span>RECENT 10</span><b>${recent10.length ? formatRate(countWins(recent10), recent10.length) : "—"}</b><p>${recent10.length ? `${countWins(recent10)}W / ${recent10.length - countWins(recent10)}L` : "无赛果"}${delta === null ? "" : ` · ${formatSignedPoints(delta)} vs 前 10 场`}</p></article>
    <article class="insight-card signal"><span>${hasSubset ? "FILTERED SAMPLE" : "CURRENT STREAK"}</span><b>${hasSubset ? summary.matches + " 场" : streaks.current.count ? `${streaks.current.won ? "W" : "L"}${streaks.current.count}` : "—"}</b><p>${hasSubset ? "筛选中不计算跨场连胜，重置筛选可查看" : `最长 W${streaks.longestWin} · L${streaks.longestLoss}`}</p></article>
    <article class="insight-card signal"><span>ACTIVE DAYS</span><b>${activity.activeDays}</b><p>日均 ${activity.averagePerDay} 场 · ${activity.peakDate} 峰值 ${activity.peakCount} 场</p></article>
    <article class="insight-card signal"><span>OPPONENTS</span><b>${getOpponentStats(filteredMatches(), state.dataset.ownerId).length}</b><p>${summary.characters.length ? `本机使用 ${summary.characters.length} 个角色` : "无角色记录"}</p></article>
    <article class="insight-card timeline-card winrate-card">
      <div><span>WIN RATE TREND</span><b>滚动 ${rolling.window} 场</b></div>
      ${renderWinRateChart(rolling.points)}
      <div class="trend-legend"><span>${results.length ? formatDate(results[0].match.timestamp) : "—"}</span><span>50%</span><span>${results.length ? formatDate(results.at(-1).match.timestamp) : "—"}</span></div>
    </article>`;
}

function updateFilter(key, value) {
  state.filters[key] = value;
  state.visibleMatches = 40;
  renderAll();
}

function filteredMatches() {
  let matches = filterMatches(state.matches, state.dataset.ownerId, state.filters);
  if (state.filters.session) {
    const session = sessionStats(state.matches, state.dataset.ownerId).find((item) => item.id === state.filters.session);
    const slots = new Set(session?.matchesList.map((m) => m.slot) || []);
    matches = matches.filter((m) => slots.has(m.slot));
  }
  return matches;
}

function fillCharacterFilter() {
  const used = new Set(state.matches.map((m) => getOwnerContext(m, state.dataset.ownerId)?.opponent.character).filter(Boolean));
  elements.characterFilter.innerHTML = `<option value="">全部对手角色</option>${[...used].sort().map((c) => `<option>${escapeHtml(c)}</option>`).join("")}`;
  const own = new Set(state.matches.map((m) => getOwnerContext(m, state.dataset.ownerId)?.owner.character).filter(Boolean));
  $("#own-character-filter").innerHTML = `<option value="">全部本机角色</option>${[...own].sort().map((c) => `<option>${escapeHtml(c)}</option>`).join("")}`;
}

function fillOwnerSelect() {
  const candidates = state.dataset.ownerCandidates || [{ accountId: state.dataset.ownerId, matches: state.matches.length }];
  const all = state.dataset.allMatches || state.matches;
  $("#owner-select").innerHTML = candidates.map((candidate) => {
    const match = all.find((m) => [m.p1.accountId, m.p2.accountId].includes(candidate.accountId));
    const player = match?.p1.accountId === candidate.accountId ? match.p1 : match?.p2;
    return `<option value="${candidate.accountId}">${escapeHtml(player ? getSteamDisplayName(player) : candidate.accountId)} · ${candidate.matches} 场</option>`;
  }).join("");
  $("#owner-select").value = state.dataset.ownerId;
  $("#owner-select").disabled = candidates.length < 2;
}

function renderFilterSummary() {
  const count = filteredMatches().length;
  const reversed = state.filters.from && state.filters.to && state.filters.from > state.filters.to;
  $("#filter-summary").textContent = reversed ? "开始日期晚于结束日期，请调整日期范围。" : `当前 ${count} / ${state.matches.length} 场 · 下方所有分析与 JSON / CSV 导出均使用此筛选`;
  const labels = { search: "搜索", character: "对手角色", ownCharacter: "你的角色", result: "结果", from: "从", to: "至", side: "所在侧", rounds: "回合", opening: "首局", trajectory: "走势", finish: "回合结束", opponent: "指定对手", session: "训练场次" };
  const values = { win: "胜", loss: "负", unknown: "未知", p1: "1P", p2: "2P", won: "先赢", lost: "先输", comeback: "让一追二", reversed: "被让一追二", sweep: "2–0 获胜", "perfect-win": "打出 Perfect", "perfect-loss": "被 Perfect", timeup: "出现超时" };
  $("#filter-chips").innerHTML = Object.entries(state.filters).filter(([key, value]) => labels[key] && value && value !== "all").map(([key, value]) => `<button class="filter-chip" data-clear-filter="${key}" aria-label="清除${labels[key]}筛选">${labels[key]}：${escapeHtml(key === "session" ? "已选择" : values[value] || value)} ×</button>`).join("");
  $("#export-json").disabled = !count;
  $("#export-csv").disabled = !count;
}

function renderOverview() {
  const matches = filteredMatches();
  const summary = summarize(matches, state.dataset.ownerId);
  const priorities = reviewPriorities(matches, state.dataset.ownerId).slice(0, 4);
  const deciders = summarize(matches.filter((m) => m.roundCount === 3 && m.result.sequenceComplete), state.dataset.ownerId);
  const rounds = roundStats(matches, state.dataset.ownerId);
  const side = (value) => summarize(matches.filter((m) => getOwnerContext(m, state.dataset.ownerId)?.ownerSide === value), state.dataset.ownerId);
  const p1 = side("p1"), p2 = side("p2");
  const quality = state.dataset.quality;
  const empty = `<div class="empty-state compact"><strong>暂无足够分散的对策样本</strong><span>同一角色对策至少 10 场已知赛果、3 位不同对手后再排序。可先在对局中复盘败局。</span></div>`;
  $("#analysis-overview").innerHTML = `
    <div class="briefing-grid">
      <article class="briefing-card"><span class="eyebrow">MOMENTUM</span><h3>近期状态</h3><b>${summary.recent.known ? formatRate(summary.recent.wins, summary.recent.known) : "—"}</b><p>最近 ${summary.recent.known} 场已知赛果${summary.recentDelta === null ? " · 满 20 场后比较前后窗口" : ` · 较前 10 场 ${formatSignedPoints(summary.recentDelta)}`}</p><div class="recent-strip">${summary.results.slice(-20).map((r) => `<button class="recent-result ${r.won === null ? "unknown" : r.won ? "win" : "loss"}" data-detail="${r.match.slot}" title="${formatDate(r.match.timestamp)} · ${r.won === null ? "未知" : r.won ? "胜" : "负"}">${r.won === null ? "?" : r.won ? "W" : "L"}</button>`).join("")}</div><small>最近 20 场 · 点击进入回合详情</small></article>
      <button class="briefing-card drilldown" data-drill data-rounds="3"><span class="eyebrow">FINAL ROUND</span><h3>决胜局表现</h3><b>${formatRate(deciders.wins, deciders.known)}</b><p>${deciders.wins} 胜 / ${deciders.losses} 负</p><small>比分确认为 1–1 后的决胜局 · 查看对局 →</small></button>
      <article class="briefing-card"><span class="eyebrow">PLAYER SIDE</span><h3>两侧表现</h3><div class="side-comparison"><button data-drill data-side="p1">1P <b>${formatRate(p1.wins,p1.known)}</b><small>${p1.known} 场已知赛果 →</small></button><button data-drill data-side="p2">2P <b>${formatRate(p2.wins,p2.known)}</b><small>${p2.known} 场已知赛果 →</small></button></div><p>双方对手与角色可能不同，不能直接归因为站位。</p></article>
    </div>
    <div class="section-heading"><div><span>ROUND BY ROUND</span><h3>先手优势，能否变成胜局</h3></div></div>
    <div class="briefing-grid" id="round-analysis">
      <button class="briefing-card drilldown" data-drill data-opening="won"><span class="eyebrow">AFTER WINNING R1</span><h3>先赢首局后获胜</h3><b>${formatRate(rounds.openingWon.wins,rounds.openingWon.matches)}</b><p>${rounds.openingWon.wins} 胜 / ${rounds.openingWon.losses} 负 · 共 ${rounds.openingWon.matches} 场</p><small>查看先赢首局的对局 →</small></button>
      <button class="briefing-card drilldown" data-drill data-opening="lost"><span class="eyebrow">AFTER LOSING R1</span><h3>先输首局后翻盘</h3><b>${formatRate(rounds.openingLost.wins,rounds.openingLost.matches)}</b><p>${rounds.openingLost.wins} 胜 / ${rounds.openingLost.losses} 负 · 共 ${rounds.openingLost.matches} 场</p><small>查看先输首局的对局 →</small></button>
      <article class="briefing-card"><span class="eyebrow">REVERSE SWEEPS</span><h3>让一追二</h3><div class="side-comparison"><button data-drill data-trajectory="comeback">成功翻盘 <b>${rounds.comebackWins}</b><small>场 →</small></button><button data-drill data-trajectory="reversed">被逆转 <b>${rounds.comebackLosses}</b><small>场 →</small></button></div><p>依据逐局胜负顺序，区分 2–1 的两种赢法。</p></article>
      <article class="briefing-card"><span class="eyebrow">ROUNDS WON</span><h3>回合胜率</h3><b>${formatRate(rounds.wins,rounds.wins+rounds.losses)}</b><p>${rounds.wins} 胜 / ${rounds.losses} 负 · ${rounds.draws} 平 · ${rounds.unknown} 未知</p><small>${rounds.observed} 局由下局比分确认 · ${rounds.inferred} 个末局由整场赛果推导</small></article>
      <article class="briefing-card"><span class="eyebrow">PERFECT ROUNDS</span><h3>Perfect 回合</h3><div class="side-comparison"><button data-drill data-finish="perfect-win">打出 <b>${rounds.perfectWins}</b><small>回合 →</small></button><button data-drill data-finish="perfect-loss">被打出 <b>${rounds.perfectLosses}</b><small>回合 →</small></button></div><p>仅统计能读取结束标记的回合。</p></article>
      <button class="briefing-card drilldown" data-drill data-finish="timeup"><span class="eyebrow">TIME UP</span><h3>超时回合</h3><b>${rounds.timeups}</b><p>共 ${rounds.knownFinishes} / ${rounds.totalRounds} 局可读取结束方式</p><small>每场末局缺少结束标记，未纳入此项 →</small></button>
    </div>
    <div class="section-heading"><div><span>REVIEW QUEUE</span><h3>优先复盘的角色对策</h3></div><button class="button button-ghost compact" data-drill data-result="loss">查看败局 →</button></div>
    <p class="sample-note">先按败场数量，再按样本胜率排序；用于安排复盘时间，不代表角色强弱。</p>
    <div class="priority-list">${priorities.length ? priorities.map((item) => `<button class="priority-item drilldown" data-drill data-character="${escapeHtml(item.character)}" data-own-character="${escapeHtml(item.ownCharacter)}" data-result="loss">${avatar(item.character, "normal")}<div><strong>${escapeHtml(item.ownCharacter)} <span class="muted">vs</span> ${escapeHtml(item.character)}</strong><p>${item.losses} 场败局 · ${item.known} 场已知赛果 · ${item.opponents} 位对手</p></div><b>${formatRate(item.wins,item.known)} →</b></button>`).join("") : empty}</div>
    <div class="section-heading"><div><span>DATA COVERAGE</span><h3>这些数据能告诉你什么</h3></div></div>
    <div class="coverage-grid"><article class="coverage-card"><span>对战记录</span><h4>角色与对手</h4><p>按角色、对手、日期和所在侧筛选，把想复盘的比赛集中到一起。</p></article><article class="coverage-card"><span>样本表现</span><h4>胜负与趋势</h4><p>比较近期状态与每次开打的表现。胜率只代表当前保存的录像，未知赛果不计入胜率。</p></article><article class="coverage-card"><span>对局详情</span><h4>逐回合赛果</h4><p>查看双方资料与已确认的比分、回合胜者；未解析的结果会保留标记。</p></article></div>
    <p class="sample-note">${quality ? `文件检查：${quality.validRecords} 条结构合法录像 · ${quality.totalRounds} 回合 · ${quality.invalidSlots} 个异常槽位。` : "当前为匿名演示数据。"}</p>`;
}

function renderMatrix() {
  const cells = matchupStats(filteredMatches(), state.dataset.ownerId);
  const eligible = cells.filter((c) => c.known >= state.minimumSample);
  const rows = [...new Set(eligible.map((c) => c.ownCharacter))];
  const columns = [...new Set(eligible.map((c) => c.character))];
  $("#matchup-matrix").innerHTML = !eligible.length ? '<div class="empty-state compact">没有达到最小样本数的角色对策</div>' : `<table class="matchup-matrix"><thead><tr><th scope="col">你 / 对手</th>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((own) => `<tr><th scope="row">${escapeHtml(own)}</th>${columns.map((opponent) => {
    const c = eligible.find((cell) => cell.ownCharacter === own && cell.character === opponent);
    if (!c) return '<td class="matrix-empty">—</td>';
    const interval = c.interval ? `样本比例 Wilson 95% 区间 ${c.interval.low.toFixed(1)}–${c.interval.high.toFixed(1)}%，未校正重复对手相关性，非未来胜率预测` : "";
    return `<td><button class="matrix-cell ${c.lowSample ? "sample-low" : ""} ${c.winRate >= 50 ? "positive" : "negative"}" data-drill data-own-character="${escapeHtml(own)}" data-character="${escapeHtml(opponent)}" title="${interval}"><b>${formatRate(c.wins,c.known)}</b><small>${c.wins}W / ${c.losses}L${c.lowSample ? " · 小样本" : ""}</small></button></td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderSessions() {
  const slots = new Set(filteredMatches().map((m) => m.slot));
  const sessions = sessionStats(state.matches, state.dataset.ownerId).map((session) => ({ session, summary: summarize(session.matchesList.filter((m) => slots.has(m.slot)), state.dataset.ownerId) })).filter((s) => s.summary.total);
  $("#session-list").innerHTML = sessions.length ? sessions.map(({session, summary}) => {
    const first = session.matchesList[0], last = session.matchesList.at(-1);
    return `<button class="session-card drilldown" data-drill data-session="${escapeHtml(session.id)}"><div><strong>${formatDate(first.timestamp)}</strong><small>${formatTime(first.timestamp)} – ${formatDate(first.timestamp) !== formatDate(last.timestamp) ? formatDate(last.timestamp) + " " : ""}${formatTime(last.timestamp)}</small></div><span>${summary.total} 场 · ${summary.wins}W / ${summary.losses}L${summary.unknown ? ` / ${summary.unknown}?` : ""}</span><b>${formatRate(summary.wins,summary.known)} →</b></button>`;
  }).join("") : '<div class="empty-state compact">没有符合筛选的训练场次</div>';
}

function getOwnerContext(match, ownerId) {
  if (ownerId === null || ownerId === undefined) return null;
  const p1IsOwner = match.p1.accountId === ownerId;
  const p2IsOwner = match.p2.accountId === ownerId;
  if (p1IsOwner === p2IsOwner) return null;
  const ownerSide = p1IsOwner ? "p1" : "p2";
  const opponentSide = p1IsOwner ? "p2" : "p1";
  return { ownerSide, opponentSide, owner: match[ownerSide], opponent: match[opponentSide] };
}

function getOwnerSummary(matches, ownerId) {
  const summary = {
    owner: null,
    matches: 0,
    known: 0,
    wins: 0,
    losses: 0,
    matchesList: [],
    results: [],
    characterMap: new Map(),
  };

  for (const match of matches) {
    const context = getOwnerContext(match, ownerId);
    if (!context) continue;
    if (!summary.owner || (context.owner.steamName && !summary.owner.steamName)) summary.owner = context.owner;
    summary.matches += 1;
    summary.matchesList.push(match);
    summary.characterMap.set(context.owner.character, (summary.characterMap.get(context.owner.character) || 0) + 1);
    const won = match.result.winner ? match.result.winner === context.ownerSide : null;
    if (won !== null) {
      summary.known += 1;
      if (won) summary.wins += 1;
      else summary.losses += 1;
    }
    summary.results.push({ match, won, ownerSide: context.ownerSide });
  }

  summary.matchesList.sort((a, b) => a.timestamp.sortValue - b.timestamp.sortValue);
  summary.results.sort((a, b) => a.match.timestamp.sortValue - b.match.timestamp.sortValue);
  summary.characters = [...summary.characterMap.entries()]
    .map(([character, count]) => ({ character, count }))
    .sort((a, b) => b.count - a.count || a.character.localeCompare(b.character));
  return summary;
}

function getOpponentStats(matches, ownerId) {
  const map = new Map();
  for (const match of matches) {
    const context = getOwnerContext(match, ownerId);
    if (!context) continue;
    const player = context.opponent;
    const key = player.steamId64 ? `steam:${player.steamId64}` : player.accountId ? `id:${player.accountId}` : "unknown";
    if (!map.has(key)) {
      map.set(key, {
        id: player.accountId,
        accountId: player.accountId,
        steamId64: player.steamId64 || null,
        steamName: player.steamName || null,
        replayLabel: player.replayLabel || "",
        matches: 0,
        wins: 0,
        losses: 0,
        known: 0,
        chars: new Map(),
        results: [],
        lastSeen: 0,
      });
    }
    const item = map.get(key);
    if (player.steamName) item.steamName = player.steamName;
    if (!item.replayLabel && player.replayLabel) item.replayLabel = player.replayLabel;
    if (player.steamId64) item.steamId64 = player.steamId64;
    item.matches += 1;
    item.lastSeen = Math.max(item.lastSeen, match.timestamp.sortValue);
    item.chars.set(player.character, (item.chars.get(player.character) || 0) + 1);
    const won = match.result.winner ? match.result.winner === context.ownerSide : null;
    if (won !== null) {
      item.known += 1;
      if (won) item.wins += 1;
      else item.losses += 1;
    }
    item.results.push({ match, won });
  }
  return [...map.values()].map((p) => ({
    ...p,
    characters: [...p.chars.entries()]
      .map(([character, count]) => ({ character, count }))
      .sort((a, b) => b.count - a.count || a.character.localeCompare(b.character)),
  })).sort((a, b) => b.matches - a.matches || b.lastSeen - a.lastSeen || getSteamDisplayName(a).localeCompare(getSteamDisplayName(b)));
}

function getOpponentCharacterStats(matches, ownerId) {
  const map = new Map();
  for (const match of matches) {
    const context = getOwnerContext(match, ownerId);
    if (!context) continue;
    const character = context.opponent.character;
    if (!map.has(character)) map.set(character, { character, matches: 0, wins: 0, losses: 0, known: 0, results: [] });
    const item = map.get(character);
    item.matches += 1;
    const won = match.result.winner ? match.result.winner === context.ownerSide : null;
    if (won !== null) {
      item.known += 1;
      if (won) item.wins += 1;
      else item.losses += 1;
    }
    item.results.push({ match, won });
  }
  return [...map.values()].map((item) => {
    item.results.sort((a, b) => a.match.timestamp.sortValue - b.match.timestamp.sortValue);
    const known = item.results.filter((result) => result.won !== null);
    const recent = known.slice(-10);
    const previous = known.slice(Math.max(0, known.length - 20), Math.max(0, known.length - 10));
    const recentRate = recent.length ? rateNumber(countWins(recent), recent.length) : null;
    const previousRate = previous.length ? rateNumber(countWins(previous), previous.length) : null;
    return {
      ...item,
      recentRate,
      recentCount: recent.length,
      recentDelta: recentRate !== null && previousRate !== null ? recentRate - previousRate : null,
    };
  }).sort((a, b) => b.matches - a.matches || a.character.localeCompare(b.character));
}

function takeKnownResults(results, count, fromEnd) {
  const known = results.filter((item) => item.won !== null);
  return fromEnd ? known.slice(-count) : known.slice(0, count);
}

function countWins(results) {
  return results.reduce((sum, item) => sum + (item.won ? 1 : 0), 0);
}

function rateNumber(wins, total) {
  return total ? (wins / total) * 100 : null;
}

function formatRate(wins, total) {
  const rate = rateNumber(wins, total);
  if (rate === null) return "—";
  const rounded = Math.round(rate * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatSignedPoints(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}pp`;
}

function formatTrend(delta, recentRate, recentCount) {
  if (recentRate === null) return "近期 —";
  if (delta === null) return `近 ${recentCount} 场 ${formatPercentNumber(recentRate)}`;
  return `近 ${recentCount} 场 ${formatPercentNumber(recentRate)} · ${formatSignedPoints(delta)}`;
}

function formatPercentNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function trendClass(delta) {
  if (delta === null || Math.abs(delta) < 0.05) return "flat";
  return delta > 0 ? "up" : "down";
}

function calculateStreaks(results) {
  let longestWin = 0;
  let longestLoss = 0;
  let runWon = null;
  let runCount = 0;
  for (const result of results) {
    if (result.won === runWon) runCount += 1;
    else {
      runWon = result.won;
      runCount = 1;
    }
    if (runWon) longestWin = Math.max(longestWin, runCount);
    else longestLoss = Math.max(longestLoss, runCount);
  }
  return {
    current: { won: runWon, count: runCount },
    longestWin,
    longestLoss,
  };
}

function calculateActivity(matches) {
  const byDay = new Map();
  for (const match of matches) {
    const key = formatDate(match.timestamp);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }
  const peak = [...byDay.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || ["—", 0];
  return {
    activeDays: byDay.size,
    averagePerDay: byDay.size ? Math.round((matches.length / byDay.size) * 10) / 10 : 0,
    peakDate: peak[0],
    peakCount: peak[1],
  };
}

function rollingWinRate(results, requestedWindow) {
  const window = Math.min(requestedWindow, Math.max(1, results.length));
  const points = results.map((result, index) => {
    const sample = results.slice(Math.max(0, index - window + 1), index + 1);
    return {
      rate: rateNumber(countWins(sample), sample.length),
      match: result.match,
      sample: sample.length,
    };
  });
  return { window, points };
}

function renderWinRateChart(points) {
  if (!points.length) return `<div class="empty-state compact">没有可绘制的赛果</div>`;
  const left = 20;
  const right = 780;
  const top = 18;
  const bottom = 150;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? (left + right) / 2 : left + (index / (points.length - 1)) * (right - left);
    const y = bottom - (point.rate / 100) * (bottom - top);
    return { ...point, x, y };
  });
  const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${left},${bottom} ${line} ${right},${bottom}`;
  const markers = coords;
  return `<svg class="winrate-chart" viewBox="0 0 800 170" preserveAspectRatio="none" role="img" aria-label="本机滚动胜率变化">
    <line class="chart-grid" x1="${left}" y1="${bottom - (bottom - top) * 0.5}" x2="${right}" y2="${bottom - (bottom - top) * 0.5}"></line>
    <polygon class="chart-area" points="${area}"></polygon>
    <polyline class="chart-line" points="${line}"></polyline>
    ${markers.map((point) => `<circle class="chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3" tabindex="0" role="button" data-detail="${point.match.slot}" aria-label="${formatDate(point.match.timestamp)} · ${formatPercentNumber(point.rate)} · ${point.sample} 场窗口，打开对局详情"><title>${formatDate(point.match.timestamp)} · ${formatPercentNumber(point.rate)} · ${point.sample} 场窗口 · 点击查看对局</title></circle>`).join("")}
  </svg>`;
}

function steamProfileLink(player, label = "") {
  const accountId = player?.accountId ?? player?.id;
  const visible = label || (accountId ? `#${accountId}` : "Steam 未记录");
  const steamId64 = validSteamId64(player);
  if (!steamId64) return `<span class="steam-id unavailable">${escapeHtml(visible)}</span>`;
  const url = steamProfileUrl(player);
  const clientUrl = `steam://url/SteamIDPage/${steamId64}`;
  return `<span class="steam-links"><a class="steam-id" href="${url}" target="_blank" rel="noopener noreferrer" title="SteamID64 ${steamId64}">${escapeHtml(visible)} ↗</a><a class="steam-client" href="${clientUrl}" title="在 Steam 客户端打开">CLIENT</a></span>`;
}

function steamProfileUrl(player) {
  const steamId64 = validSteamId64(player);
  return steamId64 ? `https://steamcommunity.com/profiles/${steamId64}` : "";
}

function metric(label, value, detail, tone) {
  return `<article class="metric ${tone}"><span>${label}</span><b>${value}</b><small>${detail}</small></article>`;
}

function avatar(character, size = "normal", side = "p1") {
  const characterId = CHARACTER_BY_ID.indexOf(character);
  const fileId = String(Math.max(0, characterId)).padStart(3, "0");
  const source = characterId < 0
    ? `./assets/characters/${encodeURIComponent(character)}.png`
    : size === "large"
      ? `./assets/portraits/prof_chr${fileId}.png`
      : `./assets/faces/face_chr${fileId}_${side === "p2" ? "2p" : "1p"}.bmp`;
  return `<img class="avatar ${size}" src="${source}" alt="${escapeHtml(character)}" loading="lazy" />`;
}

function formatDate(ts, full = false) {
  const value = `${ts.year}-${pad(ts.month)}-${pad(ts.day)}`;
  return full ? `${value} ${formatTime(ts)}` : value;
}

function formatTime(ts) {
  return `${pad(ts.hour)}:${pad(ts.minute)}:${pad(ts.second)}`;
}

function getDateRange(matches) {
  if (!matches.length) return "NO MATCHES";
  const sorted = [...matches].sort((a, b) => a.timestamp.sortValue - b.timestamp.sortValue);
  return `${formatDate(sorted[0].timestamp)} — ${formatDate(sorted.at(-1).timestamp)}`;
}

function serializeMatch(match) {
  const context = getOwnerContext(match, state.dataset.ownerId);
  const ownerWon = match.result.winner && context ? match.result.winner === context.ownerSide : null;
  return {
    slot: match.slot,
    timestamp: formatDate(match.timestamp, true),
    p1: { steamName: match.p1.steamName, replayLabel: match.p1.replayLabel, accountId: match.p1.accountId, steamId64: match.p1.steamId64, character: match.p1.character, rip: match.p1.rip ?? null },
    p2: { steamName: match.p2.steamName, replayLabel: match.p2.replayLabel, accountId: match.p2.accountId, steamId64: match.p2.steamId64, character: match.p2.character, rip: match.p2.rip ?? null },
    winner: match.result.winner,
    ownerResult: ownerWon === null ? null : ownerWon ? "win" : "loss",
    score: confirmedScore(match.result),
    rounds: match.roundCount,
    scoreSource: confirmedScore(match.result) ? match.result.scoreSource : null,
    ownerRoundPath: ownerRoundPath(match),
    firstRoundWinner: match.result.firstRoundWinner,
    trajectory: match.result.trajectory,
    metadata: match.metadata || null,
    roundDetails: match.rounds.map((round) => ({ index: round.index, result: round.result || null, startState: round.startState || null })),
  };
}

function ownerRoundPath(match) {
  const context = getOwnerContext(match, state.dataset.ownerId);
  if (!context) return "";
  return (match.rounds || []).map((round) => round.result?.outcome === "draw" ? "D"
    : ["p1", "p2"].includes(round.result?.winner) ? round.result.winner === context.ownerSide ? "W" : "L" : "?").join("");
}

function ownerResultLabel(match) {
  const context = getOwnerContext(match, state.dataset.ownerId);
  if (!context || !match.result.winner) return "";
  return match.result.winner === context.ownerSide ? "win" : "loss";
}

function createDemoMatches() {
  const fixtures = [
    ["DEMO_ASTER", 200000001, "Tsurugi", "本机玩家", DEMO_OWNER_ID, "Kuon", "p2", 2, 7240],
    ["DEMO_NIGHT", 200000002, "Gordeau", "本机玩家", DEMO_OWNER_ID, "Kuon", "p1", 2, 6488],
    ["本机玩家", DEMO_OWNER_ID, "Byakuya", "DEMO_SAFFRON", 200000003, "Chaos", "p1", 3, 9320],
    ["本机玩家", DEMO_OWNER_ID, "Kaguya", "DEMO_KITE", 200000002, "Hyde", "p2", 2, 8035],
    ["DEMO_GLASS", 200000004, "Linne", "本机玩家", DEMO_OWNER_ID, "Kuon", "p2", 3, 10544],
    ["本机玩家", DEMO_OWNER_ID, "Kuon", "DEMO_BLUE", 200000005, "Orie", "p1", 2, 5980],
    ["DEMO_NORTH", 200000006, "Izumi", "本机玩家", DEMO_OWNER_ID, "Phonon", "p1", 3, 11180],
    ["本机玩家", DEMO_OWNER_ID, "Phonon", "DEMO_IRON", 200000007, "Ogre", "p2", 2, 7460],
    ["DEMO_SNOW", 200000008, "Londrekia", "本机玩家", DEMO_OWNER_ID, "Kuon", "p2", 2, 6920],
    ["本机玩家", DEMO_OWNER_ID, "Kuon", "DEMO_LAMP", 200000009, "Vatista", "p1", 2, 6180],
    ["DEMO_ARC", 200000010, "Yuzuriha", "本机玩家", DEMO_OWNER_ID, "Kaguya", "p1", 3, 12420],
    ["本机玩家", DEMO_OWNER_ID, "Kaguya", "DEMO_MASK", 200000011, "Byakuya", "p1", 2, 5840],
  ];
  return Array.from({ length: 144 }, (_, i) => {
    const f = [...fixtures[i % fixtures.length]];
    const variant = Math.floor(i / fixtures.length) % 3;
    if (f[1] !== DEMO_OWNER_ID) { f[1] += variant * 100; f[0] += `_${variant+1}`; }
    if (f[4] !== DEMO_OWNER_ID) { f[4] += variant * 100; f[3] += `_${variant+1}`; }
    if (Math.floor(i / fixtures.length) % 4 === 0) f[6] = f[6] === "p1" ? "p2" : "p1";
    const date = new Date(2026, 4, 26 - Math.floor(i/6), 21, 55 - (i%6)*6, 16);
    const ts = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), milliseconds: 0, sortValue: date.getTime() };
    const winner = f[6], loser = winner === "p1" ? "p2" : "p1";
    const path = f[7] === 2 ? [winner,winner] : i % 2 ? [loser,winner,winner] : [winner,loser,winner];
    const marks = { p1: [], p2: [] };
    const rounds = path.map((side, r) => {
      const round = { index: r + 1, startState: { valid: true, scoreP1: marks.p1.length, scoreP2: marks.p2.length,
        winMarksP1: [...marks.p1], winMarksP2: [...marks.p2], source: "synthetic-demo",
        exsP1: r ? (i * 1307 + r * 4171) % 20001 : 0, exsP2: r ? (i * 2311 + r * 5077) % 20001 : 0,
        exsSource: "synthetic-demo" } };
      marks[side].push((i+r) % 11 === 0 ? 3 : (i+r) % 37 === 0 ? 4 : 1);
      return round;
    });
    const derived = deriveRoundResults(rounds, winner);
    rounds.forEach((round,r) => { round.result = derived.results[r]; });
    return {
      slot: 399 - i,
      timestamp: ts,
      p1: demoPlayer("p1", f[0], f[1], f[2]),
      p2: demoPlayer("p2", f[3], f[4], f[5]),
      result: {
        ...Object.fromEntries(Object.entries(derived).filter(([key]) => !["results", "warnings"].includes(key))),
        winner,
        confidence: "demo",
      },
      roundCount: f[7],
      rounds,
      warnings: ["演示数据：赛果为程序合成，不来自真实对战。"],
    };
  }).sort((a, b) => b.timestamp.sortValue - a.timestamp.sortValue);
}

function demoPlayer(side, steamName, accountId, character) {
  const steamId64 = null;
  return { side, steamName, replayLabel: "", accountId, steamId64, character, characterId: CHARACTER_BY_ID.indexOf(character), isOwner: accountId === DEMO_OWNER_ID };
}

function showLoading(active) {
  elements.landing.hidden = active;
  elements.dashboard.hidden = true;
  elements.loading.hidden = !active;
}

function showDashboard() {
  elements.loading.hidden = true;
  elements.landing.hidden = true;
  elements.dashboard.hidden = false;
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? "instant" : "smooth" });
}

function toast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 4200);
}

function downloadBlob(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

window.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) {
    event.target.classList.add("missing");
    event.target.removeAttribute("src");
  }
}, true);

const initialParams = new URLSearchParams(location.search);
if (initialParams.has("demo")) {
  loadDemo();
  activateTab(initialParams.get("tab") || "overview");
}
