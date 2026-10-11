// Event-specific multi-area floor plan management, separate from the legacy editor.
export function setupFloorAreaManager({host,eventSelect,events,locations,api,esc,notice}) {
  const state={eventId:'',areas:[],vendors:[],template:[],active:0,placing:null,dirty:false,request:0};
  const safe=s=>esc(String(s==null?'':s));
  const imageAllowed=url=>typeof url==='string'&&/^data:image\/(png|jpeg|webp);base64,/.test(url);
  const venueDefaults=event=>{
    const location=locations.find(x=>x.id===event?.location_id);
    const name=String((location?.name||'')+' '+(location?.market_name||'')+' '+(event?.title||'')).toLowerCase();
    if(/hilton garden inn|lutz crafter/.test(name))return [
      {area_key:'main',title:'Main Event Room',capacity:21,space_type:'indoor',prefix:'MR'},
      {area_key:'hallway1',title:'Hallway 1',capacity:5,space_type:'indoor',prefix:'H1'},
      {area_key:'hallway2',title:'Hallway 2',capacity:3,space_type:'indoor',prefix:'H2'},
      {area_key:'lobby',title:'Lobby',capacity:3,space_type:'indoor',prefix:'L'},
      {area_key:'outside',title:'Outside',capacity:2,space_type:'outdoor',prefix:'OUT'}
    ];
    if(/hampton inn|odessa trinity/.test(name))return [
      {area_key:'main',title:'Indoor Room',capacity:9,space_type:'indoor',prefix:'HI'}
    ];
    if(/trinity yoga|holistic experience/.test(name))return [
      {area_key:'studio',title:'Yoga Studio',capacity:8,space_type:'indoor',prefix:'YS'}
    ];
    return [
      {area_key:'inside',title:'Indoor Area',capacity:9,space_type:'indoor',prefix:'IN'},
      {area_key:'outside',title:'Outdoor Area',capacity:2,space_type:'outdoor',prefix:'OUT'}
    ];
  };
  const standardize=area=>({...area,assignments:area.assignments&&typeof area.assignments==='object'?area.assignments:{},image_data_url:area.image_data_url||''});
  const spot=(area,i)=>String(area.prefix||area.area_key.toUpperCase())+'-'+String(i+1).padStart(2,'0');
  const positions=(a,i)=>{
    const rows=Math.ceil(a.capacity/2),col=i<rows?0:1,row=col?i-rows:i;
    return {x:col?76:24,y:12+Math.max(0,row)*76/Math.max(1,rows-1)};
  };
  const choices=(selected,spotId)=>'<option value="">Unassigned</option>'+state.vendors.map(v=>{
    const id=String(v.id);
    const label=String(v.business||v.name||'Unnamed vendor')+' — '+String(v.space||'');
    return '<option value="'+safe(id)+'"'+(id===selected?' selected':'')+'>'+safe(label)+'</option>';
  }).join('');
  const current=()=>state.areas[state.active];
  const image=document.createElement('img');
  image.alt='Uploaded venue floor plan';
  image.style.cssText='display:block;width:100%;height:auto;max-height:850px;object-fit:contain';
  host.classList.add('floor-area-manager');
  host.innerHTML='<section class="card"><h2>Event floor plan areas</h2>'+
    '<p class="muted">Each event has its own saved plans. Upload a separate image for each room, assign vendors, and reuse venue layouts without copying vendor names.</p>'+
    '<p id="fam-status" class="muted"></p><div class="actions" style="display:flex;gap:10px;flex-wrap:wrap">'+
    '<label>Area<select id="fam-area"></select></label>'+
    '<button id="fam-reuse" class="secondary" type="button">Reuse prior venue layouts</button>'+
    '<button id="fam-save" type="button">Save all event areas</button>'+
    '</div><p id="fam-area-info" class="muted"></p><div id="fam-overflow" style="padding:10px;margin:10px 0;background:#fff8e8;border:1px solid #d6c59b;border-radius:8px"></div>'+
    '<div class="actions" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">'+
    '<label>Upload this area image (PNG, JPG or WebP)<input id="fam-upload" type="file" accept="image/png,image/jpeg,image/webp"></label>'+
    '<button id="fam-clear" type="button" class="secondary">Clear this image</button>'+
    '<button id="fam-download" type="button" class="secondary">Download this area</button>'+
    '</div><p id="fam-tip" class="muted">Choose a vendor for a numbered spot, then click Place and tap the matching spot on the floor plan to move its label.</p>'+
    '<div id="fam-map" style="position:relative;width:100%;max-width:680px;margin:12px auto;background:#f7f3e7;border:2px solid #235044;border-radius:10px;overflow:hidden;min-height:160px"></div>'+
    '<div id="fam-slots"></div></section>';
  const q=id=>host.querySelector('#'+id);
  const status=message=>{q('fam-status').textContent=message;};
  const markDirty=()=>{state.dirty=true;status('Unsaved edits — tap Save all event areas when ready.');};
  function renderMap(){
    const a=current(),map=q('fam-map');map.replaceChildren();
    if(!a)return;
    if(imageAllowed(a.image_data_url)){
      const img=image.cloneNode();img.src=a.image_data_url;img.onload=()=>{if(current()===a)renderPins();};
      map.appendChild(img);
    }else{
      const placeholder=document.createElement('div');
      placeholder.style.cssText='aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;padding:24px;color:#235044;text-align:center';
      placeholder.textContent='Upload the '+a.title+' floor plan image. '+a.capacity+' numbered vendor positions are ready.';
      map.appendChild(placeholder);
    }
    renderPins();
    map.onclick=e=>{
      if(!state.placing)return;
      const r=map.getBoundingClientRect();
      const x=100*(e.clientX-r.left)/r.width,y=100*(e.clientY-r.top)/r.height;
      if(e.target.closest('button'))return;
      const selected=state.placing;
      const before=a.assignments[selected]||{};
      a.assignments[selected]={...before,x:Math.max(3,Math.min(97,+x.toFixed(2))),y:Math.max(3,Math.min(97,+y.toFixed(2)))};
      state.placing=null;markDirty();render();
    };
  }
  function renderPins(){
    const a=current(),map=q('fam-map');if(!a)return;
    map.querySelectorAll('.fam-pin').forEach(x=>x.remove());
    for(let i=0;i<a.capacity;i++){
      const id=spot(a,i),item=a.assignments[id]||{},xy=positions(a,i);
      const v=state.vendors.find(x=>String(x.id)===String(item.vendor_id||''));
      const pin=document.createElement('button');pin.type='button';pin.className='fam-pin';
      pin.style.cssText='position:absolute;z-index:2;left:'+(item.x??xy.x)+'%;top:'+(item.y??xy.y)+'%;transform:translate(-50%,-50%);background:#115549;color:white;border:2px solid white;border-radius:18px;font-size:11px;line-height:1.2;padding:5px 7px;max-width:45%;box-shadow:0 1px 5px #555;cursor:pointer';
      pin.textContent=id+(v?' • '+String(v.business||v.name):'');
      pin.title='Click to choose placement for '+id;
      pin.onclick=e=>{e.stopPropagation();state.placing=id;status('Tap the floor plan where '+id+' belongs.');};
      map.appendChild(pin);
    }
  }
  function render(){
    const a=current();if(!a)return;
    const occupied=new Set(state.areas.flatMap(area=>Object.values(area.assignments||{}).map(x=>String(x.vendor_id||'')).filter(Boolean)));
    const overflow=state.vendors.filter(v=>!occupied.has(String(v.id)));
    const interior=overflow.filter(v=>!['outside','outdoor'].includes(String(v.space||'').toLowerCase()));
    const outside=overflow.filter(v=>['outside','outdoor'].includes(String(v.space||'').toLowerCase()));
    q('fam-area').innerHTML=state.areas.map((v,i)=>'<option value="'+i+'"'+(i===state.active?' selected':'')+'>'+safe(v.title)+' ('+v.capacity+')</option>').join('');
    q('fam-area-info').textContent=a.title+' • '+a.capacity+' spots • '+a.space_type+' • '+Object.values(a.assignments).filter(x=>x.vendor_id).length+' assigned';
    q('fam-overflow').innerHTML='<strong>'+state.vendors.length+' active vendors</strong> · '+occupied.size+' assigned · <strong>'+overflow.length+' not assigned a physical booth</strong>'+(overflow.length?'<p><strong>Unassigned / overflow:</strong> '+overflow.map(v=>safe(v.business||v.name||'Vendor')+' ('+safe(v.space||'')+')').join(' · ')+'</p><p class="muted">Keep these vendors on the event record, but do not promise booth numbers until a space is confirmed. Unassigned indoor: '+interior.length+'; outside: '+outside.length+'.</p>':'<p>Every active vendor has a booth assignment.</p>');
    q('fam-reuse').disabled=!state.template.length;
    q('fam-download').disabled=!imageAllowed(a.image_data_url);
    q('fam-slots').innerHTML='<h3>Assign vendor booths</h3><div class="floor-slot-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:8px">'+
      Array.from({length:a.capacity},(_,i)=>{
        const id=spot(a,i),assignment=a.assignments[id]||{};
        return '<div style="display:flex;gap:6px;align-items:end;padding:5px;background:#faf9f5;border:1px solid #d5dacd;border-radius:7px">'+
          '<label style="flex:1;font-size:12px"><strong>'+safe(id)+'</strong><select data-assign="'+safe(id)+'" style="max-width:100%">'+choices(assignment.vendor_id||'',id)+'</select></label>'+
          '<button type="button" data-place="'+safe(id)+'" class="secondary" style="font-size:12px">Place</button></div>';
      }).join('')+'</div>';
    q('fam-slots').querySelectorAll('[data-assign]').forEach(el=>el.onchange=()=>{
      const id=el.dataset.assign,newId=el.value;
      if(newId&&state.areas.some(x=>Object.entries(x.assignments).some(([key,v])=>!(x===a&&key===id)&&String(v.vendor_id||'')===newId))){
        notice('That vendor is already assigned to another space.');render();return;
      }
      a.assignments[id]={...(a.assignments[id]||{}),vendor_id:newId};markDirty();renderMap();
    });
    q('fam-slots').querySelectorAll('[data-place]').forEach(el=>el.onclick=()=>{
      state.placing=el.dataset.place;status('Tap the floor plan where '+state.placing+' should be labeled.');
    });
    renderMap();
  }
  function copyDefaults(source){
    return source.map(a=>standardize({...a,assignments:{}}));
  }
  async function load(){
    const eid=eventSelect.value,serial=++state.request;
    if(!eid)return;
    state.eventId=eid;state.placing=null;status('Loading plans for this event…');
    try{
      const [result,rows]=await Promise.all([
        api('floor-area-plans&event_id='+encodeURIComponent(eid)),
        api('floor-attendees&event_id='+encodeURIComponent(eid))
      ]);
      if(serial!==state.request||eventSelect.value!==eid)return;
      const event=events.find(e=>e.id===eid);
      state.vendors=rows||[];
      state.template=(result.template||[]).map(standardize);
      state.areas=(result.areas&&result.areas.length?result.areas:venueDefaults(event)).map(standardize);
      state.active=0;state.dirty=false;
      status(result.areas?.length?'Loaded saved floor plans for this event.':'New event layouts prepared. Upload photos and save to keep these plans for this event.');
      render();
    }catch(e){status('Could not load area plans: '+e.message);}
  }
  q('fam-area').onchange=e=>{state.active=Number(e.target.value)||0;state.placing=null;render();};
  q('fam-upload').onchange=async e=>{
    const file=e.target.files?.[0],a=current();if(!file||!a)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){notice('Please choose PNG, JPG or WebP.');return;}
    if(file.size>14000000){notice('Image exceeds 14 MB. Please reduce its size.');return;}
    try{
      const url=await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);
      });
      const img=await new Promise((resolve,reject)=>{const x=new Image();x.onload=()=>resolve(x);x.onerror=reject;x.src=url;});
      const factor=Math.min(1,1700/Math.max(img.width,img.height));
      const canvas=document.createElement('canvas');canvas.width=Math.round(img.width*factor);canvas.height=Math.round(img.height*factor);
      const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      let output=canvas.toDataURL('image/jpeg',0.83);
      if(output.length>2800000)output=canvas.toDataURL('image/jpeg',0.67);
      if(output.length>2800000)throw Error('Image is still too large after resizing. Please use a smaller source image.');
      if(state.eventId!==eventSelect.value)return;
      a.image_data_url=output;markDirty();render();
    }catch(error){notice('Image upload failed: '+error.message);}
    e.target.value='';
  };
  q('fam-clear').onclick=()=>{const a=current();if(!a||!a.image_data_url)return;if(!confirm('Remove this area image for this event? Existing vendor assignments will remain.'))return;a.image_data_url='';markDirty();render();};
  q('fam-reuse').onclick=()=>{
    if(!state.template.length||!confirm('Copy the latest venue layouts and images into this event? Vendor assignments will be cleared.'))return;
    state.areas=copyDefaults(state.template);state.active=0;markDirty();render();
  };
  q('fam-save').onclick=async()=>{
    if(!state.eventId)return;
    const id=state.eventId;const button=q('fam-save');button.disabled=true;status('Saving all '+state.areas.length+' areas…');
    try{
      const r=await api('floor-area-plans-save',{event_id:id,areas:state.areas});
      if(id!==eventSelect.value)return;
      state.dirty=false;status('Saved '+r.area_count+' event-specific area plans. Other dates and venues were not changed.');
      notice('Floor plan areas saved for the selected event.');
    }catch(error){status('Save failed: '+error.message);}finally{button.disabled=false;}
  };
  q('fam-download').onclick=()=>{const a=current();if(!a||!imageAllowed(a.image_data_url))return;const link=document.createElement('a');link.href=a.image_data_url;link.download=String(a.title).replace(/[^a-z0-9]+/gi,'-')+'-Floor-Plan.jpg';link.click();};
  return {load};
}
