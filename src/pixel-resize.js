/**
 * Pillow-exact bicubic resize (8-bit ImagingResample semantics).
 *
 * Reproduces PIL.Image.resize(..., Image.BICUBIC) byte for byte:
 * bicubic kernel with a = -0.5 and support 2.0, per-axis coefficient
 * precompute with float normalization, 22-bit fixed-point weights with
 * round-half-away-from-zero, and two passes (horizontal then vertical)
 * with an 8-bit quantized intermediate, exactly like Pillow's
 * ImagingResampleHorizontal_8bpc / ImagingResampleVertical_8bpc.
 */

const PRECISION_BITS = 22;
const BICUBIC_A = -0.5;
const BICUBIC_SUPPORT = 2.0;

/**
 * Pillow's bicubic_filter. Expression shape mirrors the C source so the
 * float64 results are bit-identical.
 * @param {number} x
 * @returns {number}
 */
function bicubicKernel(x) {
  const a = BICUBIC_A;
  if (x < 0) {
    x = -x;
  }
  if (x < 1.0) {
    return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
  }
  if (x < 2.0) {
    return (((x - 5) * x + 8) * x - 4) * a;
  }
  return 0.0;
}

/**
 * Per-axis coefficient precompute, matching Pillow's precompute_coeffs
 * followed by normalize_coeffs_8bpc.
 * @param {number} inSize
 * @param {number} outSize
 * @returns {{bounds: Int32Array, kk: Int32Array[]}} bounds packs
 *   [xmin, taps] pairs per output index; kk holds the fixed-point weights.
 */
function precomputeCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const support = BICUBIC_SUPPORT * filterscale;
  const ss = 1.0 / filterscale;
  const shift = 1 << PRECISION_BITS;

  const bounds = new Int32Array(outSize * 2);
  const kk = [];

  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.floor(center - support + 0.5);
    if (xmin < 0) {
      xmin = 0;
    }
    let xmax = Math.floor(center + support + 0.5);
    if (xmax > inSize) {
      xmax = inSize;
    }
    const taps = xmax - xmin;

    const w = new Float64Array(taps);
    let ww = 0.0;
    for (let x = 0; x < taps; x++) {
      const v = bicubicKernel((x + xmin - center + 0.5) * ss);
      w[x] = v;
      ww += v;
    }

    const k = new Int32Array(taps);
    for (let x = 0; x < taps; x++) {
      const v = ww !== 0.0 ? w[x] / ww : w[x];
      // C (int)(v * shift +/- 0.5): round half away from zero, truncate.
      k[x] = v < 0 ? Math.trunc(v * shift - 0.5) : Math.trunc(v * shift + 0.5);
    }

    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = taps;
    kk.push(k);
  }

  return { bounds, kk };
}

/**
 * Horizontal pass: inW -> outW at inH rows, 8-bit quantized output.
 * @param {Uint8Array|Uint8ClampedArray|ArrayLike<number>} data
 * @param {number} inW
 * @param {number} inH
 * @param {number} channels
 * @param {number} outW
 * @returns {Uint8ClampedArray}
 */
function resampleHorizontal(data, inW, inH, channels, outW) {
  const { bounds, kk } = precomputeCoeffs(inW, outW);
  const out = new Uint8ClampedArray(outW * inH * channels);
  const half = 1 << (PRECISION_BITS - 1);

  for (let yy = 0; yy < inH; yy++) {
    const rowIn = yy * inW * channels;
    const rowOut = yy * outW * channels;
    for (let xx = 0; xx < outW; xx++) {
      const xmin = bounds[xx * 2];
      const taps = bounds[xx * 2 + 1];
      const k = kk[xx];
      const base = rowIn + xmin * channels;
      for (let c = 0; c < channels; c++) {
        let sum = half;
        for (let x = 0; x < taps; x++) {
          sum += k[x] * data[base + x * channels + c];
        }
        // Arithmetic shift then clamp; Uint8ClampedArray clamps integers
        // to [0, 255] exactly like Pillow's clip8.
        out[rowOut + xx * channels + c] = sum >> PRECISION_BITS;
      }
    }
  }

  return out;
}

/**
 * Vertical pass: inH -> outH at width cols, 8-bit quantized output.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} inH
 * @param {number} channels
 * @param {number} outH
 * @returns {Uint8ClampedArray}
 */
function resampleVertical(data, width, inH, channels, outH) {
  const { bounds, kk } = precomputeCoeffs(inH, outH);
  const out = new Uint8ClampedArray(width * outH * channels);
  const half = 1 << (PRECISION_BITS - 1);
  const rowStride = width * channels;

  for (let yy = 0; yy < outH; yy++) {
    const ymin = bounds[yy * 2];
    const taps = bounds[yy * 2 + 1];
    const k = kk[yy];
    const rowOut = yy * rowStride;
    const base = ymin * rowStride;
    for (let i = 0; i < rowStride; i++) {
      let sum = half;
      for (let y = 0; y < taps; y++) {
        sum += k[y] * data[base + y * rowStride + i];
      }
      out[rowOut + i] = sum >> PRECISION_BITS;
    }
  }

  return out;
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

/**
 * Pillow-exact bicubic resize of packed interleaved 8-bit pixels.
 * Each channel is resized independently (alpha included when channels=4).
 * @param {Uint8Array|Uint8ClampedArray|ArrayLike<number>} data packed
 *   row-major pixels, length width*height*channels
 * @param {number} width
 * @param {number} height
 * @param {number} channels 1..4
 * @param {number} outW
 * @param {number} outH
 * @returns {Uint8ClampedArray} packed row-major, length outW*outH*channels
 */
export function pillowResize(data, width, height, channels, outW, outH) {
  assertPositiveInt(width, 'width');
  assertPositiveInt(height, 'height');
  assertPositiveInt(outW, 'outW');
  assertPositiveInt(outH, 'outH');
  if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
    throw new Error(`Invalid channels: ${channels}`);
  }
  if (data.length < width * height * channels) {
    throw new Error(
      `Data length ${data.length} is smaller than ${width}x${height}x${channels}`
    );
  }

  if (outW === width && outH === height) {
    // Bicubic taps at scale 1 are [0, 1, 0, 0], so the two passes are the
    // identity; short-circuit for speed.
    const copy = new Uint8ClampedArray(width * height * channels);
    for (let i = 0; i < copy.length; i++) {
      copy[i] = data[i];
    }
    return copy;
  }

  const horizontal = resampleHorizontal(data, width, height, channels, outW);
  return resampleVertical(horizontal, outW, height, channels, outH);
}
