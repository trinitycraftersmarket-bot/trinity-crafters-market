const clean=value=>String(value||'').toLowerCase().replace(/[’']/g,"'").replace(/[^a-z0-9&/' -]+/g,' ').replace(/\s+/g,' ').trim();
const generic=new Set(['art','goods','good','product','products','item','items','business','service','services','handmade','artist','practical','other','category','non','profit','mlm','no','not','the','and','or','etc','do','use','for','a','an','sold','out']);

function variants(word){
  const w=clean(word),out=[w];
  if(/ies$/.test(w))out.push(w.replace(/ies$/,'y'));
  else if(/s$/.test(w)&&!/(ss|us)$/.test(w))out.push(w.slice(0,-1));
  return [...new Set(out.filter(Boolean))];
}

function categoryTerms(name){
  const raw=String(name||'').replace(/\([^)]*\)/g,' ');
  const words=clean(raw).split(' ').filter(w=>w.length>2&&!generic.has(w));
  const terms=[];
  if(words.length)terms.push(words.join(' '));
  for(const w of words)terms.push(...variants(w));
  return [...new Set(terms.filter(t=>t.length>2))];
}

function containsTerm(text,term){
  const hay=' '+clean(text)+' ',needle=' '+clean(term)+' ';
  return hay.includes(needle);
}

export function analyzeCategoryFit(description,selectedCategory='',categories=[]){
  const text=clean(description),selected=clean(selectedCategory);
  if(!text)return {matched:[],overlaps:[],likelyMismatch:false,unverifiedSelection:false,needsReview:false};
  const names=(categories||[]).map(c=>typeof c==='string'?c:c?.name).filter(Boolean);
  const matched=names.filter(name=>categoryTerms(name).some(term=>containsTerm(text,term)));
  const unique=[...new Set(matched)];
  const selectedMatched=unique.some(name=>clean(name)===selected);
  const overlaps=unique.filter(name=>clean(name)!==selected);
  const selectedIsOther=selected.startsWith('other ');
  const unverifiedSelection=!!selected&&!selectedMatched;
  const likelyMismatch=!!selected&&unique.length>0&&(!selectedMatched||selectedIsOther);
  return {matched:unique,overlaps,likelyMismatch,unverifiedSelection,needsReview:unverifiedSelection||selectedIsOther||overlaps.length>0};
}

export function categoryReviewMessage(description,selectedCategory='',categories=[]){
  const review=analyzeCategoryFit(description,selectedCategory,categories);
  if(!review.needsReview)return '';
  if(review.unverifiedSelection&&!review.matched.length)return 'We could not automatically confirm that the products you described match the category you selected. Your application will still be submitted as usual for organizer review.';
  const choices=(review.likelyMismatch?review.matched:review.overlaps).filter(Boolean);
  const possible=choices.length?choices.join(', '):'another category';
  return review.likelyMismatch
    ? `Some of the products you listed may fit ${possible} better than the category you selected. Your application will still be submitted as usual for organizer review.`
    : `Some of the products you listed may also overlap with ${possible}. Your application will still be submitted as usual for organizer review.`;
}
