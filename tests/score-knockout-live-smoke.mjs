import assert from 'node:assert/strict';

const base = process.env.MP_WS_URL || 'ws://127.0.0.1:8787';
const mode = process.env.MP_MODE === 'attack' ? 'attack' : 'score';
const roomId = `${mode === 'attack' ? 'ATTACK' : 'SCORE'}${Date.now().toString(36).toUpperCase()}`;
const emptyBoardHash = 'eb7b0297e5b6b33f6680cf9c6b471903832a5caceda3debf8e52cda0a40ab9c3';

function createClient(name, action) {
  const socket = new WebSocket(`${base}/room/${roomId}`);
  const messages = [];
  const waiters = [];
  let playerId = null;
  let matchId = null;

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    if (message.type === 'room_snapshot') playerId = message.payload.playerId;
    if (message.matchId) matchId = message.matchId;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(message)) waiters.splice(index, 1)[0].resolve(message);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      send('join', {
        action,
        mode,
        name,
        playerToken: null,
        pageInstanceId: crypto.randomUUID(),
      });
      resolve();
    }, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  function send(type, payload = {}) {
    socket.send(JSON.stringify({
      v: 1,
      type,
      roomId,
      matchId,
      playerId,
      commandId: crypto.randomUUID(),
      sentAt: Date.now(),
      payload,
    }));
  }

  function waitFor(predicate, label, timeout = 8_000) {
    const seen = messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve };
      waiters.push(entry);
      setTimeout(() => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${name} timed out waiting for ${label}; saw ${messages.map(message => message.type).join(', ')}`));
      }, timeout);
    });
  }

  return { socket, ready, send, waitFor, get playerId() { return playerId; } };
}

const host = createClient('Host', 'create');
await host.ready;
await host.waitFor(message => message.type === 'room_snapshot', 'room_snapshot');
const guest = createClient('Guest', 'join');
await guest.ready;
await guest.waitFor(message => message.type === 'room_snapshot', 'room_snapshot');
await host.waitFor(message => message.type === 'room_state' && Object.keys(message.payload.players || {}).length === 2, 'two-player room_state');

host.send('ready', { ready: true, rulesVersion: 'duel-v1' });
guest.send('ready', { ready: true, rulesVersion: 'duel-v1' });
const [hostStart, guestStart] = await Promise.all([
  host.waitFor(message => message.type === 'match_start', 'match_start'),
  guest.waitFor(message => message.type === 'match_start', 'match_start'),
]);
assert.equal(hostStart.payload.mode, mode);
assert.equal(hostStart.payload.endsAt - hostStart.payload.startsAt, 180_000);
await new Promise(resolve => setTimeout(resolve, Math.max(0, hostStart.payload.startsAt - Date.now()) + 100));

guest.send('game_over', {
  finalMoveSeq: 0,
  finalBoardEventSeq: 0,
  finalScore: 0,
  finalBoardHash: emptyBoardHash,
});
const [hostResult, guestResult] = await Promise.all([
  host.waitFor(message => message.type === 'match_result', 'match_result'),
  guest.waitFor(message => message.type === 'match_result', 'match_result'),
]);
assert.deepEqual(hostResult.payload, guestResult.payload);
assert.equal(hostResult.payload.reason, 'no_moves');
assert.equal(hostResult.payload.winnerId, host.playerId);
assert.deepEqual(hostResult.payload.unableToMovePlayerIds, [guest.playerId]);
const [hostReplay, guestReplay] = await Promise.all([
  host.waitFor(message => message.type === 'replay_ready', 'replay_ready'),
  guest.waitFor(message => message.type === 'replay_ready', 'replay_ready'),
]);
assert.equal(hostReplay.payload.available, true);
assert.equal(guestReplay.payload.available, true);
assert.equal(hostReplay.payload.bundle.result.reason, 'no_moves');

host.socket.close();
guest.socket.close();
console.log(`live ${mode} knockout and replay smoke passed: ${roomId}`);
