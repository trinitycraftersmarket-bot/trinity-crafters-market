import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCategoryFit,categoryReviewMessage} from '../public/category-conflicts.js';

const categories=[
  {name:'Art (Wall Decor)'},{name:'Bags'},{name:'Candles'},{name:'Soap'},
  {name:'Cookies, Cinnamon Rolls etc.'},{name:'Embroidery'},{name:'Sewed Goods'}
];

test('Candles and Soap submitted as Bags is detected dynamically',()=>{
  const r=analyzeCategoryFit('Candles and Soap','Bags',categories);
  assert.equal(r.needsReview,true);
  assert.equal(r.likelyMismatch,true);
  assert.ok(r.matched.includes('Candles'));
  assert.ok(r.matched.includes('Soap'));
});

test('cookies submitted as an unrelated category is detected from the live category name',()=>{
  const r=analyzeCategoryFit('Decorated sugar cookies','Bags',categories);
  assert.equal(r.needsReview,true);
  assert.ok(r.matched.includes('Cookies, Cinnamon Rolls etc.'));
});

test('matching category does not create a mismatch',()=>{
  const r=analyzeCategoryFit('Handmade tote bags','Bags',categories);
  assert.equal(r.likelyMismatch,false);
  assert.equal(r.unverifiedSelection,false);
});

test('unknown description is still sent for organizer review',()=>{
  const msg=categoryReviewMessage('Handmade woven floor coverings','Bags',categories);
  assert.match(msg,/organizer review/i);
});
