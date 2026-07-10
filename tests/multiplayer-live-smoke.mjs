import assert from 'node:assert/strict';

const base = process.env.MP_WS_URL || 'ws://127.0.0.1:8787';
const roomId = `SMOKE${Date.now().toString(36).toUpperCase()}`;

function client(name, action) {
  const socket = new WebSocket(`${base}/room/${roomId}`);
  const messages = [];
  const waiters = [];
  let playerId = null;
  let matchId = null;

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    if (message.type === 'room_snapshot') {
      playerId = message.payload.playerId;
      matchId = message.payload.matchId;
    } else if (message.matchId) {
      matchId = message.matchId;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(message)) waiters.splice(i, 1)[0].resolve(message);
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      send('join', {
        action,
        mode: 'attack',
        name,
        playerToken: null,
        pageInstanceId: crypto.randomUUID()
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
      payload
    }));
  }

  function waitFor(predicate, label, timeout = 5000) {
    const seen = messages.find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve };
      waiters.push(entry);
      setTimeout(() => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${name} timed out waiting for ${label}; saw ${messages.map(m => m.type).join(', ')}`));
      }, timeout);
    });
  }

  return { socket, ready, send, waitFor, get playerId() { return playerId; }, get matchId() { return matchId; } };
}

const host = client('Host', 'create');
await host.ready;
await host.waitFor(message => message.type === 'room_snapshot', 'room_snapshot');

const anonymousMessages = [];
const anonymous = new WebSocket(`${base}/room/${roomId}`);
await new Promise((resolve, reject) => {
  anonymous.addEventListener('open', resolve, { once: true });
  anonymous.addEventListener('error', reject, { once: true });
});
anonymous.addEventListener('message', event => anonymousMessages.push(JSON.parse(event.data)));

const guest = client('Guest', 'join');
await guest.ready;
await guest.waitFor(message => message.type === 'room_snapshot', 'room_snapshot');
await host.waitFor(message => message.type === 'room_state' && Object.keys(message.payload.players || {}).length === 2, 'two-player room_state');

host.send('ready', { ready: true, rulesVersion: 'duel-v1' });
guest.send('ready', { ready: true, rulesVersion: 'duel-v1' });
const [hostStart, guestStart] = await Promise.all([
  host.waitFor(message => message.type === 'match_start', 'match_start'),
  guest.waitFor(message => message.type === 'match_start', 'match_start')
]);
assert.equal(hostStart.payload.matchId, guestStart.payload.matchId);
assert.equal(hostStart.payload.seed, guestStart.payload.seed);
assert.equal(hostStart.payload.mode, 'attack');

guest.send('forfeit');
const [hostResult, guestResult] = await Promise.all([
  host.waitFor(message => message.type === 'match_result', 'match_result'),
  guest.waitFor(message => message.type === 'match_result', 'match_result')
]);
assert.equal(hostResult.payload.winnerId, host.playerId);
assert.deepEqual(hostResult.payload, guestResult.payload);
await new Promise(resolve => setTimeout(resolve, 100));
assert.deepEqual(anonymousMessages, [], 'anonymous socket must not receive room state or replay');

host.send('rematch_ready', { ready: true, rulesVersion: 'duel-v1' });
guest.send('rematch_ready', { ready: true, rulesVersion: 'duel-v1' });
const previousMatchId = hostResult.payload.matchId;
const [hostRematch, guestRematch] = await Promise.all([
  host.waitFor(message => message.type === 'match_start' && message.payload.matchId !== previousMatchId, 'rematch match_start'),
  guest.waitFor(message => message.type === 'match_start' && message.payload.matchId !== previousMatchId, 'rematch match_start')
]);
assert.equal(hostRematch.payload.matchId, guestRematch.payload.matchId);

host.socket.close();
guest.socket.close();
anonymous.close();
console.log(`live multiplayer smoke passed: ${roomId}`);
