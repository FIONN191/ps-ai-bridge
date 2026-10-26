(function(root){
  'use strict';
  function create(container,onChange,onError){
    const T=root.THREE;if(!T)throw new Error('3D 资源未加载');
    const renderer=new T.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#202629');container.appendChild(renderer.domElement);
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(42,1,.01,100),stage=new T.Group(),guides=new T.Group();scene.add(stage,guides);
    const ambient=new T.HemisphereLight('#ffffff','#55605d',2);scene.add(ambient);
    const grid=new T.GridHelper(12,24,'#516d68','#394447');grid.position.y=-1.5;scene.add(grid);
    const material=new T.MeshStandardMaterial({color:'#bfc9c3',roughness:.65});
    const mannequin=new T.Group();const body=new T.Mesh(new T.CapsuleGeometry(.4,1,6,16),material);body.position.y=-.25;mannequin.add(body);const head=new T.Mesh(new T.SphereGeometry(.3,24,16),material);head.position.y=.88;mannequin.add(head);stage.add(mannequin);
    const plane=new T.Mesh(new T.PlaneGeometry(2,2),new T.MeshBasicMaterial({color:0xffffff,side:T.DoubleSide}));plane.visible=false;stage.add(plane);
    const textures=new Map(),loader=new T.TextureLoader();let state=null,selected='',imageAspect=1,disposed=false,sourceTexture,drag=null;
    function clearGuides(){while(guides.children.length){const object=guides.children[0];guides.remove(object);object.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});}}
    function direction(az,el,distance){const a=az*Math.PI/180,e=el*Math.PI/180;return new T.Vector3(Math.sin(a)*Math.cos(e)*distance,Math.sin(e)*distance,Math.cos(a)*Math.cos(e)*distance);}
    function line(a,b,color){const item=new T.Line(new T.BufferGeometry().setFromPoints([a,b]),new T.LineBasicMaterial({color}));guides.add(item);}
    function draw(){if(!disposed)renderer.render(scene,camera);}
    function resize(){const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();draw();}
    function texture(index){if(textures.has(index))return textures.get(index);const t=loader.load('assets/light-handdrawn/light_'+String(index+1).padStart(2,'0')+'.png',draw,undefined,error=>onError(new Error('灯光附件图片加载失败：'+String(error.message||index))));t.colorSpace=T.SRGBColorSpace;textures.set(index,t);return t;}
    function update(value,id){if(disposed)return;state=value;selected=id;clearGuides();const flat=value.mode==='light2d'||value.mode==='split';const zoom=value.mode==='camera'?value.camera.zoom:1;
      camera.position.set(flat?0:5,flat?0:3.4,flat?5:7);camera.lookAt(0,0,0);camera.zoom=zoom;camera.updateProjectionMatrix();grid.visible=!flat;mannequin.visible=!plane.visible;plane.position.z=0;
      if(value.mode==='camera'){const point=direction(value.camera.az,value.camera.el,2.5*value.camera.distance);const marker=new T.Mesh(new T.BoxGeometry(.35,.25,.5),new T.MeshBasicMaterial({color:'#74d8b1'}));marker.position.copy(point);marker.lookAt(0,0,0);guides.add(marker);line(point,new T.Vector3(),'#74d8b1');}
      if(value.mode==='light2d'||value.mode==='light3d')for(const item of value.lights.filter(l=>l.enabled)){
        const tint=root.V7CameraLightCore.color(item),position=flat?new T.Vector3((item.x-.5)*2*imageAspect,(.5-item.y)*2,.08):direction(item.az,item.el,item.distance);
        const marker=flat?new T.Mesh(new T.PlaneGeometry(item.scale*2,item.scale*2),new T.MeshBasicMaterial({map:texture(item.attachment),color:tint,transparent:true,depthTest:false,side:T.DoubleSide})):new T.Mesh(new T.BoxGeometry(.2,.16,.1),new T.MeshBasicMaterial({color:tint}));
        marker.position.copy(position);marker.userData.lightId=item.id;if(flat)marker.rotation.z=-item.rotation*Math.PI/180;else marker.lookAt(0,0,0);guides.add(marker);
        if(item.id===selected){const helper=new T.BoxHelper(marker,'#74d8b1');guides.add(helper);}
        if(!flat){line(position,new T.Vector3(),tint);let lamp;if(item.type==='directional')lamp=new T.DirectionalLight(tint,item.intensity*2);else if(item.type==='spot'){lamp=new T.SpotLight(tint,item.intensity*15,20,Math.PI/5,.5,1);lamp.target.position.set(0,0,0);guides.add(lamp.target);}else lamp=new T.PointLight(tint,item.intensity*8,20,1);lamp.position.copy(position);guides.add(lamp);}
      }draw();
    }
    async function setImage(blob){const bitmap=await createImageBitmap(blob);if(disposed){bitmap.close();return;}const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);imageAspect=bitmap.width/bitmap.height;bitmap.close();sourceTexture?.dispose();sourceTexture=new T.CanvasTexture(canvas);sourceTexture.colorSpace=T.SRGBColorSpace;plane.material.map=sourceTexture;plane.material.needsUpdate=true;plane.scale.set(imageAspect,1,1);plane.visible=true;if(state)update(state,selected);}
    function point(event){const box=renderer.domElement.getBoundingClientRect();return new T.Vector2((event.clientX-box.left)/box.width*2-1,1-(event.clientY-box.top)/box.height*2);}
    renderer.domElement.addEventListener('pointerdown',event=>{if(!state)return;const ray=new T.Raycaster();ray.setFromCamera(point(event),camera);const hit=ray.intersectObjects(guides.children).find(h=>h.object.userData.lightId);if(hit)selected=hit.object.userData.lightId;drag={x:event.clientX,y:event.clientY,az:state.mode==='camera'?state.camera.az:state.lights.find(l=>l.id===selected)?.az||0,el:state.mode==='camera'?state.camera.el:state.lights.find(l=>l.id===selected)?.el||0};renderer.domElement.setPointerCapture(event.pointerId);});
    renderer.domElement.addEventListener('pointermove',event=>{if(!drag||!state)return;const c=root.V7CameraLightCore.config(state),item=c.lights.find(l=>l.id===selected);if(c.mode==='camera'){c.camera.az=Math.max(0,Math.min(315,drag.az+(event.clientX-drag.x)*.5));c.camera.el=Math.max(-90,Math.min(90,drag.el-(event.clientY-drag.y)*.5));}else if(item&&c.mode==='light3d'){item.az=(drag.az+(event.clientX-drag.x)*.5+720)%360;item.el=Math.max(-90,Math.min(90,drag.el-(event.clientY-drag.y)*.5));}else if(item&&c.mode==='light2d'){const ray=new T.Raycaster();ray.setFromCamera(point(event),camera);const hit=new T.Vector3();if(ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,0,1),0),hit)){item.x=Math.min(1,Math.max(0,hit.x/(2*imageAspect)+.5));item.y=Math.min(1,Math.max(0,.5-hit.y/2));}}else return;onChange(c,selected);});
    const end=()=>{drag=null;};renderer.domElement.addEventListener('pointerup',end);renderer.domElement.addEventListener('pointercancel',end);
    const observer=new ResizeObserver(resize);observer.observe(container);resize();
    return {update,setImage,resize,canvas:renderer.domElement,async blob(){draw();return new Promise((resolve,reject)=>renderer.domElement.toBlob(value=>value?resolve(value):reject(new Error('灯光布局图片未生成')),'image/png'));},dispose(){disposed=true;observer.disconnect();clearGuides();sourceTexture?.dispose();for(const t of textures.values())t.dispose();stage.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});grid.geometry.dispose();grid.material.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();}};
  }
  root.V7CameraLightScene={create};
})(window);
