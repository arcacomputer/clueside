/**
 * Deterministic metadata and byte-level heuristics on original image bytes.
 */

import exifr from 'exifr';
import { readC2paAiSignal } from './c2pa-reader.js';

// Safe in unstructured text because each phrase names a specific tool.
const STRONG_AI_GENERATOR_PATTERNS = [
  /midjourney/i,
  /dall[\s-]?e/i,
  /chatgpt/i,
  /adobe\s*firefly/i,
  /stable\s*diffusion/i,
  /\bcomfyui\b/i,
  /\bflux(?:[.\s_-]*1)?[.\s_-]*(?:dev|schnell|pro)\b/i,
  /black\s+forest\s+labs/i,
  /\bgrok\s+(?:imagine|image(?:\s+generator)?)\b/i,
  /\b(?:google\s+)?imagen\s*[234]\b/i,
  /\bleonardo(?:\.ai|\s+ai)\b/i,
  /automatic1111/i,
  /\ba1111\b/i,
];

// Ambiguous product names are strong only inside software/tool fields.
const AI_TOOL_FIELD_PATTERNS = [
  ...STRONG_AI_GENERATOR_PATTERNS,
  /\bfirefly\b/i,
  /\bflux\b/i,
  /\bgrok\b/i,
  /\bimagen\b/i,
  /\bleonardo\b/i,
];

const GENERATION_PARAMETER_PATTERN =
  /negative prompt|cfg\s*scale|sampler\s*:|steps\s*:\s*\d+|scheduler\s*:/i;

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

const PNG_TOOL_KEYS = ['parameters', 'workflow', 'comfy', 'software', 'generator', 'creator tool'];

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

    return detectAiMetadataTags(tags);
  } catch {
    // Missing or corrupt EXIF is not evidence of AI.
  }

  return { ai: false, reason: null };
}

/**
 * Restrict ambiguous names such as "Flux", "Firefly", and "Leonardo" to
 * fields that actually identify the creating software. Scanning every EXIF
 * caption, keyword, artist, and copyright field can turn ordinary subjects
 * into a forced 97% AI verdict.
 *
 * @param {Record<string, unknown>|null|undefined} tags
 */
export function detectAiMetadataTags(tags) {
  if (!tags || typeof tags !== 'object') return { ai: false, reason: null };

  const digitalSource = stringValues([
    tags.DigitalSourceType,
    tags.digitalSourceType,
  ]).join(' ');
  if (/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia/i.test(digitalSource)) {
    return {
      ai: true,
      reason: 'XMP/IPTC DigitalSourceType indicates algorithmic media',
    };
  }

  const toolFields = stringValues([
    tags.Software,
    tags.CreatorTool,
    tags.HistorySoftwareAgent,
    tags['Iptc.Application2.Program'],
    tags['Iptc.Application2.ProgramVersion'],
  ]).join(' ');
  const toolMatch = firstMatch(toolFields, AI_TOOL_FIELD_PATTERNS);
  if (toolMatch) {
    return {
      ai: true,
      reason: `Metadata names AI generator software (${toolMatch})`,
    };
  }

  const parameterFields = stringValues([
    tags.Parameters,
    tags.parameters,
    tags.UserComment,
    tags.Comment,
    tags.GenerationData,
  ]).join(' ');
  if (GENERATION_PARAMETER_PATTERN.test(parameterFields)) {
    return { ai: true, reason: 'Metadata contains image-generation parameters' };
  }

  const strongMatch = firstMatch(parameterFields, STRONG_AI_GENERATOR_PATTERNS);
  if (strongMatch) {
    return {
      ai: true,
      reason: `Metadata names AI generator software (${strongMatch})`,
    };
  }

  // Descriptive fields are unstructured, so accept only the generator names
  // that are specific enough for free text. Ambiguous names such as "Flux"
  // and "Firefly" remain restricted to the tool fields above.
  const descriptiveFields = stringValues([
    tags.ImageDescription,
    tags.Description,
    tags.Caption,
    tags.CaptionAbstract,
    tags.Title,
    tags.Headline,
    tags.Subject,
    tags.Keywords,
    tags.XPTitle,
    tags.XPComment,
    tags.XPSubject,
  ]).join(' ');
  const descriptiveMatch = firstMatch(descriptiveFields, STRONG_AI_GENERATOR_PATTERNS);
  if (descriptiveMatch) {
    return {
      ai: true,
      reason: `Metadata names AI generator software (${descriptiveMatch})`,
    };
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
      const keyLower = key.toLowerCase();
      const isToolField = PNG_TOOL_KEYS.some((toolKey) => keyLower.includes(toolKey));

      // Generation-parameter syntax is meaningful only in fields used by
      // generator workflows. Ordinary Title/Description prose must not force
      // a 97% AI verdict merely because it says "negative prompt".
      if (isToolField && GENERATION_PARAMETER_PATTERN.test(hay)) {
        return { ai: true, reason: 'PNG text chunk contains generation parameters (A1111/ComfyUI)' };
      }

      const strongMatch = firstMatch(value, STRONG_AI_GENERATOR_PATTERNS);
      if (strongMatch) {
        return {
          ai: true,
          reason: `PNG metadata names AI generator software (${strongMatch})`,
        };
      }

      if (isToolField) {
        const match = firstMatch(hay, AI_TOOL_FIELD_PATTERNS);
        if (match) return { ai: true, reason: `PNG metadata names AI generator software (${match})` };
      }
    }
  }

  const latin = latin1Decode(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)));

  // Raw byte scanning is not field-aware. Keep it to specific tool names;
  // generic parameter words are handled only in parsed metadata fields.
  if (/ComfyUI|civitai|AUTOMATIC1111/i.test(latin)) {
    return { ai: true, reason: 'Embedded text references AI generation toolchain' };
  }

  if (isJpeg(bytes)) {
    const com = extractJpegComment(bytes);
    if (com) {
      const match = firstMatch(com, STRONG_AI_GENERATOR_PATTERNS);
      if (match) return { ai: true, reason: `JPEG comment names AI generator software (${match})` };
      if (GENERATION_PARAMETER_PATTERN.test(com)) {
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

function stringValues(values) {
  return values.flatMap((value) => {
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
    return [];
  });
}

function firstMatch(text, patterns) {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) return match[0];
  }
  return null;
}
