export const PLAYERDB_STEAM_ENDPOINT = "https://playerdb.co/api/player/steam";

const STEAM_ID64_PATTERN = /^\d{17}$/;
const MAX_STEAM_NAME_LENGTH = 128;

export function validSteamId64(playerOrId) {
  const value = typeof playerOrId === "object" && playerOrId !== null
    ? playerOrId.steamId64
    : playerOrId;
  const steamId64 = String(value || "").trim();
  return STEAM_ID64_PATTERN.test(steamId64) ? steamId64 : "";
}

export function getSteamDisplayName(player, fallback = "未记录 ID") {
  const steamName = normalizeSteamName(player?.steamName);
  if (steamName) return steamName;
  const steamId64 = validSteamId64(player);
  if (steamId64) return steamId64;
  const accountId = String(player?.accountId ?? player?.id ?? "").trim();
  return accountId || fallback;
}

export async function fetchSteamName(
  steamId64,
  {
    fetchImpl = globalThis.fetch,
    endpoint = PLAYERDB_STEAM_ENDPOINT,
    signal,
  } = {},
) {
  const requestedId = validSteamId64(steamId64);
  if (!requestedId) throw new Error("SteamID64 必须是 17 位数字。");
  if (typeof fetchImpl !== "function") throw new Error("当前环境不支持网络请求。");

  const base = String(endpoint || PLAYERDB_STEAM_ENDPOINT).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/${encodeURIComponent(requestedId)}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response?.ok) throw new Error(`PlayerDB HTTP ${response?.status ?? "ERROR"}`);

  const payload = await response.json();
  if (payload?.code !== "player.found") throw new Error("PlayerDB 未返回成功结果。");

  const player = payload?.data?.player;
  if (!player || typeof player !== "object") throw new Error("PlayerDB 响应缺少 player。");

  const returnedIds = [
    player.id,
    player.meta?.steam64id,
    player.meta?.steamid64,
    player.meta?.steamid,
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => STEAM_ID64_PATTERN.test(value));
  if (!returnedIds.length || returnedIds.some((value) => value !== requestedId)) {
    throw new Error("PlayerDB 返回了不匹配的 SteamID。");
  }

  const steamName = normalizeSteamName(player.username)
    || normalizeSteamName(player.meta?.personaname);
  if (!steamName) throw new Error("PlayerDB 返回的昵称无效。");
  return steamName;
}

export async function hydrateSteamNames(
  matches,
  {
    concurrency = 4,
    fetchImpl = globalThis.fetch,
    endpoint = PLAYERDB_STEAM_ENDPOINT,
    signal,
  } = {},
) {
  const playersById = new Map();
  for (const match of matches || []) {
    for (const player of [match?.p1, match?.p2]) {
      const steamId64 = validSteamId64(player);
      if (!steamId64) continue;
      if (!playersById.has(steamId64)) playersById.set(steamId64, []);
      playersById.get(steamId64).push(player);
    }
  }

  const ids = [...playersById.keys()];
  const names = new Map();
  const failures = [];
  let cursor = 0;
  const requestedConcurrency = Number.isFinite(Number(concurrency)) ? Math.trunc(Number(concurrency)) : 4;
  const workerCount = Math.min(ids.length, Math.max(1, Math.min(8, requestedConcurrency)));

  async function worker() {
    while (cursor < ids.length) {
      if (signal?.aborted) throw abortError();
      const steamId64 = ids[cursor];
      cursor += 1;
      try {
        const steamName = await fetchSteamName(steamId64, { fetchImpl, endpoint, signal });
        names.set(steamId64, steamName);
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        names.set(steamId64, null);
        failures.push({ steamId64, message: error?.message || String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  if (signal?.aborted) throw abortError();

  for (const [steamId64, players] of playersById) {
    const steamName = names.get(steamId64) || null;
    for (const player of players) player.steamName = steamName;
  }

  return {
    requested: ids.length,
    resolved: ids.length - failures.length,
    failed: failures.length,
    failures,
  };
}

function normalizeSteamName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim();
  if (!name || name.length > MAX_STEAM_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return "";
  return name;
}

function abortError() {
  const error = new Error("Steam 昵称查询已取消。");
  error.name = "AbortError";
  return error;
}
