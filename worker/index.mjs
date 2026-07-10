const PROTOCOL_VERSION = 1;
const RULES_VERSION = "duel-v1";
const MATCH_MS = 180_000;
const COUNTDOWN_MS = 5_000;
const SETTLE_MS = 1_000;
const DISCONNECT_GRACE_MS = 15_000;
const LOBBY_TTL_MS = 10 * 60_000;
const REPLAY_TTL_MS = 30 * 60_000;
const MAX_OBS = 10;
const MAX_MOVES = 500;
const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_RECEIPTS = 8192;
const RECEIPT_TTL_MS = 30 * 60_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ANONYMOUS_SOCKETS = 4;
// Durable Object alarms are coarse-grained; keep the persisted deadline short
// while allowing the runtime to deliver the alarm with its normal jitter.
const JOIN_TIMEOUT_MS = 15_000;
const EMPTY_GRID_HASH = "eb7b0297e5b6b33f6680cf9c6b471903832a5caceda3debf8e52cda0a40ab9c3";
const PIECE_DEFS = [
  [[1,1,1,1,1]],[[1],[1],[1],[1],[1]],[[1,1,1,1]],[[1],[1],[1],[1]],[[1,1,1]],[[1],[1],[1]],[[1,1],[1,1]],
  [[1,1,1],[1,1,1]],[[1,1],[1,1],[1,1]],[[1,1,1],[1,1,1],[1,1,1]],[[1,1,1],[1,0,0],[1,0,0]],
  [[1,1,1],[0,0,1],[0,0,1]],[[1,0,0],[1,0,0],[1,1,1]],[[0,0,1],[0,0,1],[1,1,1]],[[1,1],[1,0],[1,0]],
  [[1,1],[0,1],[0,1]],[[1,0],[1,0],[1,1]],[[0,1],[0,1],[1,1]],[[0,1,1],[1,1,0]],[[1,1,0],[0,1,1]],
  [[1,0],[1,1],[0,1]],[[0,1],[1,1],[1,0]],[[1,1,1],[0,1,0]],[[0,1,0],[1,1,1]],[[1,0],[1,1],[1,0]],
  [[0,1],[1,1],[0,1]],[[1,1],[1,0]],[[1,1],[0,1]],[[1,0],[1,1]],[[0,1],[1,1]],[[1]],
];

const encoder = new TextEncoder();

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function sha256Text(value) {
  return hex(await sha256Bytes(encoder.encode(value)));
}

function randomHex(bytes = 16) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function uint16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function uint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError("expected uint32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function attackSeedMaterial(matchId, sourcePlayerId, sourceMoveSeq, matchSeed) {
  const prefix = new Uint8Array([...encoder.encode("attack-v1"), 0]);
  const match = encoder.encode(matchId);
  const player = encoder.encode(sourcePlayerId);
  if (match.length > 0xffff || player.length > 0xffff) throw new RangeError("id is too long");
  const parts = [prefix, uint16(match.length), match, uint16(player.length), player, uint32(sourceMoveSeq), uint32(matchSeed)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function deriveAttackSeed(matchId, sourcePlayerId, sourceMoveSeq, matchSeed) {
  const digest = await sha256Bytes(attackSeedMaterial(matchId, sourcePlayerId, sourceMoveSeq, matchSeed));
  return { digest: hex(digest), state: new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) };
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleEmptyCells(emptyCells, seed) {
  const cells = [...emptyCells];
  const next = mulberry32(seed);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells;
}

export function createRoom(roomId, now = Date.now(), mode = "score") {
  return {
    roomId,
    mode: mode === "attack" ? "attack" : "score",
    status: "lobby",
    roomRevision: 0,
    roomCreatedAt: now,
    roomExpiresAt: now + LOBBY_TTL_MS,
    replayExpiresAt: null,
    rulesVersion: RULES_VERSION,
    matchId: null,
    seed: null,
    startsAt: null,
    endsAt: null,
    settleDeadline: null,
    durationMs: MATCH_MS,
    players: {},
    nextPlayerNumber: 1,
    receipts: {},
    result: null,
    replay: null,
    replayUnavailableReason: null,
  };
}

function newPlayer(playerId, tokenHash, pageInstanceId, name) {
  return {
    playerId,
    tokenHash,
    pageInstanceId,
    name: String(name || playerId).slice(0, 24),
    ready: false,
    rematchReady: false,
    connected: true,
    disconnectedAt: null,
    forfeited: false,
    score: 0,
    lines: 0,
    gameOver: false,
    frozen: false,
    lastMoveSeq: 0,
    lastBoardEventSeq: 0,
    lastAppliedBoardEventSeq: 0,
    obstacleCount: 0,
    pendingAttacks: [],
    moveReservation: null,
    committedAttack: null,
    finalBoardHash: EMPTY_GRID_HASH,
    initialGrid: ".".repeat(81),
    moves: [],
    attacks: [],
    moveAcks: {},
  };
}

export async function joinPlayer(room, { playerToken, pageInstanceId, name, mode }, now = Date.now()) {
  if (!pageInstanceId || typeof pageInstanceId !== "string" || pageInstanceId.length > 128) {
    return { error: "invalid_page_instance" };
  }
  if (playerToken) {
    const tokenHash = await sha256Text(playerToken);
    const player = Object.values(room.players).find((candidate) => candidate.tokenHash === tokenHash);
    if (!player) return { error: "invalid_player_token" };
    if (player.pageInstanceId !== pageInstanceId) {
      if (room.status === "lobby") {
        player.pageInstanceId = pageInstanceId;
      } else if (["countdown", "playing", "settling"].includes(room.status)) {
        player.forfeited = true;
        freezePlayer(room, player.playerId, now);
        await finalizeRoom(room, now);
        return { error: "page_instance_mismatch" };
      } else {
        return { error: "page_instance_mismatch" };
      }
    }
    player.connected = true;
    player.disconnectedAt = null;
    room.roomRevision += 1;
    return { player, playerToken, reconnected: true };
  }
  if (Object.keys(room.players).length >= 2) return { error: "room_full" };
  if (Object.keys(room.players).length === 0 && mode) room.mode = mode === "attack" ? "attack" : "score";
  const token = randomHex(24);
  if (!Number.isInteger(room.nextPlayerNumber)) {
    room.nextPlayerNumber = Math.max(0, ...Object.keys(room.players).map((id) => Number(id.split("-").at(-1)) || 0)) + 1;
  }
  const playerId = `player-${room.nextPlayerNumber++}`;
  const player = newPlayer(playerId, await sha256Text(token), pageInstanceId, name);
  room.players[playerId] = player;
  room.roomRevision += 1;
  room.roomExpiresAt = Math.max(room.roomExpiresAt, now + LOBBY_TTL_MS);
  return { player, playerToken: token, reconnected: false };
}

function publicPlayer(player) {
  const { tokenHash: _tokenHash, ...safe } = player;
  return safe;
}

export function roomSnapshot(room) {
  return {
    roomId: room.roomId,
    mode: room.mode,
    status: room.status,
    roomRevision: room.roomRevision,
    rulesVersion: room.rulesVersion,
    matchId: room.matchId,
    seed: room.seed,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    settleDeadline: room.settleDeadline,
    durationMs: room.durationMs,
    players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => [id, publicPlayer(player)])),
    result: room.result,
    replayExpiresAt: room.replayExpiresAt,
    replayAvailable: Boolean(room.replay),
    replayUnavailableReason: room.replayUnavailableReason,
  };
}

export function startMatch(room, now = Date.now(), seed = crypto.getRandomValues(new Uint32Array(1))[0]) {
  room.matchId = `${now.toString(36)}-${randomHex(6)}`;
  room.seed = seed >>> 0;
  room.status = "countdown";
  room.startsAt = now + COUNTDOWN_MS;
  room.endsAt = room.startsAt + MATCH_MS;
  room.settleDeadline = null;
  room.result = null;
  for (const player of Object.values(room.players)) {
    Object.assign(player, newPlayer(player.playerId, player.tokenHash, player.pageInstanceId, player.name), {
      connected: player.connected,
      ready: true,
    });
  }
  room.roomExpiresAt = Math.max(room.endsAt + DISCONNECT_GRACE_MS, room.replayExpiresAt || 0);
  room.roomRevision += 1;
}

async function commandFingerprint(command) {
  return sha256Text(stableStringify({ type: command.type, matchId: command.matchId ?? null, payload: command.payload ?? {} }));
}

function response(type, payload = {}) {
  return { type, payload };
}

function invalidIndices(values) {
  return !Array.isArray(values) || values.some((value) => !Number.isInteger(value) || value < 0 || value > 8) || new Set(values).size !== values.length;
}

function validHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function activeMatch(room, player, now, allowSettling = false) {
  if (player.frozen || player.gameOver || player.forfeited) return "player_frozen";
  if (room.status === "countdown" && now >= room.startsAt && Object.values(room.players).every((entry) => entry.connected)) room.status = "playing";
  if (room.status === "playing" && now >= room.endsAt) enterSettling(room);
  if (room.status !== "playing" && !(allowSettling && room.status === "settling")) return "match_not_playing";
  return null;
}

function enterSettling(room) {
  if (room.status === "settling" || room.status === "finished") return;
  room.status = "settling";
  room.settleDeadline = room.endsAt + SETTLE_MS;
  for (const player of Object.values(room.players)) player.pendingAttacks = [];
  room.roomRevision += 1;
}

function resetToLobby(room, now) {
  room.status = "lobby";
  room.matchId = null;
  room.seed = null;
  room.startsAt = null;
  room.endsAt = null;
  room.settleDeadline = null;
  room.result = null;
  room.roomExpiresAt = Math.max(room.roomExpiresAt, now + LOBBY_TTL_MS, room.replayExpiresAt || 0);
  for (const player of Object.values(room.players)) {
    player.ready = false;
    player.rematchReady = false;
  }
}

export function enqueueAttack(room, sourcePlayerId, count, attackSeed = 0) {
  const source = room.players[sourcePlayerId];
  const target = Object.values(room.players).find((player) => player.playerId !== sourcePlayerId);
  if (!source || !target || target.frozen || room.status !== "playing" || count <= 0) return null;
  const attack = {
    attackId: `${room.matchId}:${sourcePlayerId}:${source.lastMoveSeq}`,
    count,
    attackSeed,
    sourcePlayerId,
    sourceMoveSeq: source.lastMoveSeq,
    createdRoomRevision: room.roomRevision + 1,
    status: "pending",
  };
  target.pendingAttacks.push(attack);
  target.pendingAttacks.sort((a, b) => a.createdRoomRevision - b.createdRoomRevision || a.attackId.localeCompare(b.attackId));
  return attack;
}

export function freezePlayer(room, playerId, now = Date.now()) {
  const player = room.players[playerId];
  if (!player || player.frozen) return false;
  player.frozen = true;
  player.gameOver = true;
  player.moveReservation = null;
  player.pendingAttacks = [];
  player.committedAttack = null;
  player.finalBoardHash ||= player.moves.at(-1)?.boardHash || EMPTY_GRID_HASH;
  if (Object.values(room.players).length === 2 && Object.values(room.players).every((entry) => entry.gameOver || entry.forfeited)) {
    room.status = "settling";
    room.settleDeadline = Math.min(room.endsAt + SETTLE_MS, now + SETTLE_MS);
  }
  return true;
}

function receiptKey(playerId, commandId) {
  return `${playerId}:${commandId}`;
}

export function pruneReceipts(room, now = Date.now()) {
  room.receipts ||= {};
  for (const [key, receipt] of Object.entries(room.receipts)) {
    if (!receipt || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now) delete room.receipts[key];
  }
  return Object.keys(room.receipts).length;
}

function storeReceipt(room, playerId, command, fingerprint, reply, now = Date.now()) {
  room.receipts[receiptKey(playerId, command.commandId)] = {
    fingerprint,
    response: structuredClone(reply),
    expiresAt: Math.min(room.roomExpiresAt, now + RECEIPT_TTL_MS),
  };
}

function winnerResult(room, now) {
  const players = Object.values(room.players);
  const forfeited = players.filter((player) => player.forfeited);
  const unableToMove = room.status === "playing"
    ? players.filter((player) => player.gameOver && !player.forfeited)
    : [];
  let reason = "score";
  let winnerId = null;
  if (forfeited.length === players.length) reason = "both_forfeit";
  else if (forfeited.length === 1) {
    reason = "forfeit";
    winnerId = players.find((player) => !player.forfeited)?.playerId || null;
  } else if (unableToMove.length === 1) {
    reason = "no_moves";
    winnerId = players.find((player) => player.playerId !== unableToMove[0].playerId)?.playerId || null;
  } else if (players.length === 2 && players[0].score === players[1].score) reason = "draw";
  else winnerId = [...players].sort((a, b) => b.score - a.score)[0]?.playerId || null;
  return {
    matchId: room.matchId,
    winnerId,
    reason,
    scores: Object.fromEntries(players.map((player) => [player.playerId, player.score])),
    forfeitedPlayerIds: forfeited.map((player) => player.playerId),
    unableToMovePlayerIds: unableToMove.map((player) => player.playerId),
    finishedAt: now,
  };
}

function replayGrid(player) {
  if (typeof player.initialGrid !== "string" || player.initialGrid.length !== 81) throw new Error("invalid grid");
  const grid = [...player.initialGrid];
  const events = [...player.moves.map((event) => ({ ...event, kind: "move" })), ...player.attacks.map((event) => ({ ...event, kind: "attack" }))]
    .sort((a, b) => a.boardEventSeq - b.boardEventSeq);
  for (const event of events) {
    if (event.kind === "attack") {
      if (!Array.isArray(event.cells)) throw new Error("invalid attack");
      const empty = grid.map((cell, index) => cell === "." ? index : -1).filter((index) => index >= 0);
      const obstacleCount = grid.filter((cell) => cell === "X").length;
      const expected = shuffleEmptyCells(empty, event.attackSeed).slice(0, Math.min(event.count, MAX_OBS - obstacleCount, empty.length));
      if (expected.length !== event.cells.length || expected.some((cell, index) => cell !== event.cells[index])) throw new Error("invalid attack rng");
      for (const cell of event.cells) {
        if (!Number.isInteger(cell) || cell < 0 || cell >= 81 || grid[cell] !== ".") throw new Error("invalid attack cell");
        grid[cell] = "X";
      }
      continue;
    }
    const shape = PIECE_DEFS[event.d];
    if (!shape || !Number.isInteger(event.c) || event.c < 0 || event.c > 8 || !Number.isInteger(event.r) || !Number.isInteger(event.col)) throw new Error("invalid move");
    for (let r = 0; r < shape.length; r += 1) for (let c = 0; c < shape[r].length; c += 1) if (shape[r][c]) {
      const row = event.r + r;
      const col = event.col + c;
      const index = row * 9 + col;
      if (row < 0 || row >= 9 || col < 0 || col >= 9 || grid[index] !== ".") throw new Error("invalid move cell");
      grid[index] = String(event.c + 1);
    }
    const rows = [];
    const cols = [];
    for (let r = 0; r < 9; r += 1) if (grid.slice(r * 9, r * 9 + 9).every((cell) => cell !== ".")) rows.push(r);
    for (let c = 0; c < 9; c += 1) if (Array.from({ length: 9 }, (_, r) => grid[r * 9 + c]).every((cell) => cell !== ".")) cols.push(c);
    for (const r of rows) for (let c = 0; c < 9; c += 1) grid[r * 9 + c] = ".";
    for (const c of cols) for (let r = 0; r < 9; r += 1) grid[r * 9 + c] = ".";
    for (const obstacle of event.obs || []) {
      if (!Array.isArray(obstacle) || obstacle.length !== 2) throw new Error("invalid obstacle");
      const [r, c] = obstacle;
      const index = r * 9 + c;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= 9 || c < 0 || c >= 9 || grid[index] !== ".") throw new Error("invalid obstacle cell");
      grid[index] = "X";
    }
  }
  return grid.join("");
}

function expectedAttackCells(player, attack) {
  const grid = [...replayGrid(player)];
  const empty = grid.map((cell, index) => cell === "." ? index : -1).filter((index) => index >= 0);
  const obstacleCount = grid.filter((cell) => cell === "X").length;
  return shuffleEmptyCells(empty, attack.attackSeed).slice(0, Math.min(attack.count, MAX_OBS - obstacleCount, empty.length));
}

export async function validateReplayBundle(bundle) {
  if (!bundle || bundle.formatVersion !== 1 || !Array.isArray(bundle.players) || bundle.players.length !== 2 || !bundle.result || typeof bundle.result !== "object" || !bundle.result.scores || typeof bundle.result.scores !== "object") return "invalid_format";
  for (const player of bundle.players) {
    if (!validHash(player.finalBoardHash) || !Number.isInteger(player.finalBoardEventSeq) || player.moves.length > MAX_MOVES) return "integrity_mismatch";
    const events = [...player.moves, ...player.attacks].sort((a, b) => a.boardEventSeq - b.boardEventSeq);
    if (events.length !== player.finalBoardEventSeq || events.some((event, index) => event.boardEventSeq !== index + 1)) return "integrity_mismatch";
    if (player.finalScore !== bundle.result.scores[player.playerId]) return "integrity_mismatch";
    if (player.moves.length && player.moves.at(-1).s !== player.finalScore) return "integrity_mismatch";
    if (!player.moves.length && player.finalScore !== 0) return "integrity_mismatch";
    try {
      if (await sha256Text(replayGrid(player)) !== player.finalBoardHash) return "integrity_mismatch";
    } catch {
      return "integrity_mismatch";
    }
  }
  const participantIds = new Set(bundle.players.map((player) => player.playerId));
  const scoreEntries = bundle.result.scores && typeof bundle.result.scores === "object" ? Object.entries(bundle.result.scores) : [];
  if (participantIds.size !== 2 || scoreEntries.length !== 2 || scoreEntries.some(([id, score]) => !participantIds.has(id) || !Number.isFinite(score))) return "integrity_mismatch";
  const allowedReasons = new Set(["score", "draw", "forfeit", "both_forfeit", "no_moves"]);
  if (!allowedReasons.has(bundle.result.reason)) return "integrity_mismatch";
  const scores = scoreEntries.sort((a, b) => b[1] - a[1]);
  if (bundle.result.reason === "score" && (scores[0][1] === scores[1][1] || bundle.result.winnerId !== scores[0][0])) return "integrity_mismatch";
  if (bundle.result.reason === "draw" && (scores[0][1] !== scores[1][1] || bundle.result.winnerId !== null)) return "integrity_mismatch";
  if (bundle.result.reason === "forfeit") {
    const forfeited = bundle.result.forfeitedPlayerIds;
    const expectedWinner = bundle.players.find((player) => player.playerId !== forfeited?.[0])?.playerId || null;
    if (!Array.isArray(forfeited) || forfeited.length !== 1 || !participantIds.has(forfeited[0]) || bundle.result.winnerId !== expectedWinner) return "integrity_mismatch";
  }
  if (bundle.result.reason === "both_forfeit") {
    const forfeited = bundle.result.forfeitedPlayerIds;
    if (!Array.isArray(forfeited) || forfeited.length !== 2 || new Set(forfeited).size !== 2 || forfeited.some((id) => !participantIds.has(id)) || bundle.result.winnerId !== null) return "integrity_mismatch";
  }
  if (bundle.result.reason === "no_moves") {
    const unable = bundle.result.unableToMovePlayerIds;
    const expectedWinner = bundle.players.find((player) => player.playerId !== unable?.[0])?.playerId || null;
    if (!Array.isArray(unable) || unable.length !== 1 || !participantIds.has(unable[0]) || bundle.result.winnerId !== expectedWinner) return "integrity_mismatch";
  }
  return null;
}

export async function buildReplayBundle(room) {
  if (Object.values(room.players).some((player) => player.committedAttack || player.attacks.some((attack) => !validHash(attack.postBoardHash)))) {
    return { error: "integrity_mismatch" };
  }
  const bundle = {
    formatVersion: 1,
    rulesVersion: room.rulesVersion,
    matchId: room.matchId,
    seed: room.seed,
    startsAt: room.startsAt,
    durationMs: room.durationMs,
    players: Object.values(room.players).map((player) => ({
      playerId: player.playerId,
      name: player.name,
      initialGrid: player.initialGrid,
      finalBoardEventSeq: player.lastBoardEventSeq,
      finalBoardHash: player.finalBoardHash,
      finalScore: player.score,
      moves: player.moves.map(({ boardHash: _boardHash, ...move }) => move),
      attacks: player.attacks.map(({ postBoardHash: _postBoardHash, ...attack }) => attack),
    })),
    result: room.result,
  };
  const integrityError = await validateReplayBundle(bundle);
  if (integrityError) return { error: integrityError };
  if (encoder.encode(JSON.stringify(bundle)).length > MAX_REPLAY_BYTES) return { error: "size_limit" };
  return { bundle };
}

export async function finalizeRoom(room, now = Date.now()) {
  if (room.result) return room.result;
  room.result = winnerResult(room, now);
  room.status = "finished";
  room.replayExpiresAt = now + REPLAY_TTL_MS;
  room.roomExpiresAt = Math.max(room.roomExpiresAt, room.replayExpiresAt);
  const replay = await buildReplayBundle(room);
  room.replay = replay.bundle || null;
  room.replayUnavailableReason = replay.error || null;
  room.roomRevision += 1;
  return room.result;
}

export async function advanceRoomTime(room, now = Date.now()) {
  let changed = false;
  if (room.status === "countdown" && now >= room.startsAt && Object.values(room.players).every((player) => player.connected)) {
    room.status = "playing";
    room.roomRevision += 1;
    changed = true;
  }
  if (room.status === "playing" && now >= room.endsAt) {
    enterSettling(room);
    changed = true;
  }
  const expiredDisconnects = Object.values(room.players).filter((player) => !player.connected && player.disconnectedAt && !player.forfeited && now >= player.disconnectedAt + DISCONNECT_GRACE_MS);
  if (["lobby", "countdown"].includes(room.status) && !room.result && expiredDisconnects.length) {
    for (const player of expiredDisconnects) delete room.players[player.playerId];
    resetToLobby(room, now);
    room.roomRevision += 1;
    changed = true;
  }
  for (const player of expiredDisconnects) {
    if (!room.players[player.playerId]) continue;
    player.forfeited = true;
    freezePlayer(room, player.playerId, now);
    room.roomRevision += 1;
    changed = true;
  }
  if (Object.values(room.players).some((player) => player.forfeited) && !room.result) {
    await finalizeRoom(room, now);
    changed = true;
  } else if (room.status === "settling" && now >= room.settleDeadline) {
    await finalizeRoom(room, now);
    changed = true;
  }
  if (room.replay && room.replayExpiresAt && now >= room.replayExpiresAt) {
    room.replay = null;
    room.replayUnavailableReason = "expired";
    room.roomRevision += 1;
    changed = true;
  }
  return changed;
}

function finishReply(room, reply, mutated) {
  if (mutated) room.roomRevision += 1;
  if (!Number.isInteger(reply.roomRevision)) reply.roomRevision = room.roomRevision;
  return { response: reply, mutated };
}

export async function reduceRoomCommand(room, playerId, command, now = Date.now()) {
  if (!command || command.v !== PROTOCOL_VERSION || typeof command.type !== "string" || typeof command.commandId !== "string" || !command.commandId || command.commandId.length > 128) {
    return { response: response("protocol_error", { code: "invalid_envelope" }), mutated: false };
  }
  const receiptCount = pruneReceipts(room, now);
  const fingerprint = await commandFingerprint(command);
  const key = receiptKey(playerId, command.commandId);
  const prior = room.receipts[key];
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { response: response("protocol_error", { code: "command_id_conflict" }), mutated: false };
    return { response: structuredClone(prior.response), mutated: false, duplicate: true };
  }
  if (receiptCount >= MAX_RECEIPTS) return { response: response("protocol_error", { code: "receipt_limit" }), mutated: false };
  const player = room.players[playerId];
  if (!player) return { response: response("protocol_error", { code: "unknown_player" }), mutated: false };
  if (command.matchId != null && command.matchId !== room.matchId) return { response: response("protocol_error", { code: "match_mismatch" }), mutated: false };

  if (room.status === "finished" && ["move_intent", "move_commit", "attack_plan", "attack_applied", "game_over", "forfeit"].includes(command.type)) {
    const result = finishReply(room, response("match_finished", { replyToCommandId: command.commandId }), false);
    storeReceipt(room, playerId, command, fingerprint, result.response, now);
    return { ...result, receiptStored: true };
  }

  const payload = command.payload || {};
  let reply;
  let mutated = false;
  let removeAfterReceipt = false;
  let resetAfterLeave = false;

  if (command.type === "player_ready" || command.type === "ready") {
    if (room.status !== "lobby") reply = response("protocol_error", { code: "not_in_lobby" });
    else if (payload.rulesVersion !== RULES_VERSION) reply = response("protocol_error", { code: "rules_version_mismatch" });
    else {
      player.ready = payload.ready === true;
      mutated = true;
      reply = response("ready_ack", { ready: player.ready, replyToCommandId: command.commandId });
      if (Object.keys(room.players).length === 2 && Object.values(room.players).every((entry) => entry.ready)) startMatch(room, now);
    }
  } else if (command.type === "move_intent") {
    const inactive = activeMatch(room, player, now);
    if (inactive) reply = response("move_rejected", { code: inactive });
    else if (player.pendingAttacks.length || player.committedAttack) reply = response("move_rejected", { code: "attack_pending" });
    else if (player.moveReservation) reply = response("move_rejected", { code: "reservation_active" });
    else if (payload.baseBoardEventSeq !== player.lastBoardEventSeq) reply = response("move_rejected", { code: "stale_board" });
    else {
      player.moveReservation = {
        reservationId: `permit:${command.commandId}`,
        issuedAt: now,
        expiresAt: Math.min(now + DISCONNECT_GRACE_MS, room.endsAt + SETTLE_MS),
        intent: structuredClone(payload),
      };
      mutated = true;
      reply = response("move_permit", { reservationId: player.moveReservation.reservationId, replyToCommandId: command.commandId });
    }
  } else if (command.type === "move_commit") {
    const inactive = activeMatch(room, player, now, true);
    const reservation = player.moveReservation;
    if (inactive) reply = response("move_rejected", { code: inactive });
    else if (Number.isInteger(payload.moveSeq) && payload.moveSeq <= player.lastMoveSeq) {
      const priorAck = player.moveAcks[payload.moveSeq];
      reply = priorAck
        ? structuredClone(priorAck)
        : response("protocol_error", { code: "unknown_move_seq" });
    }
    else if (!reservation || payload.reservationId !== reservation.reservationId || now > reservation.expiresAt) reply = response("move_rejected", { code: "invalid_reservation" });
    else if (invalidIndices(payload.clearedRows || []) || invalidIndices(payload.clearedCols || []) || !validHash(payload.boardHash) ||
      !Number.isInteger(payload.t) || payload.t < 0 || payload.t > room.durationMs || payload.t < (player.moves.at(-1)?.t || 0) ||
      !Number.isFinite(payload.score) || payload.score < player.score || !Number.isFinite(payload.lines) || payload.lines < player.lines) reply = response("protocol_error", { code: "invalid_move" });
    else if ((payload.moveSeq ?? player.lastMoveSeq + 1) !== player.lastMoveSeq + 1) reply = response("move_gap", { expectedMoveSeq: player.lastMoveSeq + 1 });
    else {
      const moveSeq = ++player.lastMoveSeq;
      const boardEventSeq = ++player.lastBoardEventSeq;
      player.score = Number.isFinite(payload.score) ? payload.score : player.score;
      player.lines = Number.isFinite(payload.lines) ? payload.lines : player.lines;
      player.obstacleCount = Math.max(0, Math.min(MAX_OBS, payload.obstacleCount || 0));
      player.finalBoardHash = payload.boardHash;
      player.moves.push({
        boardEventSeq,
        moveSeq,
        t: payload.t,
        d: payload.move?.d,
        c: payload.move?.c,
        r: payload.move?.r,
        col: payload.move?.col,
        obs: payload.move?.obs || [],
        s: player.score,
        boardHash: payload.boardHash,
      });
      player.moveReservation = null;
      mutated = true;
      const clearCount = payload.clearedRows.length + payload.clearedCols.length;
      let attack = null;
      if (room.mode === "attack" && room.status === "playing" && now < room.endsAt && clearCount) {
        const seedInfo = await deriveAttackSeed(room.matchId, playerId, moveSeq, room.seed);
        attack = enqueueAttack(room, playerId, clearCount, seedInfo.state);
      }
      reply = response("move_ack", { moveSeq, boardEventSeq, attack, attackCount: attack?.count || 0, replyToCommandId: command.commandId });
    }
  } else if (command.type === "attack_plan") {
    const inactive = activeMatch(room, player, now);
    const head = player.pendingAttacks[0];
    const cells = payload.cells;
    const uniqueCells = Array.isArray(cells) && cells.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < 81) && new Set(cells).size === cells.length;
    if (inactive) reply = response("attack_rejected", { code: inactive });
    else if (player.moveReservation) reply = response("attack_rejected", { code: "move_reserved" });
    else if (player.committedAttack) reply = response("attack_rejected", { code: "attack_in_flight" });
    else if (!head || head.attackId !== payload.attackId) reply = response("attack_rejected", { code: "not_queue_head" });
    else if (payload.baseBoardEventSeq !== player.lastBoardEventSeq) reply = response("attack_rejected", { code: "stale_board" });
    else if (!uniqueCells) reply = response("protocol_error", { code: "invalid_attack_cells" });
    else {
      let expected;
      try { expected = expectedAttackCells(player, head); } catch { expected = null; }
      if (!expected || expected.length !== cells.length || expected.some((cell, index) => cell !== cells[index])) {
        reply = response("protocol_error", { code: "invalid_attack_cells" });
      } else {
        const boardEventSeq = ++player.lastBoardEventSeq;
        const committed = { ...head, boardEventSeq, t: payload.t, cells: [...cells], status: "committed" };
        player.pendingAttacks.shift();
        player.committedAttack = committed;
        player.attacks.push(committed);
        mutated = true;
        reply = response("attack_commit", { ...committed, replyToCommandId: command.commandId });
      }
    }
  } else if (command.type === "attack_applied") {
    const committed = player.committedAttack;
    if (!committed || payload.attackId !== committed.attackId || payload.boardEventSeq !== committed.boardEventSeq) reply = response("attack_rejected", { code: "no_committed_attack" });
    else if (!validHash(payload.postBoardHash) || !Number.isInteger(payload.postObstacleCount) || payload.postObstacleCount !== player.obstacleCount + committed.cells.length || payload.postObstacleCount > MAX_OBS) reply = response("protocol_error", { code: "invalid_attack_result" });
    else {
      player.lastAppliedBoardEventSeq = committed.boardEventSeq;
      player.finalBoardHash = payload.postBoardHash;
      player.obstacleCount = payload.postObstacleCount;
      player.attacks.at(-1).postBoardHash = payload.postBoardHash;
      player.committedAttack = null;
      if (payload.gameOver === true) {
        freezePlayer(room, playerId, now);
        if (room.status === "playing" && now < room.endsAt) await finalizeRoom(room, now);
      }
      mutated = true;
      reply = response("attack_applied_ack", { attackId: payload.attackId, boardEventSeq: payload.boardEventSeq, count: committed.cells.length, gameOver: player.gameOver, replyToCommandId: command.commandId });
    }
  } else if (command.type === "game_over") {
    if (payload.finalMoveSeq !== player.lastMoveSeq || payload.finalBoardEventSeq !== player.lastBoardEventSeq || payload.finalScore !== player.score || payload.finalBoardHash !== player.finalBoardHash) {
      reply = response("protocol_error", { code: "final_state_mismatch" });
    } else {
      freezePlayer(room, playerId, now);
      if (room.status === "playing" && now < room.endsAt) await finalizeRoom(room, now);
      mutated = true;
      reply = response("game_over_ack", { replyToCommandId: command.commandId });
    }
  } else if (command.type === "leave") {
    if (["lobby", "countdown"].includes(room.status)) {
      removeAfterReceipt = true;
      resetAfterLeave = room.status === "countdown";
      mutated = true;
      reply = response("leave_ack", { removed: true, forfeited: false, replyToCommandId: command.commandId });
    } else if (["playing", "settling"].includes(room.status)) {
      player.forfeited = true;
      freezePlayer(room, playerId, now);
      mutated = true;
      await finalizeRoom(room, now);
      reply = response("leave_ack", { removed: false, forfeited: true, replyToCommandId: command.commandId });
    } else {
      reply = response("leave_ack", { removed: false, forfeited: false, replyToCommandId: command.commandId });
    }
  } else if (command.type === "forfeit") {
    player.forfeited = true;
    freezePlayer(room, playerId, now);
    mutated = true;
    await finalizeRoom(room, now);
    reply = response("forfeit_ack", { replyToCommandId: command.commandId });
  } else if (command.type === "get_replay") {
    const participated = Object.hasOwn(room.result?.scores || {}, playerId);
    if (!participated) reply = response("replay_unavailable", { reason: "forbidden" });
    else if (!room.replay || now >= room.replayExpiresAt) reply = response("replay_unavailable", { reason: room.replayUnavailableReason || "expired" });
    else reply = response("replay_bundle", { bundle: room.replay, replayExpiresAt: room.replayExpiresAt });
  } else if (command.type === "rematch_ready") {
    if (room.status !== "finished") reply = response("protocol_error", { code: "match_not_finished" });
    else if (payload.rulesVersion !== RULES_VERSION) reply = response("protocol_error", { code: "rules_version_mismatch" });
    else {
      player.rematchReady = payload.ready === true;
      mutated = true;
      reply = response("rematch_ready_ack", { ready: player.rematchReady, replyToCommandId: command.commandId });
      if (Object.values(room.players).every((entry) => entry.rematchReady)) startMatch(room, now);
    }
  } else {
    reply = response("protocol_error", { code: "unknown_command" });
  }

  const result = finishReply(room, reply, mutated);
  if (command.type === "move_commit" && reply.type === "move_ack" && mutated) {
    player.moveAcks[reply.payload.moveSeq] = structuredClone(result.response);
  }
  let receiptStored = false;
  if (!reply.payload?.code || !["invalid_envelope", "unknown_command", "command_id_conflict"].includes(reply.payload.code)) {
    storeReceipt(room, playerId, command, fingerprint, result.response, now);
    receiptStored = true;
  }
  if (removeAfterReceipt) {
    delete room.players[playerId];
    if (resetAfterLeave) resetToLobby(room, now);
  }
  return { ...result, receiptStored };
}

function eventEnvelope(room, reply) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: reply.type,
    roomId: room.roomId,
    matchId: room.matchId,
    roomRevision: reply.roomRevision ?? room.roomRevision,
    sentAt: Date.now(),
    payload: reply.payload,
  });
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.tail = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room");
    });
  }

  serial(task) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }

  async persist() {
    await this.ctx.storage.put("room", this.room);
    const deadlines = [
      this.room.status === "countdown" ? this.room.startsAt : null,
      this.room.status === "playing" ? this.room.endsAt : null,
      this.room.status === "settling" ? this.room.settleDeadline : null,
      ...Object.values(this.room.players).map((player) => !player.connected && player.disconnectedAt ? player.disconnectedAt + DISCONNECT_GRACE_MS : null),
      this.room.replayExpiresAt,
      this.room.roomExpiresAt,
      ...this.ctx.getWebSockets().map((socket) => {
        const attachment = socket.deserializeAttachment();
        return !attachment?.playerId ? attachment?.joinDeadline : null;
      }),
    ].filter((deadline) => deadline && deadline > Date.now());
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  async scheduleAlarm(deadline) {
    const current = await this.ctx.storage.getAlarm();
    if (!current || deadline < current) await this.ctx.storage.setAlarm(deadline);
  }

  send(socket, reply) {
    try {
      if (this.room) socket.send(eventEnvelope(this.room, reply));
      else socket.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: reply.type,
        roomId: socket.deserializeAttachment()?.roomId || null,
        matchId: null,
        roomRevision: 0,
        sentAt: Date.now(),
        payload: reply.payload,
      }));
    } catch { /* disconnected */ }
  }

  authenticatedSockets() {
    if (!this.room) return [];
    return this.ctx.getWebSockets().filter((socket) => {
      const playerId = socket.deserializeAttachment()?.playerId;
      return playerId && this.room.players[playerId];
    });
  }

  broadcast(type = "room_state") {
    const reply = { type, payload: roomSnapshot(this.room), roomRevision: this.room.roomRevision };
    for (const socket of this.authenticatedSockets()) this.send(socket, reply);
  }

  sendToPlayer(playerId, reply) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.playerId === playerId) this.send(socket, reply);
    }
  }

  broadcastLifecycle(previousStatus, previousResult) {
    if (previousStatus !== "countdown" && this.room.status === "countdown") {
      const payload = {
        matchId: this.room.matchId,
        mode: this.room.mode,
        rulesVersion: this.room.rulesVersion,
        seed: this.room.seed,
        startsAt: this.room.startsAt,
        endsAt: this.room.endsAt,
        durationMs: this.room.durationMs,
      };
      for (const socket of this.authenticatedSockets()) this.send(socket, { type: "match_start", payload });
    }
    if (!previousResult && this.room.result) {
      for (const socket of this.authenticatedSockets()) {
        this.sendFinished(socket);
      }
    }
  }

  sendFinished(socket) {
    const playerId = socket.deserializeAttachment()?.playerId;
    if (!playerId || !this.room.players[playerId]) return;
    const participated = Object.hasOwn(this.room.result?.scores || {}, playerId);
    if (!participated) return;
    this.send(socket, { type: "match_result", payload: this.room.result });
    this.send(socket, this.room.replay
      ? { type: "replay_ready", payload: { available: true, bundle: this.room.replay, replayExpiresAt: this.room.replayExpiresAt } }
      : { type: "replay_ready", payload: { available: false, reason: this.room.replayUnavailableReason } });
  }

  joinedSnapshot(joined) {
    return {
      ...roomSnapshot(this.room),
      playerId: joined.player.playerId,
      playerToken: joined.playerToken,
      pendingAttacks: joined.player.pendingAttacks,
      committedAttacks: joined.player.committedAttack ? [joined.player.committedAttack] : [],
    };
  }

  fetch(request) {
    return this.serial(() => this.handleFetch(request));
  }

  async handleFetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const url = new URL(request.url);
    const anonymousCount = this.ctx.getWebSockets().filter((socket) => !socket.deserializeAttachment()?.playerId).length;
    if (anonymousCount >= MAX_ANONYMOUS_SOCKETS) return new Response("Too many pending joins", { status: 429 });
    const roomId = url.pathname.split("/").filter(Boolean).at(-1) || "room";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
    server.serializeAttachment({ playerId: null, roomId, joinDeadline });
    await this.scheduleAlarm(joinDeadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    return this.serial(() => this.handleWebSocketMessage(socket, message));
  }

  async handleWebSocketMessage(socket, message) {
    await this.ready;
    if (typeof message !== "string" || encoder.encode(message).byteLength > MAX_MESSAGE_BYTES) return this.send(socket, response("protocol_error", { code: "message_too_large" }));
    let command;
    try { command = JSON.parse(message); } catch { return this.send(socket, response("protocol_error", { code: "invalid_json" })); }
    const attachment = socket.deserializeAttachment() || {};
    let { playerId } = attachment;
    if (!playerId && command?.v === PROTOCOL_VERSION && command?.type === "join" && typeof command.commandId === "string") {
      if (!this.room && command.payload?.playerToken) {
        this.send(socket, response("protocol_error", { code: "invalid_player_token", replyToCommandId: command.commandId }));
        try { socket.close(1008, "invalid_player_token"); } catch { /* already closed */ }
        return;
      }
      this.room ||= createRoom(attachment.roomId || "room", Date.now(), command.payload?.mode);
    }
    if (!this.room) {
      this.send(socket, response("protocol_error", { code: "join_required" }));
      return;
    }
    const previousStatus = this.room.status;
    const previousResult = this.room.result;
    const timedChange = await advanceRoomTime(this.room);
    if (!playerId) {
      if (command?.v !== PROTOCOL_VERSION || command?.type !== "join" || typeof command.commandId !== "string") {
        return this.send(socket, response("protocol_error", { code: "join_required" }));
      }
      const joined = await joinPlayer(this.room, command.payload || {});
      if (joined.error) {
        await this.persist();
        this.send(socket, response("protocol_error", { code: joined.error, replyToCommandId: command.commandId }));
        this.broadcastLifecycle(previousStatus, previousResult);
        this.broadcast();
        return;
      }
      playerId = joined.player.playerId;
      socket.serializeAttachment({ playerId, roomId: this.room.roomId });
      await advanceRoomTime(this.room);
      await this.persist();
      this.send(socket, { type: "room_snapshot", payload: this.joinedSnapshot(joined) });
      if (this.room.result) this.sendFinished(socket);
      this.broadcast();
      return;
    }
    const result = await reduceRoomCommand(this.room, playerId, command);
    if (timedChange || result.mutated || result.receiptStored) await this.persist();
    this.broadcastLifecycle(previousStatus, previousResult);
    const attack = result.response.type === "move_ack" ? result.response.payload.attack : null;
    if (attack) {
      result.response.payload.attackCount = attack.count;
      const target = Object.values(this.room.players).find((player) => player.playerId !== playerId);
      if (target) this.sendToPlayer(target.playerId, { type: "attack_pending", payload: attack });
    }
    this.send(socket, result.response);
    if (timedChange || result.mutated) this.broadcast();
  }

  webSocketClose(socket) {
    return this.serial(() => this.handleWebSocketClose(socket));
  }

  async handleWebSocketClose(socket) {
    await this.ready;
    const { playerId } = socket.deserializeAttachment() || {};
    const player = this.room?.players[playerId];
    if (!player) return;
    if (this.ctx.getWebSockets().some((candidate) => candidate !== socket && candidate.deserializeAttachment()?.playerId === playerId)) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    this.room.roomRevision += 1;
    await this.persist();
    this.broadcast();
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }

  alarm() {
    return this.serial(() => this.handleAlarm());
  }

  async handleAlarm() {
    await this.ready;
    const now = Date.now();
    let nextJoinDeadline = null;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.playerId || !attachment?.joinDeadline) continue;
      if (attachment.joinDeadline <= now) {
        try { socket.close(1008, "join_timeout"); } catch { /* already closed */ }
      } else {
        nextJoinDeadline = Math.min(nextJoinDeadline || Infinity, attachment.joinDeadline);
      }
    }
    if (!this.room) {
      if (nextJoinDeadline) await this.ctx.storage.setAlarm(nextJoinDeadline);
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    const previousStatus = this.room.status;
    const previousResult = this.room.result;
    await advanceRoomTime(this.room, now);
    pruneReceipts(this.room, now);
    if (now >= this.room.roomExpiresAt && !["countdown", "playing"].includes(this.room.status) && !this.room.replay) {
      for (const socket of this.ctx.getWebSockets()) {
        this.send(socket, response("room_expired", { reason: "lobby_timeout" }));
        try { socket.close(1001, "room_expired"); } catch { /* already closed */ }
      }
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.persist();
    this.broadcastLifecycle(previousStatus, previousResult);
    this.broadcast();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,64})$/);
    if (!match) return new Response("Not found", { status: 404 });
    const id = env.GAME_ROOMS.idFromName(match[1]);
    return env.GAME_ROOMS.get(id).fetch(request);
  },
};
