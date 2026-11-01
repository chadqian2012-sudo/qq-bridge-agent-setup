// Pure decisions for a completed DSH turn. Unknown cancellation is never
// interpreted as a user stop: DSH can abort internal observation work too.
export function shouldCountWakeTurn(reason, silent = false) {
  return !silent && reason?.kind === 'completed';
}

export function abortNotice(intent) {
  return intent === 'user-stop' ? '⏹️ 已停止' : null;
}

export function createStopIntentTracker() {
  const intents = new Map();
  return {
    mark(sessionId, turn, intent) {
      if (sessionId && turn != null && intent) intents.set(sessionId, { turn: String(turn), intent });
    },
    take(sessionId, turn) {
      const entry = intents.get(sessionId);
      if (!entry || turn == null || entry.turn !== String(turn)) return null;
      intents.delete(sessionId);
      return entry.intent;
    },
    clearSession(sessionId) { intents.delete(sessionId); },
    clear() { intents.clear(); }
  };
}

export function sleepTimerSegment(delay) {
  return Math.max(0, Math.min(Number(delay) || 0, 2 ** 31 - 1));
}

export function appendWakeSnapshot(prompt, snapshot) {
  if (!snapshot) return prompt;
  return `${prompt}\n\n【本次消息快照】\n${JSON.stringify(snapshot)}\n先处理快照；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 续读。收尾时只用 throughSeq 确认已处理的 readThroughSeq；它是本地 seq，不是 QQ messageId。`;
}
