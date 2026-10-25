import path from 'node:path';
import {DATA_DIR} from './paths.mjs';
import {atomicJson,readJson} from './store.mjs';
const file=path.join(DATA_DIR,'shared-settings.json');
const stringKeys=['provider','model','aspect','resolution','thinking','returnAs','groupColor','cc'];
const numbers={padding:[0,100],count:[1,8],shrink:[0,100],blur:[0,100],checkpointMin:[0,1440]};
const checks=['keepComposition','fallback','align','sound','tex','autoReturn','maskWithSelection'];
export function sharedSettings(method,body={}){
 const old=readJson(file,{schemaVersion:1,revision:0,values:{},history:[]});
 if(method==='GET')return old;
 if(method!=='POST')throw new Error('请求方式无效');
 if(body.revision!==old.revision)throw new Error('另一端已修改设置，已保留较新配置，请刷新后重试');
 let patch=body.values;
 if(body.restore!=null){const v=old.history.find(h=>h.revision===body.restore);if(!v)throw new Error('历史设置不存在');patch=v.values;}
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('设置格式无效');
 const values={...old.values};
 for(const[k,v]of Object.entries(patch)){
  if(stringKeys.includes(k)){if(typeof v!=='string'||v.length>200)throw new Error(`设置 ${k} 无效`);values[k]=v;}
  else if(k in numbers){const n=Number(v),[min,max]=numbers[k];if(!Number.isFinite(n)||n<min||n>max)throw new Error(`设置 ${k} 超出范围`);values[k]=String(n);}
  else if(checks.includes(k)){if(typeof v!=='boolean')throw new Error(`设置 ${k} 类型无效`);values[k]=v;}
  else throw new Error(`不支持的共享设置 ${k}`);
 }
 const next={schemaVersion:1,revision:old.revision+1,values,updatedAt:Date.now(),history:[...old.history,{revision:old.revision,values:old.values}].slice(-30)};atomicJson(file,next);return next;
}
