/**
 * Deterministic metadata and byte-level heuristics on original image bytes.
 */

import exifr from 'exifr';
import { readC2paAiSignal } from './c2pa-reader.js';

const AI_SOFTWARE_PATTERNS = [
  /midjourney/i,
  /dall[\s-]?e/i,
  /chatgpt/i,
  /adobe\s*firefly/i,
  /\bfirefly\b/i,
  /stable\s*diffusion/i,
  /\bcomfyui\b/i,
  /\bflux\b/i,
  /\bgrok\b/i,
  /\bimagen\b/i,
  /\bleonardo\b/i,
  /automatic1111/i,
  /\ba1111\b/i,
];

const URL_HINT_PATTERNS = [
  { pattern: /oaidalleapiprodscus/i, reason: 'URL suggests OpenAI image CDN' },
  { pattern: /cdn\.midjourney/i, reason: 'URL suggests Midjourney CDN' },
  { pattern: /firefly\.adobe/i, reason: 'URL suggests Adobe Firefly' },
  { pattern: /replicate\.delivery/i, reason: 'URL suggests Replicate delivery' },
  { pattern: /fal\.media/i, reason: 'URL suggests fal.ai media' },
  { pattern: /images\.openai\.com/i, reason: 'URL suggests OpenAI images host' },
];

const C2PA_AI_TYPES = new Set([
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
  'trainedAlgorithmicMedia',
  'compositeWithTrainedAlgorithmicMedia',
]);

const PNG_TEXT_KEYS = ['parameters', 'prompt', 'workflow', 'comfy', 'software'];

/**
 * @param {ArrayBuffer} buffer
 * @param {string} [url]
 * @returns {Promise<import('./fuse.js').HeuristicSignals>}
 */
export async function analyzeHeuristics(buffer, url = '') {
  const bytes = new Uint8Array(buffer);
  const reasons = [];

  const c2pa = await resolveC2pa(bytes);
  if (c2pa.ai) reasons.push(c2pa.reason);

  const exif = await parseExifMetadata(buffer);
  if (exif.ai) reasons.push(exif.reason);

  const embedded = scanEmbeddedText(bytes);
  if (embedded.ai) reasons.push(embedded.reason);

  const urlHint = scanUrlHints(url);

  const freqResidualVote = computeFrequencyResidualVote(bytes);

  return {
    c2paAi: c2pa.ai,
    c2paReason: c2pa.reason,
    metadataAi: exif.ai || embedded.ai,
    metadataReason: exif.ai ? exif.reason : embedded.ai ? embedded.reason : null,
    urlHint: urlHint.hit,
    urlHintReason: urlHint.reason,
    freqResidualVote,
    reasons,
  };
}

/**
 * Prefer c2pa-web in the extension offscreen context; fall back to byte scan.
 * @param {Uint8Array} bytes
 */
export async function resolveC2pa(bytes) {
  const fromSdk = await readC2paAiSignal(bytes);
  if (fromSdk) return fromSdk;
  return parseC2paScan(bytes);
}

/**
 * Latin-1 substring scan for C2PA markers (fallback when SDK unavailable).
 * @param {Uint8Array} bytes
 */
export function parseC2paScan(bytes) {
  const marker = asciiBytes('c2pa');
  const jumbMarker = asciiBytes('jumb');

  for (let i = 0; i < bytes.length - 8; i++) {
    if (matchAt(bytes, marker, i) || matchAt(bytes, jumbMarker, i)) {
      const slice = bytes.subarray(Math.max(0, i - 64), Math.min(bytes.length, i + 65536));
      const text = latin1Decode(slice);

      for (const type of C2PA_AI_TYPES) {
        if (text.includes(type) || text.includes('trainedAlgorithmicMedia')) {
          const composite = text.includes('compositeWithTrainedAlgorithmicMedia');
          return {
            ai: true,
            reason: composite
              ? 'C2PA digitalSourceType: composite with trained algorithmic media'
              : 'C2PA digitalSourceType: trained algorithmic media',
          };
        }
      }
    }
  }

  return { ai: false, reason: null };
}

/**
 * @param {ArrayBuffer} buffer
 */
export async function parseExifMetadata(buffer) {
  try {
    const tags = await exifr.parse(buffer, {
      iptc: true,
      xmp: true,
      mergeOutput: true,
      reviveValues: false,
    });

    if (!tags) return { ai: false, reason: null };

    const fields = [
      tags.Software,
      tags.CreatorTool,
      tags.DigitalSourceType,
      tags['Iptc.Application2.Program'],
      tags['Iptc.Application2.ProgramVersion'],
    ];

    const blob = JSON.stringify(tags);
    const combined = [...fields.filter(Boolean), blob].join(' ');

    for (const pattern of AI_SOFTWARE_PATTERNS) {
      if (pattern.test(combined)) {
        const match = combined.match(pattern);
        return {
          ai: true,
          reason: `Metadata mentions AI generator software (${match?.[0] || 'detected'})`,
        };
      }
    }

    if (/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia/i.test(combined)) {
      return {
        ai: true,
        reason: 'XMP/IPTC DigitalSourceType indicates algorithmic media',
      };
    }
  } catch {
    // Missing or corrupt EXIF is not evidence of AI.
  }

  return { ai: false, reason: null };
}

/**
 * @param {Uint8Array} bytes
 */
export function scanEmbeddedText(bytes) {
  if (isPng(bytes)) {
    const pngText = parsePngTextChunks(bytes);
    for (const [key, value] of pngText) {
      const hay = `${key} ${value}`;
      if (PNG_TEXT_KEYS.some((k) => key.toLowerCase().includes(k))) {
        if (/steps|sampler|cfg\s*scale|negative prompt/i.test(hay)) {
          return { ai: true, reason: 'PNG text chunk contains generation parameters (A1111/ComfyUI)' };
        }
      }
      for (const pattern of AI_SOFTWARE_PATTERNS) {
        if (pattern.test(hay)) {
          return { ai: true, reason: `PNG metadata mentions ${pattern.source.replace(/\\b/g, '').slice(0, 40)}` };
        }
      }
    }
  }

  const latin = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)));

  if (/ComfyUI|CFG scale|Sampler:|civitai/i.test(latin)) {
    return { ai: true, reason: 'Embedded text references AI generation toolchain' };
  }

  if (isJpeg(bytes)) {
    const com = extractJpegComment(bytes);
    if (com) {
      for (const pattern of AI_SOFTWARE_PATTERNS) {
        if (pattern.test(com)) {
          return { ai: true, reason: 'JPEG comment references AI generator software' };
        }
      }
      if (/steps|sampler|cfg/i.test(com)) {
        return { ai: true, reason: 'JPEG comment contains generation parameters' };
      }
    }
  }

  return { ai: false, reason: null };
}

/**
 * @param {string} url
 */
export function scanUrlHints(url) {
  if (!url) return { hit: false, reason: null };
  for (const { pattern, reason } of URL_HINT_PATTERNS) {
    if (pattern.test(url)) {
      return { hit: true, reason };
    }
  }
  return { hit: false, reason: null };
}

/**
 * Cheap frequency-domain residual vote (weak, never sole AI signal).
 * @param {Uint8Array} bytes
 * @returns {number} 0..1 weak vote
 */
export function computeFrequencyResidualVote(bytes) {
  if (bytes.length < 4096) return 0;

  let highFreq = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(bytes.length / 8192));

  for (let i = step; i < Math.min(bytes.length, 65536); i += step) {
    const diff = Math.abs(bytes[i] - bytes[i - step]);
    highFreq += diff;
    total++;
  }

  if (total === 0) return 0;
  const avg = highFreq / total;
  if (avg < 18) return 0.3;
  if (avg < 28) return 0.15;
  return 0;
}

/**
 * Map transformers.js classification output to p(AI) = 1 - p_real.
 * @param {Array<{label: string, score: number}>} outputs
 */
export function neuralPAiFromClassification(outputs) {
  if (!outputs?.length) return 0.5;

  let pReal = 0;
  let pAiClasses = 0;
  const aiLabels = new Set(['stable_diffusion', 'midjourney', 'dalle', 'other_ai']);

  for (const { label, score } of outputs) {
    const norm = label.toLowerCase().replace(/\s+/g, '_');
    if (norm === 'real') {
      pReal += score;
    } else if (aiLabels.has(norm)) {
      pAiClasses += score;
    }
  }

  if (pReal > 0) {
    return clamp01(1 - pReal);
  }

  return clamp01(pAiClasses || 0.5);
}

/**
 * Optional generator class hint from top non-real label (never stated as fact).
 * @param {Array<{label: string, score: number}>} outputs
 */
export function topGeneratorHint(outputs) {
  const aiLabels = ['stable_diffusion', 'midjourney', 'dalle', 'other_ai'];
  const sorted = [...outputs].sort((a, b) => b.score - a.score);
  for (const item of sorted) {
    const norm = item.label.toLowerCase().replace(/\s+/g, '_');
    if (aiLabels.includes(norm) && item.score > 0.2) {
      return norm.replace(/_/g, ' ');
    }
  }
  return null;
}

// --- helpers ---

function isPng(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
}

function isJpeg(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function parsePngTextChunks(bytes) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === 'tEXt') {
      const raw = latin1Decode(bytes.subarray(dataStart, dataEnd));
      const nul = raw.indexOf('\0');
      const key = nul >= 0 ? raw.slice(0, nul) : raw;
      const value = nul >= 0 ? raw.slice(nul + 1) : '';
      chunks.push([key, value]);
    } else if (type === 'iTXt') {
      const raw = latin1Decode(bytes.subarray(dataStart, dataEnd));
      const parts = raw.split('\0');
      const key = parts[0] || '';
      const value = parts.slice(5).join('\0') || parts[parts.length - 1] || '';
      chunks.push([key, value]);
    }

    offset = dataEnd + 4;
  }
  return chunks;
}

function extractJpegComment(bytes) {
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xfe) {
      return latin1Decode(bytes.subarray(i + 4, i + 2 + len));
    }
    i += 2 + len;
  }
  return null;
}

function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function asciiBytes(str) {
  return new TextEncoder().encode(str);
}

function matchAt(bytes, needle, offset) {
  if (offset + needle.length > bytes.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (bytes[offset + j] !== needle[j]) return false;
  }
  return true;
}

function latin1Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
