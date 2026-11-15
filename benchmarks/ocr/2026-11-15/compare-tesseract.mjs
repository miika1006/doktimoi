import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import Tesseract from '../../../skills/doktimoi/node_modules/tesseract.js/src/index.js';
const dir=process.argv[2];
if(!dir)throw Error('Usage: node compare-tesseract.mjs FIXTURE_DIRECTORY');
try{await fs.access(`${dir}/tesseract-comparison.json`);throw Error('Refusing existing results');}catch(error){if(error.code!=='ENOENT')throw error;}
const truth=JSON.parse(await fs.readFile(`${dir}/truth.json`));
const start=performance.now(),w=await Tesseract.createWorker('eng+fin',1,{cachePath:process.env.DOKTIMOI_OCR_CACHE ?? `${process.env.HOME ?? process.env.USERPROFILE}/.cache/doktimoi/ocr`,cacheMethod:'readOnly',logger:()=>{}}),setupMs=performance.now()-start;
const all=[],normalize=s=>s.replace(/\s+/g,' ').trim();
try{for(const mode of [{name:'baseline',options:{}},{name:'auto-deskew',psm:'3',options:{rotateAuto:true}}]){if(mode.psm)await w.setParameters({tessedit_pageseg_mode:mode.psm});for(const fixture of ['normal','small','skew','rotated'])for(let run=0;run<3;run++){const start=performance.now();const {data}=await w.recognize(`${dir}/${fixture}.png`,mode.options,{text:true});const text=data.text,critical=truth.critical.map(value=>({value,pass:normalize(text).includes(normalize(value))}));const rows=truth.rows.map(values=>({values,pass:text.split('\n').some(line=>values.every(v=>normalize(line).includes(normalize(v))))}));const result={engine:'tesseract.js7',mode:mode.name,fixture,run,setupMs,ms:performance.now()-start,confidence:data.confidence,criticalPassed:critical.filter(x=>x.pass).length,rowsPassed:rows.filter(x=>x.pass).length,critical,rows,text};all.push(result);console.log(JSON.stringify(result));}}}finally{await w.terminate();}
await fs.writeFile(`${dir}/tesseract-comparison.json`,JSON.stringify(all,null,2),{flag:'wx'});
