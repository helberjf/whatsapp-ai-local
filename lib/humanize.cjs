const {ApiError} = require('./evolution.cjs');

// Tempo "de gente" para respostas automáticas (robô de palavras-chave e IA automática):
// espera aleatória antes de começar (como quem lê a mensagem) e "digitando…" proporcional ao tamanho do texto.
const DEFAULTS = {typing: true, randomDelay: true, readMinSeconds: 3, readMaxSeconds: 10, typingMinMsPerChar: 35, typingMaxMsPerChar: 70, maxTypingSeconds: 20};
const MIN_TYPING_MS = 1200;

const numberIn = (value, label, min, max) => {
  const number = Number(value);
  if (value === '' || value === null || !Number.isFinite(number) || number < min || number > max) throw new ApiError(`${label}: use um valor entre ${min} e ${max}.`, 422);
  return number;
};

function normalizeHumanize(input = {}) {
  const merged = {...DEFAULTS, ...input};
  for (const key of ['typing', 'randomDelay']) if (typeof merged[key] !== 'boolean') throw new ApiError('Opção inválida em "Parecer humano".', 422);
  const result = {
    typing: merged.typing, randomDelay: merged.randomDelay,
    readMinSeconds: numberIn(merged.readMinSeconds, 'Espera mínima', 0, 120),
    readMaxSeconds: numberIn(merged.readMaxSeconds, 'Espera máxima', 0, 120),
    typingMinMsPerChar: numberIn(merged.typingMinMsPerChar, 'Digitação mínima', 5, 400),
    typingMaxMsPerChar: numberIn(merged.typingMaxMsPerChar, 'Digitação máxima', 5, 400),
    maxTypingSeconds: numberIn(merged.maxTypingSeconds, 'Limite de digitação', 1, 60)
  };
  if (result.readMinSeconds > result.readMaxSeconds) throw new ApiError('A espera mínima não pode passar da máxima.', 422);
  if (result.typingMinMsPerChar > result.typingMaxMsPerChar) throw new ApiError('A digitação mínima não pode passar da máxima.', 422);
  return result;
}

const between = (low, high, random) => low + (high - low) * random();

// Plano para um texto: quanto esperar antes de "começar a digitar" e por quanto tempo mostrar "digitando…".
function plan(text, config, random = Math.random) {
  const waitMs = config.randomDelay ? Math.round(between(config.readMinSeconds, config.readMaxSeconds, random) * 1000) : 0;
  const typingMs = config.typing
    ? Math.round(Math.min(config.maxTypingSeconds * 1000, Math.max(MIN_TYPING_MS, String(text).length * between(config.typingMinMsPerChar, config.typingMaxMsPerChar, random))))
    : 0;
  return {waitMs, typingMs};
}

function createHumanizer({store, random = Math.random, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  const settings = async () => normalizeHumanize((await store.read()).humanize || {});
  return {
    settings,
    sleep,
    async plan(text) {return plan(text, await settings(), random);},
    async save(input) {
      const config = normalizeHumanize(input);
      await store.update(data => {data.humanize = config;});
      return config;
    }
  };
}

module.exports = {DEFAULTS, normalizeHumanize, plan, createHumanizer};
