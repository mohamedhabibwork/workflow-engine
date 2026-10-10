const BASE_36 = 36;
const STRING_PREFIX_END = 2;
const RANDOM_SEGMENT_LENGTH = 10;

/**
 * Runtime-agnostic identifier generator. Prefers WebCrypto's UUID,
 * falling back to a timestamp/entropy mix for exotic runtimes.
 */
export function randomId(): string {
  // The cast acknowledges runtimes where `crypto` is missing despite the types.
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  const timestamp = Date.now().toString(BASE_36);
  const entropy = Math.random()
    .toString(BASE_36)
    .slice(STRING_PREFIX_END, STRING_PREFIX_END + RANDOM_SEGMENT_LENGTH);
  return `run-${timestamp}-${entropy}`;
}
