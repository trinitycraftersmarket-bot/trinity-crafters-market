import {existsSync} from 'node:fs';
for(const f of ['public/index.html','public/app.js','public/style.css','netlify/functions/api.mjs','database/setup.sql']) if(!existsSync(f)) throw Error(`Missing ${f}`);
console.log('Netlify website and server functions ready.');
