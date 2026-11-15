import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '../../../skills/doktimoi/node_modules/@napi-rs/canvas/index.js';
const dir=process.argv[2];
if(!dir)throw Error('Usage: node generate-fixtures.mjs NEW_OUTPUT_DIRECTORY');
await fs.mkdir(dir);
const lines=[['Invoice / Lasku',30,'#19283a'],['Asiakas / Customer: Koivu Oy',20,'#233347'],['Tila / Status: Vain luku',20,'#233347'],['Eräpäivä / Due date: 15.11.2026',20,'#233347'],['Älä poista laskua. Do not send.',20,'#233347'],['Tuote / Item          Määrä / Qty       Hinta / Price',18,'#4b5563'],['A-001 Palvelu         12                8 400,50 EUR',18,'#4b5563'],['B-002 Hyvitys         3                 -20,00 EUR',18,'#4b5563'],['C-003 Storage         7                 10.00 EUR',18,'#4b5563'],['Yhteensä / Total: 8 390,50 EUR',21,'#233347'],['Vain hyväksyjä saa lähettää. Älä muuta summaa.',15,'#737373']];
const truth={critical:['Koivu Oy','Vain luku','15.11.2026','Älä poista laskua','Do not send','8 400,50','-20,00','10.00','8 390,50','Älä muuta summaa'],rows:[['A-001','12','8 400,50'],['B-002','3','-20,00'],['C-003','7','10.00']]};
assert.ok(truth.critical.every(value=>lines.some(([line])=>line.includes(value))));
assert.ok(truth.rows.every(values=>lines.some(([line])=>values.every(value=>line.includes(value)))));
const base=createCanvas(1000,700),ctx=base.getContext('2d');ctx.fillStyle='#eef2f6';ctx.fillRect(0,0,1000,700);ctx.fillStyle='white';ctx.fillRect(25,25,950,650);
let y=72; for(const [line,size,color] of lines){ctx.font=`${size}px Arial`;ctx.fillStyle=color;ctx.fillText(line,55,y);y+=size===30?60:45;}
for(const [x,label,checked] of [[55,'Hyväksytty',true],[280,'Lähetä heti',false]]){ctx.strokeStyle='#475569';ctx.strokeRect(x,610,18,18);if(checked){ctx.beginPath();ctx.moveTo(x+3,618);ctx.lineTo(x+7,624);ctx.lineTo(x+15,613);ctx.lineWidth=2;ctx.stroke();}ctx.font='17px Arial';ctx.fillText(label,x+29,625);}
await fs.writeFile(`${dir}/truth.json`,JSON.stringify({...truth,checkboxes:{Hyväksytty:true,'Lähetä heti':false},text:lines.map(x=>x[0]).join('\n')},null,2));
const variants={normal:base,small:createCanvas(650,455),skew:createCanvas(1040,760),rotated:createCanvas(700,1000)};
variants.small.getContext('2d').drawImage(base,0,0,650,455);
let c=variants.skew.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1040,760);c.translate(30,15);c.rotate(3*Math.PI/180);c.drawImage(base,0,0);
c=variants.rotated.getContext('2d');c.translate(700,0);c.rotate(Math.PI/2);c.drawImage(base,0,0);
for(const [name,canvas]of Object.entries(variants))await fs.writeFile(`${dir}/${name}.png`,canvas.toBuffer('image/png'));
console.log(`Created fixtures in ${dir}`);
