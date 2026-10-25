import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {makeVariant} from '../lib/post.mjs';
test('colour-corrected cutouts retain every alpha sample, including soft edges',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psai-alpha-'));
 try{
  const pixels=Buffer.alloc(16*16*4);for(let i=0;i<256;i++){pixels[i*4]=100;pixels[i*4+1]=140;pixels[i*4+2]=180;pixels[i*4+3]=i;}
  const base=path.join(dir,'base.png'),input=path.join(dir,'input.png'),out=path.join(dir,'out.png');
  await sharp(pixels,{raw:{width:16,height:16,channels:4}}).png().toFile(base);
  await sharp({create:{width:16,height:16,channels:3,background:{r:130,g:150,b:170}}}).png().toFile(input);
  await makeVariant({inputPath:input,basePath:base,cc:'global',tex:false,t:1,outPath:out});
  const alpha=await sharp(out).extractChannel('alpha').raw().toBuffer();assert.deepEqual([...alpha],Array.from({length:256},(_,i)=>i));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
