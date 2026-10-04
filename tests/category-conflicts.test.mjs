import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCategoryFit, categoryReviewMessage} from '../public/category-conflicts.js';

test('embroidery submitted as Sewed Goods is reviewed but not blocked',()=>{
  const r=analyzeCategoryFit('Embroidered towels, blankets and bowl cozies','Sewed Goods');
  assert.equal(r.needsReview,true);
  assert.equal(r.likelyMismatch,true);
  assert.ok(r.matched.includes('Embroidery'));
  assert.match(categoryReviewMessage('Embroidered towels','Sewed Goods'),/still be submitted as usual/i);
});

test('embroidery category can still flag clothing overlap',()=>{
  const r=analyzeCategoryFit('Embroidered apparel and t-shirts','Embroidery');
  assert.equal(r.likelyMismatch,false);
  assert.ok(r.overlaps.includes('Clothing'));
});

test('matching simple category is not flagged',()=>{
  const r=analyzeCategoryFit('Custom decorated sugar cookies','Cookies, Cinnamon Rolls etc.');
  assert.equal(r.likelyMismatch,false);
  assert.equal(r.overlaps.length,0);
  assert.equal(r.needsReview,false);
});

test('Other is reviewed when a recognizable category exists',()=>{
  const r=analyzeCategoryFit('Crocheted beach bags and knitted hats','Other (Do not use for a sold-out category)');
  assert.equal(r.needsReview,true);
  assert.ok(r.matched.includes('Crochet & Knit Goods (Not Plush Toys)'));
});


test('Candles and Soap submitted as Art is flagged for organizer review',()=>{
  const r=analyzeCategoryFit('Candles and Soap','Art (Wall Decor)');
  assert.equal(r.needsReview,true);
  assert.equal(r.likelyMismatch,true);
  assert.ok(r.matched.includes('Candles'));
  assert.ok(r.matched.includes('Soap'));
  assert.match(categoryReviewMessage('Candles and Soap','Art (Wall Decor)'),/still be submitted as usual/i);
});
