// Очерёдность в разговоре: насколько легко перебить Кизуну и сколько тишины
// ждать, прежде чем ответить. Человек выбирает словами — «с полуслова»,
// «дать подумать» — и так же может сказать это вслух, а здесь слова
// переводятся на язык провайдеров. У OpenAI это порог, с которого звук
// считается речью, и длина тишины в миллисекундах. У Gemini чуткость в две
// ступени и та же тишина; «обычно» ему не отправляется вовсе — его умолчаний
// мы не знаем и угадывать их не берёмся.

export const VOICE_INTERRUPT_LEVELS = ['easy', 'normal', 'loud'];
export const VOICE_PAUSE_LEVELS = ['quick', 'normal', 'wait', 'think'];
export const VOICE_INTERRUPT_WORDS = { easy: 'с полуслова', normal: 'обычно', loud: 'только громко' };
export const VOICE_PAUSE_WORDS = { quick: 'сразу', normal: 'обычно', wait: 'подождать', think: 'дать подумать' };
// «Реже», «быстрее» — шаг по шкале от того, что стоит сейчас.
export const VOICE_INTERRUPT_STEPS = { easier: -1, harder: 1 };
export const VOICE_PAUSE_STEPS = { shorter: -1, longer: 1 };

// Порог OpenAI: 0,5 — его умолчание. Выше — шум и чужие голоса не считаются
// репликой, но и говорить приходится громче.
const THRESHOLD = { easy: 0.3, normal: 0.5, loud: 0.75 };
const SILENCE_MS = { quick: 300, normal: 500, wait: 1000, think: 2000 };

export const validVoiceInterrupt = value => VOICE_INTERRUPT_LEVELS.includes(value);
export const validVoicePause = value => VOICE_PAUSE_LEVELS.includes(value);
const levelOf = (levels, value) => (levels.includes(value) ? value : 'normal');

/**
 * Новое значение по сказанному: уровень как есть или шаг от текущего. Край
 * шкалы держит: «ещё реже» после «только громко» ничего не ломает. null —
 * слово не из этой шкалы.
 */
export function nextVoiceLevel(levels, steps, current, wanted) {
  if (levels.includes(wanted)) return wanted;
  if (!Object.hasOwn(steps, wanted)) return null;
  const index = levels.indexOf(levelOf(levels, current)) + steps[wanted];
  return levels[Math.max(0, Math.min(levels.length - 1, index))];
}

// Вход OpenAI целиком, с расшифровкой: при правке на ходу session.update
// получает тот же набор, что и токен, и не оставляет разговор без неё.
export function openaiAudioInput({ interrupt, pause } = {}) {
  return {
    transcription: { model: 'whisper-1' },
    turn_detection: {
      type: 'server_vad',
      threshold: THRESHOLD[levelOf(VOICE_INTERRUPT_LEVELS, interrupt)],
      silence_duration_ms: SILENCE_MS[levelOf(VOICE_PAUSE_LEVELS, pause)],
    },
  };
}

// realtimeInputConfig для Gemini или null, когда всё «обычно».
export function geminiRealtimeInput({ interrupt, pause } = {}) {
  const start = levelOf(VOICE_INTERRUPT_LEVELS, interrupt);
  const end = levelOf(VOICE_PAUSE_LEVELS, pause);
  const detection = {};
  if (start !== 'normal') detection.startOfSpeechSensitivity = start === 'easy' ? 'START_SENSITIVITY_HIGH' : 'START_SENSITIVITY_LOW';
  if (end !== 'normal') {
    detection.endOfSpeechSensitivity = end === 'quick' ? 'END_SENSITIVITY_HIGH' : 'END_SENSITIVITY_LOW';
    detection.silenceDurationMs = SILENCE_MS[end];
  }
  return Object.keys(detection).length ? { automaticActivityDetection: detection } : null;
}
