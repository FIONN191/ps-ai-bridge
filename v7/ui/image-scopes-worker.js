importScripts('image-scopes.js');
self.onmessage=event=>{try{const {width,height,pixels}=event.data,result=V7ImageScopes.analyze(width,height,pixels);self.postMessage({ok:true,result},[result.luma.buffer,result.rgb.buffer,result.vectors.buffer,...result.histogram.map(values=>values.buffer)]);}catch(error){self.postMessage({ok:false,error:String(error.message||error)});}};
