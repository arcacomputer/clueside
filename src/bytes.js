/**
 * Byte transport helpers. chrome.runtime.sendMessage JSON-serializes
 * payloads, so ArrayBuffer and Uint8Array do not survive the trip.
 * Small binary payloads (blob/data URLs, popup file drops) are sent as
 * base64 strings and reconstructed on the receiving side.
 */

const CHUNK = 0x8000;

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {string}
 */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  if (typeof base64 !== 'string') {
    throw new Error('Expected base64 string');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
