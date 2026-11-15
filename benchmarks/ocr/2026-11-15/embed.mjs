import fs from 'node:fs/promises';
import JSZip from '../../../skills/doktimoi/node_modules/jszip/lib/index.js';
import {loadImage,createCanvas} from '../../../skills/doktimoi/node_modules/@napi-rs/canvas/index.js';
const dir=process.argv[2];
if(!dir)throw Error('Usage: node embed.mjs FIXTURE_DIRECTORY');
const png=await fs.readFile(`${dir}/normal.png`);
for(const [ext,input]of [['docx','examples/formats/image-policy.docx'],['pptx','examples/extended/image-policy.pptx'],['xlsx','examples/extended/image-policy.xlsx']]){
 const zip=await JSZip.loadAsync(await fs.readFile(new URL(`../../../${input}`,import.meta.url)));
 const media=Object.keys(zip.files).filter(n=>/\/media\/.*\.png$/.test(n));
 if(!media.length)throw Error(`No PNG media in ${ext}`);
 for(const name of media)zip.file(name,png);
 await fs.writeFile(`${dir}/ui.${ext}`,await zip.generateAsync({type:'nodebuffer'}),{flag:'wx'});
}
const image=await loadImage(png),canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);const jpg=canvas.toBuffer('image/jpeg');
const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 504] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1000 /Height 700 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),jpg,Buffer.from('\nendstream')])];
const content='q 720 0 0 504 0 0 cm /Im0 Do Q';objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
let pdf=Buffer.from('%PDF-1.4\n'),offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf=Buffer.concat([pdf,Buffer.from(`${i+1} 0 obj\n`),objects[i],Buffer.from('\nendobj\n')]);}
const start=pdf.length;pdf=Buffer.concat([pdf,Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`)]);await fs.writeFile(`${dir}/ui.pdf`,pdf,{flag:'wx'});
