import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAiMetadataTags, scanEmbeddedText } from '../src/heuristics.js';

function pngText(key, value) {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = new TextEncoder().encode(`${key}\0${value}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(data, 8);
  return Uint8Array.from([...signature, ...chunk]);
}

function jpegComment(value) {
  const data = new TextEncoder().encode(value);
  const length = data.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xfe,
    (length >> 8) & 0xff,
    length & 0xff,
    ...data,
    0xff,
    0xd9,
  ]);
}

describe('AI metadata detection', () => {
  it('accepts generator names in actual software fields', () => {
    assert.equal(detectAiMetadataTags({ Software: 'Adobe Firefly' }).ai, true);
    assert.equal(detectAiMetadataTags({ CreatorTool: 'FLUX.1 dev' }).ai, true);
    assert.equal(detectAiMetadataTags({ Software: 'Leonardo' }).ai, true);
  });

  it('accepts standardized digital source types and generation parameters', () => {
    assert.equal(
      detectAiMetadataTags({
        DigitalSourceType:
          'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
      }).ai,
      true
    );
    assert.equal(
      detectAiMetadataTags({ UserComment: 'Steps: 30, Sampler: Euler, CFG scale: 7' }).ai,
      true
    );
  });

  it('does not force AI from ambiguous words in captions or artist fields', () => {
    const result = detectAiMetadataTags({
      Software: 'Adobe Photoshop',
      Artist: 'Leonardo Silva',
      ImageDescription: 'Fireflies near a flux capacitor in Imagen, Spain',
      Copyright: 'Grok Family Archive',
    });
    assert.deepEqual(result, { ai: false, reason: null });
  });
});

describe('embedded text detection', () => {
  it('does not treat an ordinary PNG prompt containing ambiguous nouns as proof', () => {
    const bytes = pngText(
      'prompt',
      'A firefly above a flux capacitor, portrait in the style of Leonardo'
    );
    assert.deepEqual(scanEmbeddedText(bytes), { ai: false, reason: null });
  });

  it('detects tool fields and sampler parameters in PNG text', () => {
    assert.equal(scanEmbeddedText(pngText('Software', 'ComfyUI')).ai, true);
    assert.equal(
      scanEmbeddedText(pngText('parameters', 'Steps: 28, Sampler: Euler, CFG scale: 6')).ai,
      true
    );
  });

  it('keeps generic JPEG prose real but detects explicit generator tools', () => {
    assert.deepEqual(
      scanEmbeddedText(jpegComment('Leonardo photographed fireflies near a flux capacitor')),
      { ai: false, reason: null }
    );
    assert.equal(scanEmbeddedText(jpegComment('Generated with Adobe Firefly')).ai, true);
  });
});
