import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceRoomTime,
  attackSeedMaterial,
  buildReplayBundle,
  createRoom,
  deriveAttackSeed,
  enqueueAttack,
  freezePlayer,
  joinPlayer,
  pruneReceipts,
  reduceRoomCommand,
  shuffleEmptyCells,
  startMatch,
  validateReplayBundle,
} from "../worker/index.mjs";

const HASH_A = "8f5031a8c0b5f7440aa8044c1250d8aac15f43e730c0a751215eca38483e1d90";
const HASH_B = "eb7b0297e5b6b33f6680cf9c6b471903832a5caceda3debf8e52cda0a40ab9c3";

async function playingRoom(mode = "attack", now = 1_000) {
  const room = createRoom("ROOM", now, mode);
  await joinPlayer(room, { pageInstanceId: "page-a", name: "A", mode }, now);
  await joinPlayer(room, { pageInstanceId: "page-b", name: "B", mode }, now);
  startMatch(room, now, 0x12345678);
  room.status = "playing";
  room.startsAt = now;
  room.endsAt = now + 180_000;
  return room;
}

function command(type, commandId, payload = {}, matchId = null) {
  return { v: 1, type, commandId, matchId, payload };
}

async function hashBoard(board) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(board));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("attack RNG matches the canonical golden vector", async () => {
  const material = attackSeedMaterial("match-1", "player-a", 7, 0x12345678);
  assert.equal(Buffer.from(material).toString("hex"), "61747461636b2d76310000076d617463682d310008706c617965722d610000000712345678");
  const seed = await deriveAttackSeed("match-1", "player-a", 7, 0x12345678);
  assert.equal(seed.digest, "1360035dc6967b0bddccc5c62199a5aa5217a6fd27b1572e2e8610d15d780ecd");
  assert.equal(seed.state, 325059421);
  assert.deepEqual(shuffleEmptyCells([0, 1, 2, 3, 4, 5, 6, 7, 8], seed.state), [8, 1, 3, 5, 7, 4, 0, 2, 6]);
});

test("command receipts replay exact response and reject payload conflicts", async () => {
  const room = await playingRoom();
  const first = await reduceRoomCommand(room, "player-1", command("move_intent", "same", { baseBoardEventSeq: 0 }, room.matchId), 2_000);
  const duplicate = await reduceRoomCommand(room, "player-1", command("move_intent", "same", { baseBoardEventSeq: 0 }, room.matchId), 2_001);
  const conflict = await reduceRoomCommand(room, "player-1", command("move_intent", "same", { baseBoardEventSeq: 1 }, room.matchId), 2_002);
  assert.equal(first.response.type, "move_permit");
  assert.deepEqual(duplicate.response, first.response);
  assert.equal(conflict.response.payload.code, "command_id_conflict");
  assert.equal(room.players["player-1"].lastMoveSeq, 0);
});

test("pending attacks stay FIFO and plans obey obstacle cap", async () => {
  const room = await playingRoom();
  const source = room.players["player-1"];
  const target = room.players["player-2"];
  source.lastMoveSeq = 1;
  const first = enqueueAttack(room, source.playerId, 2, 11);
  source.lastMoveSeq = 2;
  const second = enqueueAttack(room, source.playerId, 1, 22);
  assert.deepEqual(target.pendingAttacks.map((attack) => attack.attackId), [first.attackId, second.attackId]);
  target.obstacleCount = 9;
  target.initialGrid = "X".repeat(9) + ".".repeat(72);
  const expectedCell = shuffleEmptyCells(Array.from({ length: 72 }, (_, index) => index + 9), 11)[0];
  const tooMany = await reduceRoomCommand(room, target.playerId, command("attack_plan", "plan-bad", {
    attackId: first.attackId,
    baseBoardEventSeq: 0,
    cells: [3, 4],
    t: 10,
  }, room.matchId), 2_000);
  assert.equal(tooMany.response.payload.code, "invalid_attack_cells");
  const accepted = await reduceRoomCommand(room, target.playerId, command("attack_plan", "plan-ok", {
    attackId: first.attackId,
    baseBoardEventSeq: 0,
    cells: [expectedCell],
    t: 10,
  }, room.matchId), 2_001);
  assert.equal(accepted.response.type, "attack_commit");
  assert.equal(target.pendingAttacks[0].attackId, second.attackId);
});

test("endsAt enters one-second settling and creates only one result", async () => {
  const room = await playingRoom("score", 10_000);
  room.players["player-1"].score = 100;
  room.players["player-2"].score = 50;
  await advanceRoomTime(room, room.endsAt);
  assert.equal(room.status, "settling");
  assert.equal(room.result, null);
  await advanceRoomTime(room, room.endsAt + 999);
  assert.equal(room.result, null);
  await advanceRoomTime(room, room.endsAt + 1_000);
  const result = room.result;
  await advanceRoomTime(room, room.endsAt + 2_000);
  assert.equal(room.result, result);
  assert.equal(result.winnerId, "player-1");
  assert.equal(result.reason, "score");
});

test("score mode immediately defeats the first player with no legal moves", async () => {
  const room = await playingRoom("score");
  const loser = room.players["player-1"];
  Object.assign(loser, {
    score: 100,
    lastMoveSeq: 1,
    lastBoardEventSeq: 1,
    finalBoardHash: HASH_A,
    moves: [{ boardEventSeq: 1, moveSeq: 1, t: 1, d: 30, c: 0, r: 0, col: 0, obs: [], s: 100, boardHash: HASH_A }],
  });
  const finished = await reduceRoomCommand(room, loser.playerId, command("game_over", "no-moves", {
    finalMoveSeq: 1,
    finalBoardEventSeq: 1,
    finalScore: 100,
    finalBoardHash: HASH_A,
  }, room.matchId), 2_000);
  assert.equal(finished.response.type, "game_over_ack");
  assert.equal(room.status, "finished");
  assert.equal(room.result.reason, "no_moves");
  assert.equal(room.result.winnerId, "player-2");
  assert.deepEqual(room.result.unableToMovePlayerIds, ["player-1"]);
  assert.equal(room.result.scores["player-1"], 100);
  assert.ok(room.replay);
  assert.equal(await validateReplayBundle(room.replay), null);
  const ghostLoser = structuredClone(room.replay);
  ghostLoser.result.unableToMovePlayerIds = ["ghost"];
  ghostLoser.result.winnerId = "player-1";
  assert.equal(await validateReplayBundle(ghostLoser), "integrity_mismatch");
  const unknownReason = structuredClone(room.replay);
  unknownReason.result.reason = "mystery";
  assert.equal(await validateReplayBundle(unknownReason), "integrity_mismatch");
});

test("attack mode immediately defeats a player with no legal moves", async () => {
  const room = await playingRoom("attack");
  const player = room.players["player-1"];
  const frozen = await reduceRoomCommand(room, player.playerId, command("game_over", "attack-no-moves", {
    finalMoveSeq: 0,
    finalBoardEventSeq: 0,
    finalScore: 0,
    finalBoardHash: player.finalBoardHash,
  }, room.matchId), 2_000);
  assert.equal(frozen.response.type, "game_over_ack");
  assert.equal(player.frozen, true);
  assert.equal(room.status, "finished");
  assert.equal(room.result.reason, "no_moves");
  assert.equal(room.result.winnerId, "player-2");
  assert.ok(room.replay);
});

test("attack-applied game over freezes atomically and immediately finishes", async () => {
  const room = await playingRoom();
  const source = room.players["player-1"];
  const target = room.players["player-2"];
  source.lastMoveSeq = 1;
  const first = enqueueAttack(room, source.playerId, 1, 1);
  source.lastMoveSeq = 2;
  enqueueAttack(room, source.playerId, 1, 2);
  const attackCell = shuffleEmptyCells(Array.from({ length: 81 }, (_, index) => index), 1)[0];
  const plan = await reduceRoomCommand(room, target.playerId, command("attack_plan", "plan", {
    attackId: first.attackId,
    baseBoardEventSeq: 0,
    cells: [attackCell],
    t: 20,
  }, room.matchId), 2_000);
  const attackedBoard = Array.from({ length: 81 }, (_, index) => index === attackCell ? "X" : ".").join("");
  const applied = await reduceRoomCommand(room, target.playerId, command("attack_applied", "applied", {
    attackId: first.attackId,
    boardEventSeq: plan.response.payload.boardEventSeq,
    postBoardHash: await hashBoard(attackedBoard),
    postObstacleCount: 1,
    gameOver: true,
  }, room.matchId), 2_001);
  assert.equal(applied.response.type, "attack_applied_ack");
  assert.equal(target.frozen, true);
  assert.equal(target.pendingAttacks.length, 0);
  assert.equal(target.committedAttack, null);
  assert.equal(room.status, "finished");
  assert.equal(room.result.reason, "no_moves");
  assert.equal(room.result.winnerId, source.playerId);
  assert.ok(room.replay);
  const late = await reduceRoomCommand(room, target.playerId, command("attack_plan", "late", {
    attackId: "anything",
    baseBoardEventSeq: 1,
    cells: [],
  }, room.matchId), 2_002);
  assert.equal(late.response.type, "match_finished");
});

test("replay includes authoritative finalBoardEventSeq and fails closed on gaps", async () => {
  const room = await playingRoom("score");
  room.result = { matchId: room.matchId, winnerId: "player-1", reason: "score", scores: { "player-1": 10, "player-2": 0 }, finishedAt: 5_000 };
  Object.assign(room.players["player-1"], {
    score: 10,
    lastMoveSeq: 1,
    lastBoardEventSeq: 1,
    finalBoardHash: HASH_A,
    moves: [{ boardEventSeq: 1, moveSeq: 1, t: 1, d: 30, c: 0, r: 0, col: 0, obs: [], s: 10, boardHash: HASH_A }],
  });
  Object.assign(room.players["player-2"], { score: 0, lastBoardEventSeq: 0, finalBoardHash: HASH_B });
  const built = await buildReplayBundle(room);
  assert.equal(built.error, undefined);
  assert.equal(built.bundle.players[0].finalBoardEventSeq, 1);
  assert.equal(await validateReplayBundle(built.bundle), null);
  built.bundle.players[0].moves[0].boardEventSeq = 2;
  assert.equal(await validateReplayBundle(built.bundle), "integrity_mismatch");
});

test("freeze helper is idempotent", async () => {
  const room = await playingRoom();
  assert.equal(freezePlayer(room, "player-1"), true);
  assert.equal(freezePlayer(room, "player-1"), false);
});

test("finished matches reject late board mutations", async () => {
  const room = await playingRoom();
  const player = room.players["player-2"];
  player.committedAttack = { attackId: "late", boardEventSeq: 1, cells: [0] };
  room.status = "finished";
  room.result = { winnerId: null, reason: "draw", scores: { "player-1": 0, "player-2": 0 } };
  const before = player.finalBoardHash;
  const late = await reduceRoomCommand(room, player.playerId, command("attack_applied", "late-command", {
    attackId: "late", boardEventSeq: 1, postBoardHash: HASH_A, postObstacleCount: 1, gameOver: false,
  }, room.matchId), room.endsAt + 2_000);
  assert.equal(late.response.type, "match_finished");
  assert.equal(player.finalBoardHash, before);
});

test("replay fails closed on hashes and unacknowledged attacks", async () => {
  const room = await playingRoom("score");
  room.result = { matchId: room.matchId, winnerId: null, reason: "draw", scores: { "player-1": 0, "player-2": 0 }, finishedAt: 5_000 };
  const valid = await buildReplayBundle(room);
  assert.ok(valid.bundle);
  valid.bundle.players[0].finalBoardHash = "f".repeat(64);
  assert.equal(await validateReplayBundle(valid.bundle), "integrity_mismatch");
  room.players["player-1"].committedAttack = { attackId: "missing-post-state" };
  assert.equal((await buildReplayBundle(room)).error, "integrity_mismatch");
});

test("non-mutating accepted commands report durable receipts", async () => {
  const room = await playingRoom();
  room.status = "finished";
  room.result = { winnerId: null, reason: "draw", scores: { "player-1": 0, "player-2": 0 } };
  const reply = await reduceRoomCommand(room, "player-1", command("get_replay", "replay-receipt", {}, room.matchId), 2_000);
  assert.equal(reply.receiptStored, true);
  assert.ok(room.receipts["player-1:replay-receipt"]);
});

test("old moveSeq returns the complete original ACK without a reservation", async () => {
  const room = await playingRoom("attack");
  const player = room.players["player-1"];
  const permit = await reduceRoomCommand(room, player.playerId, command("move_intent", "intent", { baseBoardEventSeq: 0 }, room.matchId), 1_500);
  const first = await reduceRoomCommand(room, player.playerId, command("move_commit", "first-commit", {
    reservationId: permit.response.payload.reservationId,
    moveSeq: 1,
    move: { d: 30, c: 0, r: 0, col: 0 },
    clearedRows: [0], clearedCols: [], score: 10, lines: 1, obstacleCount: 0, boardHash: HASH_A, t: 1,
  }, room.matchId), 1_501);
  const retry = await reduceRoomCommand(room, player.playerId, command("move_commit", "new-command-id", { moveSeq: 1 }, room.matchId), 2_000);
  assert.deepEqual(retry.response, first.response);
  assert.equal(retry.response.payload.attack.count, 1);
});

test("replay expiry increments roomRevision for state reducers", async () => {
  const room = createRoom("ROOM", 1_000);
  room.status = "finished";
  room.replay = { formatVersion: 1 };
  room.replayExpiresAt = 2_000;
  room.roomRevision = 3;
  await advanceRoomTime(room, 2_000);
  assert.equal(room.replay, null);
  assert.equal(room.roomRevision, 4);
});

test("rulesVersion gates ready and both players can start a rematch", async () => {
  const room = createRoom("ROOM", 1_000, "score");
  await joinPlayer(room, { pageInstanceId: "page-a", name: "A" }, 1_000);
  await joinPlayer(room, { pageInstanceId: "page-b", name: "B" }, 1_000);
  const stale = await reduceRoomCommand(room, "player-1", command("ready", "stale", { ready: true, rulesVersion: "old" }), 1_100);
  assert.equal(stale.response.payload.code, "rules_version_mismatch");
  room.status = "finished";
  room.result = { winnerId: null, reason: "draw", scores: { "player-1": 0, "player-2": 0 } };
  await reduceRoomCommand(room, "player-1", command("rematch_ready", "r1", { ready: true, rulesVersion: "duel-v1" }), 2_000);
  await reduceRoomCommand(room, "player-2", command("rematch_ready", "r2", { ready: true, rulesVersion: "duel-v1" }), 2_001);
  assert.equal(room.status, "countdown");
  assert.notEqual(room.matchId, null);
});

test("lobby token can rebind to a new page instance after reload", async () => {
  const room = createRoom("ROOM", 1_000, "score");
  const first = await joinPlayer(room, { pageInstanceId: "page-before-reload", name: "A", mode: "score" }, 1_000);
  room.players[first.player.playerId].connected = false;
  const resumed = await joinPlayer(room, {
    playerToken: first.playerToken,
    pageInstanceId: "page-after-reload",
    name: "A",
    mode: "score",
  }, 1_100);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.reconnected, true);
  assert.equal(resumed.player.playerId, first.player.playerId);
  assert.equal(resumed.player.pageInstanceId, "page-after-reload");
  assert.equal(resumed.player.connected, true);
  assert.equal(Object.keys(room.players).length, 1);
});

test("active match still rejects a different page instance and forfeits", async () => {
  const room = createRoom("ROOM", 1_000, "score");
  const first = await joinPlayer(room, { pageInstanceId: "page-a", name: "A", mode: "score" }, 1_000);
  await joinPlayer(room, { pageInstanceId: "page-b", name: "B", mode: "score" }, 1_000);
  startMatch(room, 1_000, 123);
  room.status = "playing";
  const takeover = await joinPlayer(room, {
    playerToken: first.playerToken,
    pageInstanceId: "different-page",
    name: "A",
    mode: "score",
  }, 2_000);
  assert.equal(takeover.error, "page_instance_mismatch");
  assert.equal(room.status, "finished");
  assert.equal(room.result.reason, "forfeit");
  assert.equal(room.result.winnerId, "player-2");
});

test("expired lobby disconnect removes the slot so a new player can join and ready", async () => {
  const room = createRoom("ROOM", 1_000, "score");
  await joinPlayer(room, { pageInstanceId: "page-a", name: "A" }, 1_000);
  await joinPlayer(room, { pageInstanceId: "page-b", name: "B" }, 1_000);
  room.players["player-2"].connected = false;
  room.players["player-2"].disconnectedAt = 1_000;
  await advanceRoomTime(room, 16_000);
  assert.deepEqual(Object.keys(room.players), ["player-1"]);
  assert.equal(room.status, "lobby");
  const joined = await joinPlayer(room, { pageInstanceId: "page-c", name: "C" }, 16_001);
  assert.equal(joined.error, undefined);
  assert.equal(joined.player.playerId, "player-3");
  await reduceRoomCommand(room, "player-1", command("ready", "ready-a", { ready: true, rulesVersion: "duel-v1" }), 16_002);
  await reduceRoomCommand(room, "player-3", command("ready", "ready-c", { ready: true, rulesVersion: "duel-v1" }), 16_003);
  assert.equal(room.status, "countdown");
});

test("countdown stays paused for a disconnected player and returns to lobby after grace", async () => {
  const room = await playingRoom("score", 1_000);
  room.status = "countdown";
  room.startsAt = 6_000;
  room.endsAt = 186_000;
  room.players["player-2"].connected = false;
  room.players["player-2"].disconnectedAt = 2_000;
  await advanceRoomTime(room, 6_000);
  assert.equal(room.status, "countdown");
  await advanceRoomTime(room, 17_000);
  assert.equal(room.status, "lobby");
  assert.deepEqual(Object.keys(room.players), ["player-1"]);
  assert.equal(room.matchId, null);
});

test("leave in lobby removes the player and keeps an idempotent receipt", async () => {
  const room = createRoom("ROOM", 1_000);
  await joinPlayer(room, { pageInstanceId: "page-a", name: "A" }, 1_000);
  const leave = command("leave", "leave-once", {});
  const first = await reduceRoomCommand(room, "player-1", leave, 1_100);
  assert.equal(first.response.type, "leave_ack");
  assert.equal(first.response.payload.removed, true);
  assert.equal(room.players["player-1"], undefined);
  const duplicate = await reduceRoomCommand(room, "player-1", leave, 1_101);
  assert.deepEqual(duplicate.response, first.response);
});

test("leave during play is an immediate forfeit", async () => {
  const room = await playingRoom("score");
  const leave = command("leave", "leave-match", {}, room.matchId);
  const first = await reduceRoomCommand(room, "player-1", leave, 2_000);
  assert.equal(first.response.type, "leave_ack");
  assert.equal(first.response.payload.forfeited, true);
  assert.equal(room.status, "finished");
  assert.equal(room.result.reason, "forfeit");
  assert.equal(room.result.winnerId, "player-2");
  const duplicate = await reduceRoomCommand(room, "player-1", leave, 2_001);
  assert.deepEqual(duplicate.response, first.response);
});

test("receipt fingerprints are bounded hashes and expired entries are pruned", async () => {
  const room = await playingRoom("score");
  const replay = await reduceRoomCommand(room, "player-1", command("get_replay", "bounded", { padding: "x".repeat(20_000) }, room.matchId), 2_000);
  assert.equal(replay.receiptStored, true);
  assert.match(room.receipts["player-1:bounded"].fingerprint, /^[0-9a-f]{64}$/);
  room.receipts["expired"] = { fingerprint: "0".repeat(64), response: {}, expiresAt: 1_999 };
  assert.equal(pruneReceipts(room, 2_000), 1);
  assert.equal(room.receipts.expired, undefined);
});

test("receipt hard cap fails closed before processing a new command", async () => {
  const room = await playingRoom("score");
  room.receipts = Object.fromEntries(Array.from({ length: 8192 }, (_, index) => [`r${index}`, {
    fingerprint: "0".repeat(64), response: {}, expiresAt: 50_000,
  }]));
  const limited = await reduceRoomCommand(room, "player-1", command("get_replay", "over-cap", {}, room.matchId), 2_000);
  assert.equal(limited.response.payload.code, "receipt_limit");
  assert.equal(limited.mutated, false);
});

test("replacement players cannot read a replay they did not participate in", async () => {
  const room = await playingRoom("score");
  room.status = "finished";
  room.result = { matchId: room.matchId, winnerId: null, reason: "draw", scores: { "player-1": 0, "player-2": 0 }, finishedAt: 5_000 };
  room.replay = (await buildReplayBundle(room)).bundle;
  room.replayExpiresAt = 50_000;
  room.players["player-3"] = { ...room.players["player-2"], playerId: "player-3", tokenHash: "replacement" };
  const denied = await reduceRoomCommand(room, "player-3", command("get_replay", "replacement", {}, room.matchId), 6_000);
  assert.equal(denied.response.type, "replay_unavailable");
  assert.equal(denied.response.payload.reason, "forbidden");
});
