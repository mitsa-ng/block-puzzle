(function () {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const RECONNECT_MS = 15000;
  const SUPPORTED_RULES = new Set(['1', 'duel-v1', 'bpz-duel-v1']);
  const $ = id => document.getElementById(id);
  const uuid = () => crypto.randomUUID();
  let adapter = null;
  let socket = null;
  let reconnectTimer = null;
  let clockTimer = null;

  const state = {
    mode: 'solo', roomId: null, playerId: null, playerToken: null,
    pageInstanceId: uuid(), matchId: null, matchActive: false,
    connected: false, ready: false, inputLocked: false,
    lastRoomRevision: -1, lastMoveSeq: 0, lastBoardEventSeq: 0,
    lastAppliedBoardEventSeq: 0, startsAt: 0, endsAt: 0,
    seed: 0, randomState: 0, pieceSetIndex: 0, localGameOver: false,
    pendingMove: null, pendingAttack: null, pendingGameOver: null,
    attackQueue: [], appliedAttacks: new Map(), applyingAttackIds: new Set(),
    incoming: 0, sent: 0, reconnectDeadline: 0,
    players: [], replayBundle: null, replayError: '', result: null, tokenRetryUsed: false,
    historyReplayActive: false, replayLoadGeneration: 0
  };

  const PROGRESS_KEY = 'bpz_duel_progress_v1';
  const REPLAY_HISTORY_KEY = 'bpz_duel_replays_v1';
  const REPLAY_HISTORY_VERSION = 2;
  const REPLAY_HISTORY_MAX_RESULTS = 50;
  const REPLAY_HISTORY_MAX_BUNDLES = 8;
  const REPLAY_HISTORY_MAX_BYTES = 3 * 1024 * 1024;
  const REPLAY_RESULT_REASONS = new Set(['score', 'draw', 'forfeit', 'both_forfeit', 'no_moves']);
  const ACHIEVEMENTS = [
    { id: 'duel_debut', icon: '⚔️', name: '初次交鋒', description: '完成第一場多人對戰', check: ({ progress }) => progress.matches >= 1 },
    { id: 'first_win', icon: '🏆', name: '第一勝', description: '贏得第一場多人對戰', check: ({ progress }) => progress.wins >= 1 },
    { id: 'streak_3', icon: '🔥', name: '勢不可擋', description: '達成三連勝', check: ({ progress }) => progress.bestStreak >= 3 },
    { id: 'score_500', icon: '💎', name: '高分玩家', description: '比分快賽單局達到 500 分', check: ({ mode, score }) => mode === 'score' && score >= 500 },
    { id: 'attack_victor', icon: '🧱', name: '障礙霸主', description: '贏得一場障礙對戰', check: ({ mode, won }) => mode === 'attack' && won },
    { id: 'knockout', icon: '⚡', name: '封鎖終結', description: '讓對手先無法落子', check: ({ result, won }) => won && result.reason === 'no_moves' },
    { id: 'veteran_5', icon: '🎖️', name: '老練對手', description: '完成五場多人對戰', check: ({ progress }) => progress.matches >= 5 },
  ];

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value)).length;
  }

  function isReplayHistoryEntry(entry) {
    if (!entry || entry.version !== REPLAY_HISTORY_VERSION || typeof entry.matchId !== 'string' || !entry.matchId ||
        !Number.isFinite(entry.savedAt) || !['score', 'attack'].includes(entry.mode) || typeof entry.localPlayerId !== 'string' ||
        !Array.isArray(entry.players) || entry.players.length !== 2 || !REPLAY_RESULT_REASONS.has(entry.reason)) return false;
    const ids = new Set();
    for (const player of entry.players) {
      if (!player || typeof player.playerId !== 'string' || !player.playerId || ids.has(player.playerId) ||
          typeof player.name !== 'string' || !Number.isFinite(player.score)) return false;
      ids.add(player.playerId);
    }
    if (!ids.has(entry.localPlayerId) || (entry.winnerId !== null && !ids.has(entry.winnerId))) return false;
    if (['draw', 'both_forfeit'].includes(entry.reason) ? entry.winnerId !== null : entry.winnerId === null) return false;
    if (!entry.bundle) return true;
    const bundleIds = new Set(entry.bundle.players && entry.bundle.players.map(player => player.playerId));
    return entry.bundle.formatVersion === 1 && entry.bundle.matchId === entry.matchId && entry.bundle.result &&
      entry.bundle.result.matchId === entry.matchId && entry.bundle.result.reason === entry.reason &&
      entry.bundle.result.winnerId === entry.winnerId && bundleIds.size === 2 && [...ids].every(id => bundleIds.has(id));
  }

  function summaryFromBundle(bundle, savedAt, mode, localPlayerId) {
    const players = bundle.players.map(player => ({
      playerId: player.playerId,
      name: player.name,
      score: Number(bundle.result.scores[player.playerId]),
    }));
    const entry = {
      version: REPLAY_HISTORY_VERSION,
      matchId: bundle.matchId,
      savedAt: Number(savedAt),
      mode,
      localPlayerId,
      players,
      winnerId: bundle.result.winnerId,
      reason: bundle.result.reason,
      bundle,
    };
    return isReplayHistoryEntry(entry) ? entry : null;
  }

  function canonicalResultOnlyEntry(rawEntry) {
    const players = Array.isArray(rawEntry.players) ? rawEntry.players.map(player => ({
      playerId: typeof player?.playerId === 'string' ? player.playerId : '',
      name: typeof player?.name === 'string' ? player.name.slice(0, 24) : '',
      score: Number(player?.score),
    })) : [];
    const entry = {
      version: REPLAY_HISTORY_VERSION,
      matchId: typeof rawEntry.matchId === 'string' ? rawEntry.matchId : '',
      savedAt: Number(rawEntry.savedAt),
      mode: rawEntry.mode,
      localPlayerId: typeof rawEntry.localPlayerId === 'string' ? rawEntry.localPlayerId : '',
      players,
      winnerId: rawEntry.winnerId == null ? null : String(rawEntry.winnerId),
      reason: rawEntry.reason,
    };
    return isReplayHistoryEntry(entry) ? entry : null;
  }

  function canonicalHistoryEntry(rawEntry, sourceVersion) {
    if (!rawEntry || rawEntry.version !== sourceVersion || !Number.isFinite(rawEntry.savedAt) ||
        !['score', 'attack'].includes(rawEntry.mode) || typeof rawEntry.localPlayerId !== 'string') return null;
    if (rawEntry.bundle) {
      try {
        const bundle = canonicalReplayBundle(rawEntry.bundle);
        return summaryFromBundle(bundle, rawEntry.savedAt, rawEntry.mode, rawEntry.localPlayerId);
      } catch (_) { /* keep a valid v2 summary as result-only below */ }
    }
    return sourceVersion === REPLAY_HISTORY_VERSION ? canonicalResultOnlyEntry(rawEntry) : null;
  }

  function resultOnlyEntry(entry) {
    const { bundle: _bundle, ...summary } = entry;
    return summary;
  }

  function downgradeHistoryReplayEntries(entries, matchId) {
    let changed = false;
    const next = (entries || []).map(entry => {
      if (entry.matchId !== matchId || !entry.bundle) return entry;
      changed = true;
      return resultOnlyEntry(entry);
    });
    return { changed, entries: tierReplayHistory(next) };
  }

  function downgradeCorruptHistoryReplay(matchId) {
    const downgraded = downgradeHistoryReplayEntries(duelReplayHistory, matchId);
    if (!downgraded.changed) return false;
    persistReplayHistory(downgraded.entries);
    updateReplayHistoryUI();
    return true;
  }

  function historyWrapperBytes(entries) {
    return utf8Bytes(JSON.stringify({ version: REPLAY_HISTORY_VERSION, entries }));
  }

  function tierReplayHistory(entries, maxBytes = REPLAY_HISTORY_MAX_BYTES, maxBundles = REPLAY_HISTORY_MAX_BUNDLES, maxResults = REPLAY_HISTORY_MAX_RESULTS) {
    const sorted = (entries || []).filter(isReplayHistoryEntry).sort((a, b) => b.savedAt - a.savedAt);
    const unique = [];
    const positions = new Map();
    for (const entry of sorted) {
      const position = positions.get(entry.matchId);
      if (position === undefined) {
        positions.set(entry.matchId, unique.length);
        unique.push(entry);
      } else if (!unique[position].bundle && entry.bundle) {
        unique[position] = { ...entry, savedAt: unique[position].savedAt };
      }
    }
    let next = unique.slice(0, Math.max(0, maxResults));
    let fullCount = 0;
    next = next.map(entry => {
      if (!entry.bundle) return entry;
      fullCount += 1;
      return fullCount <= maxBundles ? entry : resultOnlyEntry(entry);
    });
    while (next.length && historyWrapperBytes(next) > maxBytes) {
      const fullIndex = next.findLastIndex(entry => entry.bundle);
      if (fullIndex >= 0) next[fullIndex] = resultOnlyEntry(next[fullIndex]);
      else next.pop();
    }
    return next;
  }

  function loadReplayHistory() {
    try {
      const wrapper = JSON.parse(localStorage.getItem(REPLAY_HISTORY_KEY) || 'null');
      if (!wrapper || ![1, REPLAY_HISTORY_VERSION].includes(wrapper.version) || !Array.isArray(wrapper.entries)) return [];
      const migrated = tierReplayHistory(wrapper.entries.map(entry => canonicalHistoryEntry(entry, wrapper.version)).filter(Boolean));
      if (wrapper.version === 1) return attemptWriteReplayHistory(migrated).entries;
      return migrated;
    } catch (_) {
      return [];
    }
  }

  let duelReplayHistory = loadReplayHistory();
  let achievementsFocusOrigin = null;
  let historyReplayReturnFocus = null;

  function isQuotaError(error) {
    return !!error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014);
  }

  function reduceReplayHistoryStorage(entries) {
    const fullIndex = entries.findLastIndex(entry => entry.bundle);
    if (fullIndex >= 0) {
      const next = entries.slice();
      next[fullIndex] = resultOnlyEntry(next[fullIndex]);
      return next;
    }
    return entries.length ? entries.slice(0, -1) : null;
  }

  function attemptWriteReplayHistory(entries) {
    let next = entries;
    while (true) {
      try {
        localStorage.setItem(REPLAY_HISTORY_KEY, JSON.stringify({ version: REPLAY_HISTORY_VERSION, entries: next }));
        return { entries: next, stored: true };
      } catch (error) {
        if (!isQuotaError(error)) return { entries, stored: false };
        const reduced = reduceReplayHistoryStorage(next);
        if (!reduced) return { entries: next, stored: false };
        next = reduced;
      }
    }
  }

  function persistReplayHistory(entries) {
    const next = tierReplayHistory(entries);
    const written = attemptWriteReplayHistory(next);
    duelReplayHistory = written.entries;
    return written.stored;
  }

  function sameMatchId(expected, ...values) {
    return typeof expected === 'string' && expected.length > 0 && values.every(value => typeof value === 'string' && value === expected);
  }

  function replayMatchesCurrentResult(bundle, envelopeMatchId) {
    const matchId = String(bundle && bundle.matchId || '');
    const resultMatchId = String(bundle && bundle.result && bundle.result.matchId || '');
    const currentMatchId = String(state.result && state.result.matchId || '');
    if (!sameMatchId(String(state.matchId || ''), envelopeMatchId, matchId, resultMatchId, currentMatchId) || !state.playerId) return false;
    return Array.isArray(bundle.players) && bundle.players.some(player => player && String(player.playerId) === state.playerId) &&
      Object.hasOwn(bundle.result.scores || {}, state.playerId);
  }

  function replayPayloadMatchesCurrent(payload, envelopeMatchId, capturedMatchId) {
    const resultMatchId = state.result && state.result.matchId;
    if (!sameMatchId(capturedMatchId, String(state.matchId || ''), envelopeMatchId, resultMatchId)) return false;
    const bundle = payload && payload.bundle;
    return !bundle || sameMatchId(capturedMatchId, bundle.matchId, bundle.result && bundle.result.matchId);
  }

  function replayLoadIsCurrent(generation, capturedMatchId, payload, envelopeMatchId) {
    return generation === state.replayLoadGeneration && replayPayloadMatchesCurrent(payload, envelopeMatchId, capturedMatchId);
  }

  function canonicalReplayBundle(bundle) {
    const playerIds = bundle.players.map(player => String(player.playerId));
    const scores = {};
    for (const playerId of playerIds) scores[playerId] = Number(bundle.result.scores[playerId]);
    const participantIds = new Set(playerIds);
    const canonicalIds = values => Array.isArray(values) ? values.filter(value => participantIds.has(String(value))).map(String) : [];
    return {
      formatVersion: 1,
      matchId: String(bundle.matchId),
      players: bundle.players.map(player => ({
        playerId: String(player.playerId),
        name: typeof player.name === 'string' ? player.name.slice(0, 24) : '',
        initialGrid: String(player.initialGrid),
        finalBoardEventSeq: Number(player.finalBoardEventSeq),
        finalBoardHash: String(player.finalBoardHash).toLowerCase(),
        finalScore: Number(player.finalScore),
        moves: (Array.isArray(player.moves) ? player.moves : []).map(move => ({
          boardEventSeq: Number(move.boardEventSeq),
          t: Number(move.t),
          d: Number(move.d),
          c: Number(move.c),
          r: Number(move.r),
          col: Number(move.col),
          obs: Array.isArray(move.obs) ? move.obs.map(cell => [Number(cell[0]), Number(cell[1])]) : [],
          s: Number(move.s),
        })),
        attacks: (Array.isArray(player.attacks) ? player.attacks : []).map(attack => ({
          boardEventSeq: Number(attack.boardEventSeq),
          t: Number(attack.t),
          cells: (Array.isArray(attack.cells) ? attack.cells : []).map(Number),
        })),
      })),
      result: {
        matchId: String(bundle.result.matchId),
        winnerId: bundle.result.winnerId == null ? null : String(bundle.result.winnerId),
        reason: String(bundle.result.reason),
        scores,
        forfeitedPlayerIds: canonicalIds(bundle.result.forfeitedPlayerIds),
        unableToMovePlayerIds: canonicalIds(bundle.result.unableToMovePlayerIds),
      },
    };
  }

  function updateReplayHistoryUI() {
    if ($('mp-history-count')) $('mp-history-count').textContent = duelReplayHistory.length;
    renderReplayHistory();
  }

  function storeValidatedReplay(bundle, envelopeMatchId) {
    if (!replayMatchesCurrentResult(bundle, envelopeMatchId)) return false;
    const canonicalBundle = canonicalReplayBundle(bundle);
    const entry = summaryFromBundle(canonicalBundle, Date.now(), state.mode === 'attack' ? 'attack' : 'score', state.playerId);
    if (!entry) return false;
    const existing = duelReplayHistory.find(saved => saved.matchId === entry.matchId);
    if (existing) entry.savedAt = existing.savedAt;
    persistReplayHistory([entry, ...duelReplayHistory.filter(saved => saved.matchId !== entry.matchId)]);
    updateReplayHistoryUI();
    return true;
  }

  function emptyProgress() {
    return { version: 1, matches: 0, wins: 0, currentStreak: 0, bestStreak: 0, unlocked: {}, seenMatchIds: [] };
  }

  function loadProgress() {
    const base = emptyProgress();
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return base;
      for (const key of ['matches', 'wins', 'currentStreak', 'bestStreak']) {
        base[key] = Number.isInteger(saved[key]) && saved[key] >= 0 ? saved[key] : 0;
      }
      base.unlocked = saved.unlocked && typeof saved.unlocked === 'object' ? saved.unlocked : {};
      base.seenMatchIds = Array.isArray(saved.seenMatchIds) ? saved.seenMatchIds.filter(id => typeof id === 'string').slice(-30) : [];
      return base;
    } catch (_) {
      return base;
    }
  }

  let duelProgress = loadProgress();
  let achievementToastTimer = null;
  let scoreGapTimer = null;

  function saveProgress() {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(duelProgress)); } catch (_) {}
  }

  function unlockedAchievements() {
    return ACHIEVEMENTS.filter(achievement => duelProgress.unlocked[achievement.id]);
  }

  function renderAchievementUI() {
    const unlocked = unlockedAchievements();
    if ($('mp-achievement-summary')) $('mp-achievement-summary').textContent = `${duelProgress.matches} 場 · ${duelProgress.wins} 勝 · 連勝 ${duelProgress.currentStreak}`;
    if ($('mp-achievement-count')) $('mp-achievement-count').textContent = `${unlocked.length}/${ACHIEVEMENTS.length}`;
    if ($('mp-history-count')) $('mp-history-count').textContent = duelReplayHistory.length;
    if ($('mp-career-matches')) $('mp-career-matches').textContent = duelProgress.matches;
    if ($('mp-career-wins')) $('mp-career-wins').textContent = duelProgress.wins;
    if ($('mp-career-streak')) $('mp-career-streak').textContent = duelProgress.bestStreak;
    const list = $('mp-achievement-list');
    if (!list) return;
    list.textContent = '';
    for (const achievement of ACHIEVEMENTS) {
      const unlockedAt = duelProgress.unlocked[achievement.id];
      const card = document.createElement('article');
      card.className = `mp-achievement-card ${unlockedAt ? 'unlocked' : 'locked'}`;
      const icon = document.createElement('span');
      icon.className = 'mp-achievement-icon';
      icon.textContent = unlockedAt ? achievement.icon : '🔒';
      const copy = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'mp-achievement-name';
      title.textContent = achievement.name;
      const description = document.createElement('span');
      description.className = 'mp-achievement-desc';
      description.textContent = achievement.description;
      copy.append(title, description);
      card.append(icon, copy);
      list.appendChild(card);
    }
  }

  function showAchievementToast(unlocked) {
    if (!unlocked.length || !$('mp-achievement-toast')) return;
    clearTimeout(achievementToastTimer);
    const first = unlocked[0];
    $('mp-achievement-toast-text').textContent = `解鎖「${first.name}」${unlocked.length > 1 ? ` ＋${unlocked.length - 1}` : ''}`;
    $('mp-achievement-toast').setAttribute('aria-hidden', 'false');
    $('mp-achievement-toast').classList.add('show');
    achievementToastTimer = setTimeout(() => {
      $('mp-achievement-toast').classList.remove('show');
      $('mp-achievement-toast').setAttribute('aria-hidden', 'true');
    }, 3200);
  }

  function recordResultProgress(result) {
    const matchId = String(result && result.matchId || '');
    const scores = result && result.scores;
    if (!matchId || !scores || !Object.hasOwn(scores, state.playerId) || duelProgress.seenMatchIds.includes(matchId)) return [];
    const score = Number(scores[state.playerId]) || 0;
    const won = String(result.winnerId || '') === state.playerId;
    duelProgress.matches += 1;
    if (won) {
      duelProgress.wins += 1;
      duelProgress.currentStreak += 1;
      duelProgress.bestStreak = Math.max(duelProgress.bestStreak, duelProgress.currentStreak);
    } else {
      duelProgress.currentStreak = 0;
    }
    duelProgress.seenMatchIds.push(matchId);
    duelProgress.seenMatchIds = duelProgress.seenMatchIds.slice(-30);
    const context = { progress: duelProgress, result, won, score, mode: state.mode };
    const newlyUnlocked = [];
    for (const achievement of ACHIEVEMENTS) {
      if (!duelProgress.unlocked[achievement.id] && achievement.check(context)) {
        duelProgress.unlocked[achievement.id] = Date.now();
        newlyUnlocked.push(achievement);
      }
    }
    saveProgress();
    renderAchievementUI();
    showAchievementToast(newlyUnlocked);
    return newlyUnlocked;
  }

  function renderRoster(me, opponent) {
    if (!$('mp-roster')) return;
    $('mp-roster').hidden = !state.roomId;
    const selfReady = !!(me && me.ready);
    const opponentReady = !!(opponent && opponent.ready);
    $('mp-player-self').classList.toggle('is-ready', selfReady);
    $('mp-player-opponent').classList.toggle('is-ready', opponentReady);
    $('mp-player-self-name').textContent = me?.name || $('mp-name').value.trim() || '你';
    $('mp-player-self-state').textContent = me ? (selfReady ? '已 Ready' : '尚未 Ready') : '連線中';
    $('mp-player-opponent-name').textContent = opponent?.name || '等待對手';
    $('mp-player-opponent-state').textContent = opponent ? (opponentReady ? '已 Ready' : '尚未 Ready') : '尚未加入';
    $('mp-copy-room-btn').disabled = !state.roomId;
  }

  function renderScoreGap(me, opponent) {
    const gap = $('mp-score-gap');
    if (!gap) return;
    const mine = Number(me?.score) || 0;
    const theirs = Number(opponent?.score) || 0;
    const difference = mine - theirs;
    const next = !opponent ? '等待對手' : difference === 0 ? '目前平手' : difference > 0 ? `領先 ${difference}` : `落後 ${Math.abs(difference)}`;
    gap.classList.toggle('ahead', difference > 0);
    gap.classList.toggle('behind', difference < 0);
    if (gap.textContent !== next) {
      gap.textContent = next;
      gap.classList.remove('pulse');
      void gap.offsetWidth;
      gap.classList.add('pulse');
      clearTimeout(scoreGapTimer);
      scoreGapTimer = setTimeout(() => gap.classList.remove('pulse'), 420);
    }
  }

  function historyOutcome(entry) {
    const winnerId = entry.winnerId;
    if (winnerId == null) return { label: '平', tone: 'draw' };
    return String(winnerId) === entry.localPlayerId ? { label: '勝', tone: 'win' } : { label: '負', tone: 'loss' };
  }

  function historyReason(reason) {
    return reason === 'no_moves' ? '無法落子淘汰'
      : reason === 'score' ? '180 秒比分結算'
      : reason === 'draw' ? '雙方平手'
      : reason === 'forfeit' ? '一方棄權'
      : reason === 'both_forfeit' ? '雙方棄權'
      : '對戰結束';
  }

  function historyDate(timestamp) {
    try {
      return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
    } catch (_) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function makeHistoryText(className, text) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
  }

  function renderReplayHistory() {
    const list = $('mp-history-list');
    if (!list) return;
    list.textContent = '';
    if ($('mp-history-clear')) $('mp-history-clear').disabled = duelReplayHistory.length === 0;
    if (!duelReplayHistory.length) {
      const empty = document.createElement('div');
      empty.className = 'mp-history-empty';
      empty.textContent = '尚無多人對戰紀錄。完成對戰後會保留結果，最近的紀錄也可播放回放。';
      list.appendChild(empty);
      return;
    }
    for (const entry of duelReplayHistory) {
      const players = entry.players;
      const outcome = historyOutcome(entry);
      const card = document.createElement('article');
      card.className = 'mp-history-card';

      const summary = document.createElement('div');
      summary.className = 'mp-history-summary';
      const heading = document.createElement('div');
      heading.className = 'mp-history-heading';
      heading.append(
        makeHistoryText(`mp-history-outcome ${outcome.tone}`, outcome.label),
        makeHistoryText('mp-history-mode', entry.mode === 'attack' ? '障礙對戰' : '比分快賽'),
        makeHistoryText('mp-history-date', historyDate(entry.savedAt)),
      );
      const scoreline = document.createElement('div');
      scoreline.className = 'mp-history-scoreline';
      scoreline.textContent = players.map(player => {
        const name = typeof player.name === 'string' && player.name ? player.name : '玩家';
        return `${name} ${Number(player.score) || 0}`;
      }).join('　vs　');
      const reason = document.createElement('div');
      reason.className = 'mp-history-reason';
      reason.textContent = historyReason(entry.reason);
      summary.append(heading, scoreline, reason);

      const actions = document.createElement('div');
      actions.className = 'mp-history-actions';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'btn primary mp-history-action';
      play.textContent = entry.bundle ? '播放' : '僅保留結果';
      play.disabled = !entry.bundle;
      if (entry.bundle) play.addEventListener('click', () => openHistoryReplay(entry, play));
      else play.setAttribute('aria-label', '此紀錄僅保留結果，無法播放回放');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn mp-history-action';
      remove.textContent = '刪除';
      remove.setAttribute('aria-label', `刪除 ${historyDate(entry.savedAt)} 的多人對戰紀錄`);
      remove.addEventListener('click', () => {
        duelReplayHistory = duelReplayHistory.filter(saved => saved.matchId !== entry.matchId);
        persistReplayHistory(duelReplayHistory);
        updateReplayHistoryUI();
        const next = $('mp-history-list').querySelector('button') || $('mp-history-tab');
        if (next) next.focus();
      });
      actions.append(play, remove);
      card.append(summary, actions);
      list.appendChild(card);
    }
  }

  function selectAchievementsTab(name, focusTab = true) {
    const selected = name === 'history' ? 'history' : 'achievements';
    for (const tab of $('mp-achievements-tabs').querySelectorAll('[role="tab"]')) {
      const active = tab.dataset.mpTab === selected;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    }
    $('mp-achievements-panel').hidden = selected !== 'achievements';
    $('mp-history-panel').hidden = selected !== 'history';
    if (selected === 'history') renderReplayHistory();
    if (focusTab) $(selected === 'history' ? 'mp-history-tab' : 'mp-achievements-tab').focus();
  }

  function openAchievements(tabName = 'achievements') {
    achievementsFocusOrigin = document.activeElement;
    renderAchievementUI();
    renderReplayHistory();
    $('mp-achievements-overlay').hidden = false;
    selectAchievementsTab(tabName);
  }

  function closeAchievements(restoreFocus = true) {
    $('mp-achievements-overlay').hidden = true;
    if (restoreFocus) {
      const target = achievementsFocusOrigin && document.contains(achievementsFocusOrigin) ? achievementsFocusOrigin : $('mp-achievement-open');
      if (target) target.focus();
    }
  }

  function focusableInAchievements() {
    return [...$('mp-achievements-overlay').querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]'));
  }

  function handleAchievementsKeydown(event) {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...$('mp-achievements-tabs').querySelectorAll('[role="tab"]')];
      let index = tabs.indexOf(tab);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectAchievementsTab(tabs[index].dataset.mpTab);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableInAchievements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function setHistoricalResultMode(active) {
    $('mp-rematch-btn').hidden = active;
    $('mp-replay-open').hidden = active;
    $('mp-result-close').textContent = active ? '返回歷史' : '關閉';
  }

  async function openHistoryReplay(entry, trigger) {
    if (state.matchActive) {
      $('mp-history-status').textContent = '對戰進行中，結束後才能播放歷史回放。';
      return;
    }
    if (!entry.bundle) {
      $('mp-history-status').textContent = '此紀錄僅保留結果，無法播放回放。';
      return;
    }
    $('mp-history-status').textContent = '正在驗證回放…';
    const capturedGeneration = ++state.replayLoadGeneration;
    const capturedMatchId = state.matchId;
    try {
      await adapter.prepareReplay(entry.bundle);
    } catch (_) {
      if (capturedGeneration !== state.replayLoadGeneration || capturedMatchId !== state.matchId || state.matchActive) return;
      downgradeCorruptHistoryReplay(entry.matchId);
      $('mp-history-status').textContent = '回放損壞，已僅保留結果';
      return;
    }
    if (capturedGeneration !== state.replayLoadGeneration || capturedMatchId !== state.matchId || state.matchActive) return;
    try {
      if (!entry.bundle || !isReplayHistoryEntry(entry)) throw new Error('歷史索引資料不一致');
      const outcome = historyOutcome(entry);
      historyReplayReturnFocus = trigger;
      state.historyReplayActive = true;
      $('mp-achievements-overlay').hidden = true;
      setHistoricalResultMode(true);
      $('mp-result-title').textContent = `歷史回放 · ${outcome.label}`;
      $('mp-result-scores').textContent = entry.players.map(player => {
        const name = typeof player.name === 'string' && player.name ? player.name : '玩家';
        return `${name} ${Number(player.score) || 0}`;
      }).join('　');
      $('mp-result-meta').textContent = `${entry.mode === 'attack' ? '障礙對戰' : '比分快賽'} · ${historyReason(entry.reason)} · ${historyDate(entry.savedAt)}`;
      $('mp-new-achievements').hidden = true;
      $('mp-result-overlay').classList.add('show');
      adapter.openReplay();
      $('mp-history-status').textContent = '';
      $('mp-result-close').focus();
    } catch (error) {
      if (state.historyReplayActive) {
        if (adapter && adapter.closeReplay) adapter.closeReplay();
        $('mp-result-overlay').classList.remove('show');
        state.historyReplayActive = false;
        setHistoricalResultMode(false);
        $('mp-achievements-overlay').hidden = false;
      }
      $('mp-history-status').textContent = `回放無法播放：${error && error.message ? error.message : '紀錄損壞'}`;
    }
  }

  function closeHistoryReplay() {
    if (!state.historyReplayActive) return;
    if (adapter && adapter.closeReplay) adapter.closeReplay();
    $('mp-result-overlay').classList.remove('show');
    state.historyReplayActive = false;
    setHistoricalResultMode(false);
    $('mp-achievements-overlay').hidden = false;
    selectAchievementsTab('history', false);
    const target = historyReplayReturnFocus && document.contains(historyReplayReturnFocus) ? historyReplayReturnFocus : $('mp-history-tab');
    historyReplayReturnFocus = null;
    if (target) target.focus();
  }

  function copyTextFallback(text) {
    const active = document.activeElement;
    const field = $('mp-room-code');
    const selectionStart = field.selectionStart;
    const selectionEnd = field.selectionEnd;
    let eventHandled = false;
    const handleCopy = event => {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      eventHandled = true;
    };
    document.addEventListener('copy', handleCopy, { once: true });
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    document.removeEventListener('copy', handleCopy);
    if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) field.setSelectionRange(selectionStart, selectionEnd);
    if (active && typeof active.focus === 'function') {
      try { active.focus({ preventScroll: true }); } catch (_) { active.focus(); }
    }
    return copied || eventHandled;
  }

  function booleanWithin(promise, timeoutMs) {
    return Promise.race([
      Promise.resolve(promise).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  async function clipboardMatches(text) {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.readText !== 'function') return null;
      return await Promise.race([
        clipboard.readText().then(value => value === text, () => null),
        new Promise(resolve => setTimeout(() => resolve(null), 240)),
      ]);
    } catch (_) {
      return null;
    }
  }

  async function copyRoomCode() {
    const code = roomCode(state.roomId || $('mp-room-code').value);
    if (!code) { setStatus('尚未建立或加入房間', 'error'); return; }
    const button = $('mp-copy-room-btn');
    button.disabled = true;
    let modernCopy = Promise.resolve(false);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        modernCopy = booleanWithin(navigator.clipboard.writeText(code), 320);
      }
    } catch (_) {}
    const fallbackCopy = copyTextFallback(code);
    const copied = fallbackCopy || await modernCopy;
    const verified = copied ? await clipboardMatches(code) : false;
    button.disabled = !state.roomId;
    if (copied && verified !== false) {
      $('mp-copy-room-btn').textContent = '已複製';
      $('mp-copy-room-btn').classList.add('copied');
      setStatus(`房碼 ${code} 已複製`, 'ok');
      setTimeout(() => { $('mp-copy-room-btn').textContent = '複製'; $('mp-copy-room-btn').classList.remove('copied'); }, 1600);
    } else {
      $('mp-room-code').focus();
      $('mp-room-code').select();
      setStatus(`複製失敗，請手動使用房碼 ${code}`, 'error');
    }
  }

  function resetMatchState() {
    state.replayLoadGeneration += 1;
    clearInterval(clockTimer);
    state.matchId = null;
    state.matchActive = false;
    state.result = null;
    state.replayBundle = null;
    state.replayError = '';
    state.lastMoveSeq = 0;
    state.lastBoardEventSeq = 0;
    state.lastAppliedBoardEventSeq = 0;
    state.startsAt = 0;
    state.endsAt = 0;
    state.seed = 0;
    state.randomState = 0;
    state.pieceSetIndex = 0;
    state.localGameOver = false;
    state.pendingMove = null;
    state.pendingAttack = null;
    state.pendingGameOver = null;
    state.attackQueue.length = 0;
    state.appliedAttacks.clear();
    state.applyingAttackIds.clear();
    state.incoming = 0;
    state.sent = 0;
  }

  function resetRoomState(mode) {
    clearTimeout(reconnectTimer);
    resetMatchState();
    state.mode = mode || 'solo';
    state.roomId = null;
    state.playerId = null;
    state.playerToken = null;
    state.connected = false;
    state.ready = false;
    state.inputLocked = false;
    state.lastRoomRevision = -1;
    state.reconnectDeadline = 0;
    state.players = [];
    state.tokenRetryUsed = false;
  }

  function canMutateBoard(message) {
    return !!(state.matchActive && !state.result && state.matchId && message && message.matchId === state.matchId);
  }

  function isLobbyRollback(payload) {
    return !!(payload && payload.status === 'lobby' && payload.matchId == null);
  }

  function rollbackMatchToLobby() {
    resetMatchState();
    document.body.classList.remove('mp-active');
    $('mp-result-overlay').classList.remove('show');
    $('mp-replay-boards').hidden = true;
    $('mp-replay-controls').hidden = true;
    $('mp-hud').hidden = true;
  }

  function setStatus(message, tone) {
    const el = $('mp-status');
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone || '';
  }

  function setLocked(locked, reason) {
    state.inputLocked = !!locked;
    document.body.classList.toggle('mp-input-locked', state.inputLocked);
    if (adapter && adapter.setInputLocked) adapter.setInputLocked(state.inputLocked);
    if (reason) setStatus(reason, locked ? 'error' : 'ok');
  }

  function failClosed(message) {
    setLocked(true);
    setStatus(message || '對戰資料無法驗證，已停止操作', 'error');
  }

  function roomCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  function randomRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  }

  function playerTokenKey(code) { return 'bpz_duel_token_' + code; }
  function sessionGet(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } }
  function sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch (_) {} }
  function sessionRemove(key) { try { sessionStorage.removeItem(key); } catch (_) {} }

  function buildSocketUrl(base, code) {
    const url = new URL(base);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('mpServer 必須是 http(s) 或 ws(s) URL');
    url.pathname = url.pathname.replace(/\/+$/, '') + '/room/' + encodeURIComponent(code);
    url.hash = '';
    return url.toString();
  }

  function defaultServerBase(currentHref) {
    const url = new URL(currentHref);
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (isLoopback) url.port = '8787';
    if (url.hostname === 'mitsabkpuz.vercel.app') return 'https://block-puzzle-multiplayer.xingencai060.workers.dev';
    return url.origin;
  }

  function resolveServerBase(currentHref, search) {
    const configured = new URLSearchParams(search).get('mpServer');
    return configured ? new URL(configured, currentHref).toString() : defaultServerBase(currentHref);
  }

  function socketUrl(code) {
    return buildSocketUrl(resolveServerBase(location.href, location.search), code);
  }

  function envelope(type, payload, commandId) {
    return {
      v: PROTOCOL_VERSION,
      type,
      roomId: state.roomId,
      matchId: state.matchId,
      playerId: state.playerId,
      commandId: commandId || uuid(),
      sentAt: Date.now(),
      payload: payload || {}
    };
  }

  function sendEnvelope(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendCommand(type, payload, commandId) {
    const message = envelope(type, payload, commandId);
    if (!sendEnvelope(message)) throw new Error('WebSocket 尚未連線');
    return message;
  }

  function connect(action, reconnecting) {
    if (!state.roomId) return;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    setLocked(true, reconnecting ? '連線中斷，正在重連…' : '正在連線…');
    let ws;
    try { ws = new WebSocket(socketUrl(state.roomId)); }
    catch (error) { failClosed(error.message || '無法建立 WebSocket'); return; }
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws !== socket) return;
      state.connected = true;
      const savedToken = sessionGet(playerTokenKey(state.roomId));
      sendCommand('join', {
        action: reconnecting ? 'resume' : action,
        mode: state.mode,
        name: ($('mp-name').value || '玩家').trim().slice(0, 16),
        playerToken: savedToken || null,
        pageInstanceId: state.pageInstanceId
      });
      if (state.reconnectDeadline) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (state.reconnectDeadline && ws === socket) ws.close();
        }, Math.max(0, state.reconnectDeadline - Date.now()));
      }
      setStatus(reconnecting ? '已連線，正在同步房間…' : '已連線，正在加入房間…');
    });
    ws.addEventListener('message', event => {
      if (ws !== socket) return;
      handleMessage(event.data).catch(() => failClosed('對戰事件處理失敗，請重新加入'));
    });
    ws.addEventListener('error', () => {
      if (ws === socket) setStatus('WebSocket 連線失敗', 'error');
    });
    ws.addEventListener('close', () => {
      if (ws !== socket) return;
      state.connected = false;
      if (!state.roomId || state.result) return;
      setLocked(true, '連線中斷，15 秒內同頁重連');
      if (!state.reconnectDeadline) state.reconnectDeadline = Date.now() + RECONNECT_MS;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (!state.roomId || state.result) return;
    if (Date.now() >= state.reconnectDeadline) {
      failClosed('重連逾時，本局已判定棄權');
      return;
    }
    reconnectTimer = setTimeout(() => connect('resume', true), 1000);
  }

  function startConnection(action) {
    const code = action === 'create' ? randomRoomCode() : roomCode($('mp-room-code').value);
    if (!code) { setStatus('請輸入房間代碼', 'error'); return; }
    const mode = $('mp-mode').value;
    if (socket) { const old = socket; socket = null; old.close(); }
    resetRoomState(mode);
    state.roomId = code;
    $('mp-room-code').value = code;
    state.playerToken = sessionGet(playerTokenKey(code));
    state.result = null;
    renderRoster(null, null);
    connect(action, false);
  }

  function normalizePlayers(players) {
    if (Array.isArray(players)) return players;
    if (players && typeof players === 'object') {
      return Object.keys(players).map(id => Object.assign({ playerId: id }, players[id]));
    }
    return [];
  }

  function updateRoom(payload) {
    clearTimeout(reconnectTimer);
    state.reconnectDeadline = 0;
    if (isLobbyRollback(payload)) rollbackMatchToLobby();
    if (payload.playerId) state.playerId = String(payload.playerId);
    if (payload.playerToken) {
      state.playerToken = String(payload.playerToken);
      sessionSet(playerTokenKey(state.roomId), state.playerToken);
      state.tokenRetryUsed = false;
    }
    if (payload.mode === 'score' || payload.mode === 'attack') state.mode = payload.mode;
    state.players = normalizePlayers(payload.players);
    const me = state.players.find(p => String(p.playerId || p.id) === state.playerId);
    const opponent = state.players.find(p => String(p.playerId || p.id) !== state.playerId);
    state.ready = !!(me && me.ready);
    if (me) {
      if (Number.isInteger(me.lastMoveSeq)) state.lastMoveSeq = Math.max(state.lastMoveSeq, me.lastMoveSeq);
      if (Number.isInteger(me.lastAppliedBoardEventSeq)) {
        state.lastAppliedBoardEventSeq = Math.max(state.lastAppliedBoardEventSeq, me.lastAppliedBoardEventSeq);
        state.lastBoardEventSeq = Math.max(state.lastBoardEventSeq, me.lastAppliedBoardEventSeq);
      }
    }
    $('mp-ready-btn').disabled = state.players.length < 2 || state.matchActive;
    $('mp-ready-btn').textContent = state.ready ? '取消 Ready' : 'Ready';
    $('mp-opponent-score').textContent = opponent && Number.isFinite(opponent.score) ? opponent.score : 0;
    renderRoster(me, opponent);
    renderScoreGap(me, opponent);
    if (payload.status === 'lobby') {
      setLocked(true);
      setStatus(opponent
        ? `${opponent.name || '對手'} 已加入${opponent.ready ? '並 Ready' : ''}，房碼 ${state.roomId}`
        : `等待對手加入，房碼 ${state.roomId}`,
      opponent ? 'ok' : '');
    } else if (payload.status === 'playing' && state.matchActive && state.connected) {
      setLocked(Date.now() < state.startsAt);
    }
    $('mp-hud').hidden = !state.matchActive;
    return { me, opponent };
  }

  function isValidEvent(message) {
    return message && typeof message === 'object' && message.v === PROTOCOL_VERSION &&
      typeof message.type === 'string' && message.payload && typeof message.payload === 'object' &&
      (!message.roomId || message.roomId === state.roomId);
  }

  function isFreshStateEvent(message) {
    if (!Number.isInteger(message.roomRevision)) return true;
    if (message.roomRevision <= state.lastRoomRevision) return false;
    state.lastRoomRevision = message.roomRevision;
    return true;
  }

  function acceptSnapshotMatch(message, payload) {
    if (isLobbyRollback(payload)) return message.matchId == null && !payload.result;
    const envelopeMatchId = message.matchId;
    const snapshotMatchId = payload.matchId;
    const resultMatchId = payload.result && payload.result.matchId;
    const related = payload.result ? [snapshotMatchId, resultMatchId] : [snapshotMatchId];
    if (!sameMatchId(envelopeMatchId, ...related)) return false;
    if (state.matchId && !sameMatchId(state.matchId, envelopeMatchId)) return false;
    state.matchId = envelopeMatchId;
    return true;
  }

  async function handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (_) { failClosed('收到無效的對戰資料'); return; }
    if (!isValidEvent(message)) { failClosed('對戰協定版本不相容，請重新整理'); return; }
    const payload = message.payload;

    // Correlation responses must unlock their request even if roomRevision is duplicate.
    if (message.type === 'move_permit') { await handleMovePermit(message); return; }
    if (message.type === 'move_ack') { handleMoveAck(message); return; }
    if (message.type === 'error' || message.type === 'protocol_error') {
      if (payload.code === 'invalid_player_token' && !state.tokenRetryUsed && state.roomId) {
        state.tokenRetryUsed = true;
        sessionRemove(playerTokenKey(state.roomId));
        state.playerToken = null;
        state.playerId = null;
        state.players = [];
        state.connected = false;
        state.lastRoomRevision = -1;
        state.reconnectDeadline = 0;
        clearTimeout(reconnectTimer);
        const oldSocket = socket;
        socket = null;
        if (oldSocket) oldSocket.close();
        renderRoster(null, null);
        setStatus('房間憑證已過期，正在重新加入…');
        setTimeout(() => { if (state.roomId && !state.result) connect('join', false); }, 0);
        return;
      }
      if (state.pendingMove && payload.replyToCommandId === state.pendingMove.commandId) state.pendingMove = null;
      failClosed(payload.message || `伺服器拒絕對戰指令：${payload.code || 'protocol error'}`);
      return;
    }
    switch (message.type) {
      case 'room_state':
      case 'room_snapshot':
        if (!acceptSnapshotMatch(message, payload)) return;
        if (!isFreshStateEvent(message)) return;
        {
          const room = updateRoom(payload);
          if (room.me && room.me.committedAttack) await handleAttackCommit({ payload: room.me.committedAttack, matchId: message.matchId });
          else if (room.me && Array.isArray(room.me.pendingAttacks) && room.me.pendingAttacks.length && !state.pendingAttack) {
            await handleAttackPending({ payload: room.me.pendingAttacks[0], matchId: message.matchId });
          }
          if (state.pendingMove) {
            if (state.pendingMove.commit) sendEnvelope(state.pendingMove.commit);
            else if (state.pendingMove.intentMessage) sendEnvelope(state.pendingMove.intentMessage);
          }
          if (state.pendingAttack && state.pendingAttack.planMessage) sendEnvelope(state.pendingAttack.planMessage);
          if (payload.result && !state.result) {
            if (!showResult(payload.result, message.matchId)) return;
            if (payload.replayAvailable) sendCommand('get_replay', {});
            else if (payload.replayUnavailableReason) await loadReplay({ available: false, reason: payload.replayUnavailableReason }, message.matchId);
          }
        }
        break;
      case 'match_start': startMatch(message); break;
      case 'progress':
        if (!payload.playerId || String(payload.playerId) !== state.playerId) {
          $('mp-opponent-score').textContent = Number.isFinite(payload.score) ? payload.score : 0;
          const me = state.players.find(player => String(player.playerId || player.id) === state.playerId);
          renderScoreGap(me, { score: payload.score });
        }
        break;
      case 'attack_pending': await handleAttackPending(message); break;
      case 'attack_commit': await handleAttackCommit(message); break;
      case 'attack_ack':
      case 'attack_applied_ack':
        if (!canMutateBoard(message)) break;
        state.pendingAttack = null;
        updateAttackHud();
        if (state.matchActive && !state.localGameOver && !state.pendingMove) setLocked(false);
        drainAttackQueue().catch(() => failClosed('無法處理下一筆攻擊'));
        break;
      case 'ready_ack':
        state.ready = payload.ready === true;
        $('mp-ready-btn').textContent = state.ready ? '取消 Ready' : 'Ready';
        {
          const me = state.players.find(player => String(player.playerId || player.id) === state.playerId);
          const opponent = state.players.find(player => String(player.playerId || player.id) !== state.playerId);
          if (me) me.ready = state.ready;
          renderRoster(me, opponent);
        }
        break;
      case 'rematch_ready_ack':
        $('mp-rematch-btn').disabled = payload.ready === true;
        $('mp-rematch-btn').textContent = payload.ready === true ? '等待對手…' : '再來一局';
        break;
      case 'move_rejected':
      case 'move_gap':
        if (message.matchId !== state.matchId) break;
        if (state.pendingMove && state.pendingMove.commit) failClosed('已落子但伺服器拒絕 commit，等待重新同步');
        else {
          state.pendingMove = null;
          if (state.matchActive && state.connected) setLocked(false, `落子未接受：${payload.code || '請重試'}`);
          drainAttackQueue().catch(() => failClosed('無法處理待接收攻擊'));
        }
        break;
      case 'attack_rejected':
        if (message.matchId === state.matchId) failClosed(`攻擊同步失敗：${payload.code || '請重連'}`);
        break;
      case 'match_result': showResult(payload, message.matchId); break;
      case 'replay_ready': await loadReplay(payload, message.matchId); break;
      case 'replay_bundle': await loadReplay({ available: true, bundle: payload.bundle }, message.matchId); break;
      case 'replay_unavailable': await loadReplay({ available: false, reason: payload.reason }, message.matchId); break;
      default: break;
    }
  }

  function startMatch(message) {
    const payload = message.payload;
    const rules = String(payload.rulesVersion || '');
    if (!SUPPORTED_RULES.has(rules)) { failClosed('規則版本不相容，請更新頁面'); return; }
    if (!Number.isFinite(payload.startsAt) || !Number.isFinite(payload.endsAt) || payload.endsAt <= payload.startsAt) {
      failClosed('比賽時間資料無效'); return;
    }
    resetMatchState();
    state.matchId = message.matchId || payload.matchId;
    state.seed = payload.seed;
    state.randomState = seedToUint32(payload.seed);
    state.pieceSetIndex = 0;
    state.startsAt = payload.startsAt;
    state.endsAt = payload.endsAt;
    state.matchActive = true;
    if (payload.mode === 'score' || payload.mode === 'attack') state.mode = payload.mode;
    document.body.classList.add('mp-active');
    $('mp-result-overlay').classList.remove('show');
    $('mp-replay-boards').hidden = true;
    $('mp-replay-controls').hidden = true;
    $('mp-rematch-btn').disabled = false;
    $('mp-rematch-btn').textContent = '再來一局';
    $('mp-hud').hidden = false;
    $('mp-ready-btn').disabled = true;
    $('mp-score-gap').textContent = '目前平手';
    $('mp-score-gap').classList.remove('ahead', 'behind', 'pulse');
    adapter.startMatch(payload);
    setLocked(true);
    startClock();
  }

  function startClock() {
    clearInterval(clockTimer);
    const tick = () => {
      if (!state.matchActive) return;
      const now = Date.now();
      if (now < state.startsAt) {
        $('mp-clock').textContent = Math.max(1, Math.ceil((state.startsAt - now) / 1000));
        setLocked(true);
        setStatus('倒數中…');
      } else if (now < state.endsAt) {
        $('mp-clock').textContent = Math.ceil((state.endsAt - now) / 1000) + 's';
        if (state.connected && !state.localGameOver && !state.pendingMove && !state.pendingAttack && state.inputLocked) setLocked(false, '對戰進行中');
      } else {
        $('mp-clock').textContent = '結算';
        setLocked(true, '時間到，正在結算…');
      }
    };
    tick();
    clockTimer = setInterval(tick, 250);
  }

  function seedToUint32(seed) {
    if (Number.isInteger(seed)) return seed >>> 0;
    let h = 2166136261;
    for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function random() {
    let t = state.randomState = (state.randomState + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextPieceSet(defCount, colorCount) {
    if (!state.matchActive) return null;
    state.pieceSetIndex++;
    return Array.from({ length: 3 }, () => ({
      d: Math.floor(random() * defCount), c: Math.floor(random() * colorCount)
    }));
  }

  function matchTime() {
    return Math.min(Math.max(0, state.endsAt - state.startsAt), Math.max(0, Date.now() - state.startsAt));
  }

  function requestMove(intent, apply) {
    if (!state.matchActive || state.inputLocked || state.pendingMove || !state.connected) return false;
    const message = envelope('move_intent', Object.assign({}, intent, {
      baseBoardEventSeq: state.lastBoardEventSeq,
      pieceSetIndex: state.pieceSetIndex,
      t: matchTime()
    }));
    state.pendingMove = { commandId: message.commandId, intent, apply, reservationId: null, commit: null, intentMessage: message };
    setLocked(true, '等待伺服器確認落子…');
    if (!sendEnvelope(message)) {
      state.pendingMove = null;
      failClosed('未連線，不能落子');
      return false;
    }
    return true;
  }

  async function handleMovePermit(message) {
    const pending = state.pendingMove;
    const replyTo = message.payload.replyToCommandId || message.replyToCommandId;
    if (!canMutateBoard(message)) {
      if (pending && (!replyTo || replyTo === pending.commandId)) state.pendingMove = null;
      return;
    }
    if (!pending || (replyTo && replyTo !== pending.commandId)) return;
    if (!message.payload.reservationId) { failClosed('落子許可缺少 reservation'); return; }
    pending.reservationId = message.payload.reservationId;
    const applied = pending.apply(message.payload);
    if (!applied) { failClosed('取得許可後無法套用落子'); return; }
  }

  async function commitMove(data) {
    const pending = state.pendingMove;
    if (!pending || !pending.reservationId || pending.commit) { failClosed('落子 commit 狀態不一致'); return; }
    const boardHash = await sha256(data.board);
    const payload = Object.assign({}, data, {
      reservationId: pending.reservationId,
      boardHash,
      baseBoardEventSeq: state.lastBoardEventSeq,
      pieceSetIndex: Number.isInteger(data.pieceSetIndex) ? data.pieceSetIndex : state.pieceSetIndex,
      t: matchTime()
    });
    delete payload.board;
    pending.commit = envelope('move_commit', payload);
    if (!sendEnvelope(pending.commit)) failClosed('落子已套用但 commit 尚未送達，等待重連');
  }

  function handleMoveAck(message) {
    const pending = state.pendingMove;
    const replyTo = message.payload.replyToCommandId || message.replyToCommandId;
    if (!canMutateBoard(message)) {
      if (pending && (!replyTo || (pending.commit && replyTo === pending.commit.commandId))) state.pendingMove = null;
      return;
    }
    if (!pending || (replyTo && pending.commit && replyTo !== pending.commit.commandId)) return;
    if (Number.isInteger(message.payload.moveSeq)) state.lastMoveSeq = Math.max(state.lastMoveSeq, message.payload.moveSeq);
    if (Number.isInteger(message.payload.boardEventSeq)) {
      state.lastBoardEventSeq = Math.max(state.lastBoardEventSeq, message.payload.boardEventSeq);
      state.lastAppliedBoardEventSeq = Math.max(state.lastAppliedBoardEventSeq, message.payload.boardEventSeq);
    }
    const attackCount = Number(message.payload.attackCount) || Number(message.payload.attack && message.payload.attack.count) || 0;
    if (attackCount > 0) { state.sent += attackCount; updateAttackHud(); }
    state.pendingMove = null;
    if (state.pendingGameOver) sendGameOver().catch(() => failClosed('無法送出 game over 狀態'));
    if (state.matchActive && !state.localGameOver && !state.pendingAttack && Date.now() < state.endsAt) setLocked(false, '落子已同步');
    drainAttackQueue().catch(() => failClosed('無法處理待接收攻擊'));
  }

  function mulberryShuffle(items, attackSeed) {
    let x = seedToUint32(attackSeed);
    const next = () => {
      let t = x = (x + 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  async function handleAttackPending(message, alreadyCounted) {
    if (!canMutateBoard(message) || state.mode !== 'attack') return;
    const payload = message.payload;
    if (!payload.attackId || !Number.isInteger(payload.count) || payload.count < 1) { failClosed('攻擊資料無效'); return; }
    if (state.appliedAttacks.has(payload.attackId) || state.pendingAttack?.attackId === payload.attackId || state.attackQueue.some(a => a.attackId === payload.attackId)) return;
    if (!alreadyCounted) {
      state.incoming += payload.count;
      updateAttackHud();
    }
    if (state.pendingMove || state.pendingAttack) {
      state.attackQueue.push(payload);
      setLocked(true, `即將收到 ${state.incoming} 格障礙`);
      return;
    }
    state.pendingAttack = payload;
    setLocked(true, `即將收到 ${payload.count} 格障礙`);
    if (adapter.cancelInteraction) adapter.cancelInteraction();
    const empty = adapter.getEmptyCells();
    const allowed = Math.min(payload.count, 10 - adapter.getObstacleCount(), empty.length);
    const cells = mulberryShuffle(empty, payload.attackSeed).slice(0, Math.max(0, allowed));
    state.pendingAttack.planMessage = sendCommand('attack_plan', {
      attackId: payload.attackId,
      baseBoardEventSeq: state.lastBoardEventSeq,
      cells,
      t: matchTime()
    });
  }

  async function drainAttackQueue() {
    if (!state.matchActive || state.pendingMove || state.pendingAttack || !state.attackQueue.length) return;
    const next = state.attackQueue.shift();
    await handleAttackPending({ payload: next, matchId: state.matchId }, true);
  }

  async function handleAttackCommit(message) {
    const payload = message.payload;
    if (!canMutateBoard(message)) {
      const replyTo = payload && (payload.replyToCommandId || message.replyToCommandId);
      if (state.pendingAttack && state.pendingAttack.planMessage && replyTo === state.pendingAttack.planMessage.commandId) state.pendingAttack = null;
      return;
    }
    if (!payload.attackId || !Number.isInteger(payload.boardEventSeq) || !Array.isArray(payload.cells)) {
      failClosed('攻擊 commit 無效'); return;
    }
    const prior = state.appliedAttacks.get(payload.attackId);
    if (prior) { sendEnvelope(prior); return; }
    if (state.applyingAttackIds.has(payload.attackId)) return;
    if (payload.boardEventSeq !== state.lastAppliedBoardEventSeq + 1) {
      failClosed('攻擊事件序號不連續，已停止套用'); return;
    }
    state.applyingAttackIds.add(payload.attackId);
    setLocked(true);
    const result = adapter.applyAttack(payload.cells);
    if (!result) { failClosed('攻擊格與棋盤不一致，拒絕部分套用'); return; }
    const postBoardHash = await sha256(result.board);
    const pendingCount = Number(state.pendingAttack && state.pendingAttack.count) || Number(payload.count) || payload.cells.length;
    state.lastBoardEventSeq = payload.boardEventSeq;
    state.lastAppliedBoardEventSeq = payload.boardEventSeq;
    if (result.gameOver) state.localGameOver = true;
    const reply = envelope('attack_applied', {
      attackId: payload.attackId,
      boardEventSeq: payload.boardEventSeq,
      postBoardHash,
      postObstacleCount: result.obstacleCount,
      gameOver: !!result.gameOver,
      finalMoveSeq: state.lastMoveSeq,
      finalBoardEventSeq: payload.boardEventSeq,
      finalScore: result.score
    });
    state.appliedAttacks.set(payload.attackId, reply);
    state.applyingAttackIds.delete(payload.attackId);
    sendEnvelope(reply);
    state.incoming = Math.max(0, state.incoming - pendingCount);
    updateAttackHud();
  }

  function updateAttackHud() {
    $('mp-attack-status').textContent = `收 ${state.incoming}／送 ${state.sent}`;
  }

  async function reportGameOver(data) {
    if (!state.matchActive) return;
    state.localGameOver = true;
    setLocked(true, '你已無法落子，等待對手結束');
    state.pendingGameOver = data;
    if (!state.pendingMove) await sendGameOver();
  }

  async function sendGameOver() {
    const data = state.pendingGameOver;
    if (!data || !state.matchActive) return;
    const finalBoardHash = await sha256(data.board);
    sendCommand('game_over', {
      finalMoveSeq: state.lastMoveSeq,
      finalBoardEventSeq: state.lastBoardEventSeq,
      finalScore: data.score,
      finalBoardHash
    });
    state.pendingGameOver = null;
  }

  function showResult(result, envelopeMatchId) {
    if (!sameMatchId(String(state.matchId || ''), envelopeMatchId, result && result.matchId)) return false;
    if (state.result && String(state.result.matchId || '') === String(result.matchId || '')) return true;
    if (state.historyReplayActive) {
      if (adapter && adapter.closeReplay) adapter.closeReplay();
      state.historyReplayActive = false;
      historyReplayReturnFocus = null;
      $('mp-achievements-overlay').hidden = true;
    }
    setHistoricalResultMode(false);
    state.pendingMove = null;
    state.pendingAttack = null;
    state.pendingGameOver = null;
    state.attackQueue.length = 0;
    state.appliedAttacks.clear();
    state.applyingAttackIds.clear();
    state.incoming = 0;
    state.result = result;
    state.matchActive = false;
    clearInterval(clockTimer);
    setLocked(true);
    const scores = result.scores || {};
    const entries = Object.entries(scores);
    const won = Boolean(result.winnerId && String(result.winnerId) === state.playerId);
    const newlyUnlocked = recordResultProgress(result);
    $('mp-result-title').textContent = result.winnerId == null ? '平手' : (won ? '你贏了！' : '對手獲勝');
    $('mp-result-scores').textContent = entries.map(([id, value]) => `${playerName(id)} ${value}`).join('　');
    const reasonLabel = result.reason === 'no_moves'
      ? (won ? '對手先無法落子' : '你先無法落子')
      : result.reason === 'score' ? '180 秒比分結算'
      : result.reason === 'draw' ? '雙方平手'
      : result.reason === 'forfeit' ? (won ? '對手離開對戰' : '本局已棄權')
      : '對戰結束';
    $('mp-result-meta').textContent = `${reasonLabel} · 目前連勝 ${duelProgress.currentStreak}`;
    $('mp-new-achievements').textContent = '';
    $('mp-new-achievements').hidden = newlyUnlocked.length === 0;
    for (const achievement of newlyUnlocked) {
      const chip = document.createElement('span');
      chip.className = 'mp-unlock-chip';
      chip.textContent = `${achievement.icon} 新成就：${achievement.name}`;
      $('mp-new-achievements').appendChild(chip);
    }
    $('mp-result-overlay').classList.add('show');
    $('mp-rematch-btn').disabled = false;
    $('mp-rematch-btn').textContent = '再來一局';
    $('mp-replay-open').disabled = true;
    $('mp-replay-status').textContent = '回放準備中…';
    setStatus('本局已結束');
    return true;
  }

  function playerName(id) {
    const player = state.players.find(p => String(p.playerId || p.id) === String(id));
    return player ? (player.name || '玩家') : '玩家';
  }

  async function loadReplay(payload, envelopeMatchId) {
    const capturedMatchId = String(state.matchId || '');
    if (!replayPayloadMatchesCurrent(payload, envelopeMatchId, capturedMatchId)) return false;
    const generation = ++state.replayLoadGeneration;
    state.replayBundle = null;
    state.replayError = '';
    $('mp-replay-open').disabled = true;
    if (payload.available === false || payload.reason) {
      state.replayError = payload.reason || '回放不可用';
      $('mp-replay-status').textContent = `回放不可用：${state.replayError}`;
      return true;
    }
    try {
      const bundle = payload.bundle;
      if (!bundle) throw new Error('缺少回放資料');
      await adapter.prepareReplay(bundle);
      if (!replayLoadIsCurrent(generation, capturedMatchId, payload, envelopeMatchId)) return false;
      if (!storeValidatedReplay(bundle, envelopeMatchId)) return false;
      if (!replayLoadIsCurrent(generation, capturedMatchId, payload, envelopeMatchId)) return false;
      state.replayBundle = bundle;
      $('mp-replay-open').disabled = false;
      $('mp-replay-status').textContent = '回放已就緒';
      return true;
    } catch (error) {
      if (!replayLoadIsCurrent(generation, capturedMatchId, payload, envelopeMatchId)) return false;
      state.replayError = error && error.message ? error.message : '完整性驗證失敗';
      $('mp-replay-open').disabled = true;
      $('mp-replay-status').textContent = `回放不可用：${state.replayError}`;
      return false;
    }
  }

  async function sha256(value) {
    if (!crypto.subtle) throw new Error('瀏覽器不支援回放完整性驗證');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function selectMode() {
    const next = $('mp-mode').value;
    if (!['score', 'attack'].includes(next)) return;
    if (state.matchActive || state.roomId) {
      $('mp-mode').value = state.mode;
      setStatus('已加入房間，結束後才能切換模式', 'error');
      return;
    }
    resetRoomState(next);
    $('mp-room-controls').hidden = false;
    $('mp-hud').hidden = true;
    setLocked(true);
    setStatus(next === 'attack' ? '障礙對戰：消行會送出障礙' : '比分快賽：180 秒比總分');
  }

  function renderPlayArea(area) {
    const multiplayer = area === 'multiplayer';
    $('play-area-solo').setAttribute('aria-selected', String(!multiplayer));
    $('play-area-multiplayer').setAttribute('aria-selected', String(multiplayer));
    $('play-area-solo').tabIndex = multiplayer ? -1 : 0;
    $('play-area-multiplayer').tabIndex = multiplayer ? 0 : -1;
    $('mp-panel').hidden = !multiplayer;
  }

  function enterMultiplayerArea() {
    renderPlayArea('multiplayer');
    if (state.mode === 'solo') {
      const mode = ['score', 'attack'].includes($('mp-mode').value) ? $('mp-mode').value : 'score';
      resetRoomState(mode);
    }
    $('mp-mode').value = state.mode === 'attack' ? 'attack' : 'score';
    $('mp-room-controls').hidden = false;
    setLocked(true);
    setStatus(state.mode === 'attack' ? '障礙對戰：消行會送出障礙' : '比分快賽：180 秒比總分');
  }

  function enterSoloArea() {
    if (state.matchActive || state.result) {
      renderPlayArea('multiplayer');
      setStatus('對戰進行中，結束後才能返回單人遊戲', 'error');
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN && state.roomId) {
      try { sendCommand('leave', {}); } catch (_) {}
    }
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    resetRoomState('solo');
    document.body.classList.remove('mp-active', 'mp-input-locked');
    $('mp-hud').hidden = true;
    $('mp-ready-btn').disabled = true;
    $('mp-ready-btn').textContent = 'Ready';
    renderRoster(null, null);
    $('mp-copy-room-btn').disabled = true;
    renderPlayArea('solo');
    setStatus('單人模式');
    if (adapter.restoreSolo) adapter.restoreSolo();
  }

  function leaveFinishedRoom() {
    const finishedMode = state.mode === 'attack' ? 'attack' : 'score';
    if (socket) { socket.onclose = null; socket.close(); socket = null; }
    resetRoomState(finishedMode);
    document.body.classList.remove('mp-active', 'mp-input-locked');
    $('mp-result-overlay').classList.remove('show');
    $('mp-replay-boards').hidden = true;
    $('mp-replay-controls').hidden = true;
    $('mp-mode').value = finishedMode;
    $('mp-room-controls').hidden = false;
    $('mp-hud').hidden = true;
    $('mp-ready-btn').disabled = true;
    $('mp-ready-btn').textContent = 'Ready';
    renderRoster(null, null);
    $('mp-copy-room-btn').disabled = true;
    renderPlayArea('multiplayer');
    setStatus(finishedMode === 'attack' ? '障礙對戰：消行會送出障礙' : '比分快賽：180 秒比總分');
    adapter.restoreSolo();
    setLocked(true);
  }

  function init(gameAdapter) {
    adapter = gameAdapter;
    $('play-area-solo').addEventListener('click', enterSoloArea);
    $('play-area-multiplayer').addEventListener('click', enterMultiplayerArea);
    // 大廳改為 modal 後的關閉途徑：關閉鈕／點遮罩／Esc → 離開多人回單人（enterSoloArea 在對戰中會自行拒絕）。
    $('mp-panel-close').addEventListener('click', enterSoloArea);
    $('mp-panel').addEventListener('click', event => { if (event.target === $('mp-panel')) enterSoloArea(); });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || $('mp-panel').hidden) return;
      if (document.body.classList.contains('mp-active') || !$('mp-achievements-overlay').hidden) return;
      enterSoloArea();
    });
    $('mp-mode').addEventListener('change', selectMode);
    $('mp-create-btn').addEventListener('click', () => startConnection('create'));
    $('mp-join-btn').addEventListener('click', () => startConnection('join'));
    $('mp-copy-room-btn').addEventListener('click', copyRoomCode);
    $('mp-achievement-open').addEventListener('click', () => openAchievements('achievements'));
    $('mp-history-open').addEventListener('click', () => openAchievements('history'));
    $('mp-achievement-close').addEventListener('click', closeAchievements);
    $('mp-achievements-overlay').addEventListener('click', event => { if (event.target === $('mp-achievements-overlay')) closeAchievements(); });
    $('mp-achievements-overlay').addEventListener('keydown', handleAchievementsKeydown);
    for (const tab of $('mp-achievements-tabs').querySelectorAll('[role="tab"]')) {
      tab.addEventListener('click', () => selectAchievementsTab(tab.dataset.mpTab, false));
    }
    $('mp-history-clear').addEventListener('click', () => {
      if (!duelReplayHistory.length || !confirm('確定要清除所有多人回放紀錄嗎？')) return;
      duelReplayHistory = [];
      try { localStorage.removeItem(REPLAY_HISTORY_KEY); } catch (_) {}
      updateReplayHistoryUI();
      $('mp-history-tab').focus();
    });
    $('mp-ready-btn').addEventListener('click', () => {
      if (!state.connected) return;
      state.ready = !state.ready;
      $('mp-ready-btn').textContent = state.ready ? '取消 Ready' : 'Ready';
      const me = state.players.find(player => String(player.playerId || player.id) === state.playerId);
      const opponent = state.players.find(player => String(player.playerId || player.id) !== state.playerId);
      if (me) me.ready = state.ready;
      renderRoster(me, opponent);
      sendCommand('ready', { ready: state.ready, rulesVersion: 'duel-v1' });
    });
    $('mp-result-close').addEventListener('click', () => {
      if (state.historyReplayActive) closeHistoryReplay();
      else leaveFinishedRoom();
    });
    $('mp-rematch-btn').addEventListener('click', () => {
      if (!state.connected || !state.result) return;
      $('mp-rematch-btn').disabled = true;
      sendCommand('rematch_ready', { ready: true, rulesVersion: 'duel-v1' });
    });
    $('mp-replay-open').addEventListener('click', () => {
      if (!state.replayBundle) { $('mp-replay-status').textContent = '回放尚未就緒'; return; }
      adapter.openReplay();
    });
    window.addEventListener('pagehide', () => {
      if (state.matchActive && socket && socket.readyState === WebSocket.OPEN) {
        try { sendCommand('forfeit', { pageInstanceId: state.pageInstanceId }); } catch (_) {}
      }
    });
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (state.historyReplayActive) closeHistoryReplay();
      else if (!$('mp-achievements-overlay').hidden) closeAchievements();
    });
    let savedName = '';
    try { savedName = localStorage.getItem('bpz_duel_name') || ''; } catch (_) {}
    if (savedName) $('mp-name').value = savedName;
    $('mp-name').addEventListener('change', () => {
      try { localStorage.setItem('bpz_duel_name', $('mp-name').value.trim().slice(0, 16)); } catch (_) {}
    });
    renderAchievementUI();
    renderReplayHistory();
    renderPlayArea('solo');
  }

  function selfTest() {
    const original = state.randomState;
    const shuffled = mulberryShuffle([0,1,2,3,4,5,6,7,8], 325059421);
    state.randomState = original;
    const saved = {
      matchActive: state.matchActive, matchId: state.matchId, result: state.result,
      playerId: state.playerId, replayLoadGeneration: state.replayLoadGeneration,
    };
    state.matchActive = true; state.matchId = 'new-match'; state.result = null;
    const boardGate = canMutateBoard({ matchId: 'new-match' }) && !canMutateBoard({ matchId: 'old-match' });
    state.result = {}; const finishedGate = !canMutateBoard({ matchId: 'new-match' });
    const replayPlayer = (playerId, score) => ({
      playerId, name: playerId, initialGrid: '.'.repeat(81), finalBoardEventSeq: 2,
      finalBoardHash: 'a'.repeat(64), finalScore: score,
      moves: [{ boardEventSeq: 1, t: 10, d: 0, c: 0, r: 0, col: 0, obs: [], s: score, roomId: 'LEAK_VALUE', data: { unknown: true } }],
      attacks: [{ boardEventSeq: 2, t: 20, cells: [1], playerToken: 'LEAK_VALUE', events: [{ token: 'LEAK_VALUE' }] }],
      playerToken: 'LEAK_VALUE', unknown: 'LEAK_VALUE',
    });
    const historyResult = {
      matchId: 'history-match', winnerId: 'me', reason: 'score', scores: { me: 1, them: 0, intruder: 999 },
      forfeitedPlayerIds: [], unableToMovePlayerIds: [], roomId: 'LEAK_VALUE', unknown: 'LEAK_VALUE',
    };
    const historyBundle = {
      formatVersion: 1, matchId: 'history-match', result: historyResult,
      players: [replayPlayer('me', 1), replayPlayer('them', 0)], roomId: 'LEAK_VALUE', playerToken: 'LEAK_VALUE', unknown: 'LEAK_VALUE',
    };
    state.matchId = 'history-match'; state.result = historyResult; state.playerId = 'me'; state.replayLoadGeneration = 7;
    const matchGuards = replayMatchesCurrentResult(historyBundle, 'history-match') && !replayMatchesCurrentResult(historyBundle, 'other-match');
    const generationGuards = replayLoadIsCurrent(7, 'history-match', { bundle: historyBundle }, 'history-match') &&
      !replayLoadIsCurrent(6, 'history-match', { bundle: historyBundle }, 'history-match');
    const canonical = canonicalReplayBundle(historyBundle);
    const canonicalJson = JSON.stringify(canonical);
    const canonicalGuards = canonical.players[0].moves[0].d === 0 && canonical.players[0].attacks[0].cells[0] === 1 &&
      Object.keys(canonical.result.scores).length === 2 && !canonicalJson.includes('LEAK_VALUE') &&
      !/"[^"]*(?:token|roomId|unknown|events|data)[^"]*"\s*:/.test(canonicalJson);
    const migrated = canonicalHistoryEntry({
      version: 1, matchId: 'history-match', savedAt: 1, mode: 'score', localPlayerId: 'me',
      bundle: historyBundle, roomId: 'LEAK_VALUE', playerToken: 'LEAK_VALUE',
    }, 1);
    const migrationGuards = migrated && migrated.version === 2 && migrated.players[0].score === 1 &&
      migrated.bundle && !JSON.stringify(migrated).includes('LEAK_VALUE');
    const withMatch = (entry, index) => {
      const bundle = structuredClone(entry.bundle);
      bundle.matchId = `tier-${index}`;
      bundle.result.matchId = `tier-${index}`;
      return summaryFromBundle(bundle, 1000 - index, 'score', 'me');
    };
    const ten = Array.from({ length: 10 }, (_, index) => withMatch(migrated, index));
    const tieredTen = tierReplayHistory(ten, Number.MAX_SAFE_INTEGER);
    const tierGuards = tieredTen.length === 10 && tieredTen.slice(0, 8).every(entry => entry.bundle) &&
      tieredTen.slice(8).every(entry => !entry.bundle);
    const resultBudget = historyWrapperBytes(ten.slice(0, 2).map(resultOnlyEntry));
    const sizeTiered = tierReplayHistory(ten.slice(0, 2), resultBudget);
    const sizeGuards = sizeTiered.length === 2 && sizeTiered.every(entry => !entry.bundle);
    const fifty = tierReplayHistory(Array.from({ length: 55 }, (_, index) => withMatch(migrated, 100 + index)), Number.MAX_SAFE_INTEGER);
    const capGuards = fifty.length === 50;
    const restored = tierReplayHistory([resultOnlyEntry(migrated), migrated], Number.MAX_SAFE_INTEGER);
    const restoreGuards = restored.length === 1 && !!restored[0].bundle;
    const deepCorrupt = structuredClone(migrated);
    deepCorrupt.bundle.players[0].moves[0].d = 999;
    const normalFull = withMatch(migrated, 999);
    const downgradedCorrupt = downgradeHistoryReplayEntries([deepCorrupt, normalFull], deepCorrupt.matchId);
    const reloadedCorrupt = canonicalHistoryEntry(downgradedCorrupt.entries.find(entry => entry.matchId === deepCorrupt.matchId), 2);
    const corruptGuards = isReplayHistoryEntry(deepCorrupt) && downgradedCorrupt.changed && reloadedCorrupt && !reloadedCorrupt.bundle &&
      !!downgradedCorrupt.entries.find(entry => entry.matchId === normalFull.matchId)?.bundle;
    const historyGuards = isReplayHistoryEntry(migrated) && tierReplayHistory([migrated, migrated]).length === 1 && utf8Bytes('對') === 3;
    Object.assign(state, saved);
    return shuffled.join(',') === '8,1,3,5,7,4,0,2,6' && boardGate && finishedGate && matchGuards && generationGuards && canonicalGuards &&
      migrationGuards && tierGuards && sizeGuards && capGuards && restoreGuards && corruptGuards && historyGuards &&
      ACHIEVEMENTS.length === 7 && ACHIEVEMENTS.some(achievement => achievement.id === 'knockout') &&
      isLobbyRollback({status:'lobby',matchId:null}) &&
      defaultServerBase('http://localhost:8765/') === 'http://localhost:8787' &&
      defaultServerBase('http://127.0.0.1:8000/') === 'http://127.0.0.1:8787' &&
      defaultServerBase('http://[::1]:3000/') === 'http://[::1]:8787' &&
      defaultServerBase('https://mitsabkpuz.vercel.app/play') === 'https://block-puzzle-multiplayer.xingencai060.workers.dev' &&
      resolveServerBase('https://mitsabkpuz.vercel.app/', '?mpServer=https%3A%2F%2Foverride.example%2Fws') === 'https://override.example/ws' &&
      defaultServerBase('https://game.example/') === 'https://game.example' &&
      buildSocketUrl('http://127.0.0.1:8787/base/', 'ROOM1') === 'ws://127.0.0.1:8787/base/room/ROOM1';
  }

  window.Multiplayer = {
    init,
    isMatchActive: () => state.matchActive,
    isAttackMode: () => state.matchActive && state.mode === 'attack',
    isInputLocked: () => state.inputLocked,
    requestMove,
    commitMove,
    reportGameOver,
    nextPieceSet,
    getPieceSetIndex: () => state.pieceSetIndex,
    getProgress: () => structuredClone(duelProgress),
    sha256,
    selfTest
  };
}());
