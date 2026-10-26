importScripts('color-match.js','color-tools-core.js');
self.onmessage=event=>{try{const {operation,target,reference,method,amount}=event.data,result=operation==='grayscale'?V7ColorCore.grayscale(target):V7ColorCore.match(target,reference,method,amount);self.postMessage({ok:true,result},[result.data.buffer]);}catch(error){self.postMessage({ok:false,error:String(error.message||error)});}};
