const clean = value => String(value || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9&/' -]+/g, ' ').replace(/\s+/g, ' ').trim();

export const CATEGORY_SCAN_RULES = [
  {name:'Candles', terms:['candle','candles','wax melt','wax melts']},
  {name:'Soap', terms:['soap','soaps','bar soap','soap bar','soap bars']},
  {name:'Aromatherapy', terms:['essential oil','essential oils','aromatherapy','diffuser','diffusers']},
  {name:'Body Scrubs', terms:['body scrub','body scrubs','sugar scrub','sugar scrubs','salt scrub','salt scrubs']},
  {name:'3D Printed Art', terms:['3d print','3d printed','3-d print','3-d printed']},
  {name:'Hair Care', terms:['hair care','hair oil','hair oils','shampoo','conditioner']},
  {name:'Crystals (No Jewelry)', terms:['healing crystal','healing crystals','crystal tower','crystal towers','tumbled crystal','tumbled crystals']},
  {name:'Sewed Goods', terms:['sewn','sewed','sewing','bowl cozy','bowl cozies','potato bag','potato bags','fabric goods']},
  {name:'Scrap Books and Cards', terms:['scrapbook','scrapbooks','scrap book','scrap books','greeting card','greeting cards','handmade card','handmade cards']},
  {name:'Lanterns', terms:['lantern','lanterns']},
  {name:'Perfume', terms:['perfume','perfumes','cologne','colognes']},
  {name:'Wind Spinners', terms:['wind spinner','wind spinners']},
  {name:'Wood Work Practical', terms:['cutting board','cutting boards','charcuterie board','charcuterie boards','wooden tray','wooden trays']},
  {name:'Wood Work Artist', terms:['wood art','wooden sign','wooden signs','wood sign','wood signs']},
  {name:'Embroidery', terms:['embroidery','embroidered','embroidering']},
  {name:'Crochet Plush Toys', terms:['crochet plush','crocheted plush','amigurumi']},
  {name:'Crochet & Knit Goods (Not Plush Toys)', terms:['knitted','knit hat','knit scarf','knit beanie','crochet bag','crocheted bag','crochet hat','crocheted hat','crochet scarf','crocheted scarf','crochet top','crocheted top','crochet coverup','crocheted coverup','dishcloth','scrubbie','ear warmer','hooded cowl']},
  {name:'Stickers & Decals', terms:['sticker','stickers','decal','decals']},
  {name:'Personalized / Sublimation Goods', terms:['sublimation','sublimated','heat press','heat-pressed','personalized printed','custom printed']},
  {name:'Handmade Jewelry (No Paparazzi)', terms:['jewelry','jewellery','earring','earrings','necklace','necklaces','bracelet','bracelets','pendant','pendants']},
  {name:'Permanent Jewelry', terms:['permanent jewelry','welded bracelet','welded jewelry']},
  {name:'Accessories (No Jewelry)', terms:['keychain','keychains','eyeglass charm','eyeglass charms','hair clip','hair clips','scrunchie','scrunchies']},
  {name:'Bags', terms:['tote bag','tote bags','purse','purses','market bag','market bags','beach bag','beach bags']},
  {name:'Clothing', terms:['t-shirt','t-shirts','tshirt','tshirts','shirt','shirts','apparel','hoodie','hoodies','dress','dresses']},
  {name:'Hats', terms:['baseball cap','caps','sun hat','sun hats','beanie','beanies','winter hat','winter hats']},
  {name:'Tumblers', terms:['tumbler','tumblers']},
  {name:'Mugs and Glassware (No Tumblers)', terms:['mug','mugs','glassware','wine glass','wine glasses']},
  {name:'Resin Art (No Jewelry)', terms:['resin art','resin decor','resin tray','resin trays']},
  {name:'Pottery and Ceramics', terms:['pottery','ceramic','ceramics']},
  {name:'Quilts', terms:['quilt','quilts','quilting']},
  {name:'Stained Glass', terms:['stained glass']},
  {name:'Art (Wall Decor)', terms:['wall decor','wall art','wall hanging','wall hangings']},
  {name:'Art (Home Decor)', terms:['home decor','shelf sitter','shelf sitters','birdbath','birdbaths']},
  {name:'Bread Baked Goods', terms:['sourdough','bread loaf','bread loaves','artisan bread']},
  {name:'Cookies, Cinnamon Rolls etc.', terms:['cookie','cookies','cinnamon roll','cinnamon rolls','brownie','brownies','muffin','muffins','mini cake','mini cakes','coffee cake']},
  {name:'Candy', terms:['candy','fudge','chocolate bark']},
  {name:'Jams and Salsa', terms:['jam','jams','jelly','jellies','salsa']},
  {name:'Pet Treats', terms:['dog treat','dog treats','pet treat','pet treats']},
  {name:'Pet Supplies', terms:['dog collar','dog collars','pet collar','pet collars','leash','leashes']}
];

export function analyzeCategoryFit(description, selectedCategory=''){
  const text=clean(description);
  const selected=clean(selectedCategory);
  if(!text) return {matched:[],overlaps:[],likelyMismatch:false,needsReview:false};
  const matched=CATEGORY_SCAN_RULES.filter(rule=>rule.terms.some(term=>text.includes(clean(term)))).map(rule=>rule.name);
  const unique=[...new Set(matched)];
  const selectedMatched=unique.some(name=>clean(name)===selected);
  const overlaps=unique.filter(name=>clean(name)!==selected);
  const selectedIsOther=selected.startsWith('other ');
  const likelyMismatch=!!selected && unique.length>0 && (!selectedMatched || selectedIsOther);
  return {matched:unique,overlaps,likelyMismatch,needsReview:likelyMismatch||overlaps.length>0};
}

export function categoryReviewMessage(description, selectedCategory=''){
  const review=analyzeCategoryFit(description, selectedCategory);
  if(!review.needsReview) return '';
  const choices=(review.likelyMismatch?review.matched:review.overlaps).filter(Boolean);
  const possible=choices.length?choices.join(', '):'another category';
  return review.likelyMismatch
    ? `Some of the products you listed may fit ${possible} better than the category you selected. Your application will still be submitted as usual for organizer review.`
    : `Some of the products you listed may also overlap with ${possible}. Your application will still be submitted as usual for organizer review.`;
}
