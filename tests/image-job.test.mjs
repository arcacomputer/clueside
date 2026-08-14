import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAnalyzeJobCurrent } from '../src/image-job.js';

const baseState = {
  enabled: true,
  autoScan: true,
  connected: true,
  generation: 4,
  currentUrl: 'https://images.example/new.jpg',
  backgroundUrls: ['https://images.example/bg.jpg'],
};

describe('isAnalyzeJobCurrent', () => {
  it('rejects an old image URL after a lazy-loader replacement', () => {
    assert.equal(
      isAnalyzeJobCurrent(
        { source: 'img', url: 'https://images.example/old.jpg', generation: 4 },
        baseState
      ),
      false
    );
  });

  it('accepts the URL and scan generation still on screen', () => {
    assert.equal(
      isAnalyzeJobCurrent(
        { source: 'img', url: 'https://images.example/new.jpg', generation: 4 },
        baseState
      ),
      true
    );
  });

  it('invalidates queued work after a threshold or settings rescan', () => {
    assert.equal(
      isAnalyzeJobCurrent(
        { source: 'img', url: 'https://images.example/new.jpg', generation: 3 },
        baseState
      ),
      false
    );
  });

  it('rejects disconnected, disabled, and removed background images', () => {
    const backgroundJob = {
      source: 'background',
      url: 'https://images.example/bg.jpg',
      generation: 4,
    };
    assert.equal(isAnalyzeJobCurrent(backgroundJob, { ...baseState, connected: false }), false);
    assert.equal(isAnalyzeJobCurrent(backgroundJob, { ...baseState, enabled: false }), false);
    assert.equal(isAnalyzeJobCurrent(backgroundJob, { ...baseState, backgroundUrls: [] }), false);
  });
});
