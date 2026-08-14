/**
 * Calibration diagnostics for labeled public fixtures. These metrics describe
 * the raw reported p(AI); they never alter or remap production scores.
 *
 * @param {Array<{label?: string, error?: unknown}>} records
 * @param {(record: object) => number} scoreFn
 * @param {number} [binCount]
 */
export function calibrationMetrics(records, scoreFn, binCount = 10) {
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError('binCount must be a positive integer');
  }
  const bins = Array.from({ length: binCount }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  let brierSum = 0;
  let n = 0;

  for (const record of records || []) {
    if (record.error || (record.label !== 'ai' && record.label !== 'real')) continue;
    const score = Number(scoreFn(record));
    if (!Number.isFinite(score)) continue;
    const p = Math.max(0, Math.min(1, score));
    const y = record.label === 'ai' ? 1 : 0;
    const index = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = bins[index];
    bin.n += 1;
    bin.sumP += p;
    bin.sumY += y;
    brierSum += (p - y) ** 2;
    n += 1;
  }

  if (!n) return { n: 0, brier: null, ece: null, bins: [] };

  let ece = 0;
  const populatedBins = [];
  for (let index = 0; index < bins.length; index++) {
    const bin = bins[index];
    if (!bin.n) continue;
    const meanConfidence = bin.sumP / bin.n;
    const aiRate = bin.sumY / bin.n;
    ece += (bin.n / n) * Math.abs(meanConfidence - aiRate);
    populatedBins.push({
      low: index / binCount,
      high: (index + 1) / binCount,
      n: bin.n,
      meanConfidence,
      aiRate,
    });
  }

  return { n, brier: brierSum / n, ece, bins: populatedBins };
}
