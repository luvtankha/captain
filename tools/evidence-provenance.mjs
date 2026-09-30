import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function sourceFingerprint() {
  const hash=createHash('sha256');
  async function visit(path) {
    const entries=await readdir(path,{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if(entry.isSymbolicLink())throw Error('Symlink not allowed in evidence source');
      const full=join(path,entry.name);
      if(entry.isDirectory()) {
        if(!['vendor','experiments','node_modules'].includes(entry.name))await visit(full);
      } else if(/\.(?:[cm]?js|ts|html|json|css)$/.test(entry.name)) {
        hash.update(relative(root,full).replaceAll('\\','/')+'\0');hash.update(await readFile(full));hash.update('\0');
      }
    }
  }
  for(const dir of ['extension','server','libraries','tools','tests','benchmarks','dashboard'])await visit(join(root,dir));
  for(const file of ['package.json','package-lock.json']){hash.update(file+'\0');hash.update(await readFile(join(root,file)));}
  return hash.digest('hex');
}
export function testCategory(file) {
  if(/(?:privacy|egress|security|consent|pii|entities|outbound|truesight)/i.test(file))return 'privacy-security';
  if(/(?:ocr|geometry|vision|visual|ground|model|ultraface|phase-0[4568])/i.test(file))return 'perception-evaluation';
  if(/(?:action|lease|binding|stale|verification|verifier|handoff)/i.test(file))return 'action-validation';
  if(/(?:planner|navigation|shopping|playback|youtube|spotify|site|search)/i.test(file))return 'planning-outcomes';
  if(/(?:browser|controller|panel|runtime|launcher|release|package|phase-09)/i.test(file))return 'runtime-ui-packaging';
  return 'other-regression';
}
