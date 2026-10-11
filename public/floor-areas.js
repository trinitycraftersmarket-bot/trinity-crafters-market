// Event-specific multi-area floor plan management, separate from the legacy editor.
export function setupFloorAreaManager({host,eventSelect,events,locations,api,esc,notice}) {
  const state={eventId:'',areas:[],vendors:[],template:[],active:0,selectedSpot:null,showNames:true,placing:null,dirty:false,request:0};
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

  // Positions are percentages of the full uploaded floor plan graphic, including its
  // heading/borders, so names appear next to the pre-printed booth numbers.
  // Any manually placed x/y in this event takes priority over these defaults.
  const mainRoomLabels={
    1:[85,62],2:[86,49.5],3:[86,37.5],4:[86,24.5],
    5:[65,16],6:[32,21],7:[56,31],8:[51,49],
    9:[55,65],10:[59,85.5],11:[68,86.5],12:[28,86.5],
    13:[44,76.3],14:[46,66],15:[46,49.5],16:[43,30.2],
    17:[12,33.5],18:[12,46],19:[12,58],20:[12,69],21:[12,82]
  };
  const autoLabelPosition=(area,index)=>{
    if(area.prefix==='MR'&&area.capacity===21){
      const p=mainRoomLabels[index+1];if(p)return {x:p[0],y:p[1]};
    }
    // Hilton foyer graphic shows 23-27, rising from bottom to top.
    if(area.prefix==='H1'&&area.capacity===5)
      return {x:55,y:[89,74,59,42,27][index]};
    // Hilton side room graphic shows 28-30 rising from bottom to top.
    if(area.prefix==='H2'&&area.capacity===3)
      return {x:43,y:[84,56,29][index]};
    if(area.prefix==='HI'&&area.capacity===9){
      const p=[[50,22],[28,38],[74,38],[27,53],[74,53],[27,68],[74,68],[24,89],[58,89]][index];
      if(p)return {x:p[0],y:p[1]};
    }
    return positions(area,index);
  };
  const choices=(selected,area)=>{
    const assignedElsewhere=new Set(state.areas.flatMap(a=>Object.values(a.assignments||{}).map(v=>String(v.vendor_id||'')).filter(Boolean)));
    return '<option value="">Unassigned</option>'+state.vendors
      .filter(v=>(['outside','outdoor'].includes(String(v.space||'').toLowerCase())?'outdoor':'indoor')===area.space_type)
      .map(v=>{
        const id=String(v.id),taken=assignedElsewhere.has(id)&&id!==String(selected||'');
        const label=String(v.business||v.name||'Unnamed vendor')+(taken?' (assigned elsewhere)':'');
        return '<option value="'+safe(id)+'"'+(id===String(selected||'')?' selected':'')+(taken?' disabled':'')+'>'+safe(label)+'</option>';
      }).join('');
  };
  const current=()=>state.areas[state.active];
  const image=document.createElement('img');
  image.alt='Uploaded venue floor plan';
  image.style.cssText='display:block;width:100%;height:auto;object-fit:contain';
  host.classList.add('floor-area-manager');
  host.innerHTML='<section class="card" style="max-width:100%;overflow:hidden">'+
    '<h2 style="margin-bottom:6px">Event Floor Plans</h2>'+
    '<p class="muted">Choose an area, review the floor plan, then assign vendors by booth number. These plans belong only to the selected event.</p>'+
    '<div class="actions" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">'+
      '<label style="flex:1;min-width:165px">Floor plan area<select id="fam-area"></select></label>'+
      '<button type="button" id="fam-save" style="flex:0 0 auto">Save changes</button>'+
    '</div>'+
    '<p id="fam-status" class="muted" role="status"></p>'+
    '<p id="fam-area-info" style="font-weight:600"></p>'+
    '<details id="fam-overflow" style="background:#faf8f1;border:1px solid #e1dfd5;border-radius:8px;padding:9px 12px;margin:12px 0">'+
      '<summary id="fam-overflow-title" style="cursor:pointer;font-weight:600"></summary>'+
      '<div id="fam-overflow-content" class="muted" style="font-size:13px;line-height:1.5;margin-top:9px"></div>'+
    '</details>'+
    '<div id="fam-map" aria-label="Clean floor plan preview" style="position:relative;width:100%;max-width:640px;margin:12px auto 18px;background:#f7f3e7;border:1px solid #c8d6ce;border-radius:10px;overflow:hidden;min-height:160px"></div>'+
    '<section id="fam-booth-editor" style="background:#f5f9f6;border:1px solid #d6e3da;border-radius:12px;padding:14px;margin:8px 0">'+
      '<h3 style="margin:0 0 12px;font-size:19px">Assign a booth</h3>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px">'+
        '<label style="min-width:0">Booth number<select id="fam-spot" style="width:100%"></select></label>'+
        '<label style="min-width:0">Vendor<select id="fam-vendor" style="width:100%"></select></label>'+
      '</div>'+
      '<p id="fam-spot-info" class="muted" style="font-size:13px;margin:9px 0"></p>'+
      '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">'+
        '<button class="secondary" type="button" id="fam-place">Move selected label</button>'+
        '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:0">'+
          '<input type="checkbox" id="fam-toggle" style="width:16px;height:16px"> Show vendor names'+
        '</label>'+
      '</div>'+
      '<p class="muted" style="font-size:12px;margin:8px 0 0">Assigned vendor names appear automatically beside their numbered booths. Use Move selected label if one needs repositioning.</p>'+
    '</section>'+
    '<details id="fam-assignment-details" style="border:1px solid #dde5df;border-radius:9px;padding:10px 12px;margin:12px 0">'+
      '<summary id="fam-assignments-title" style="cursor:pointer;font-weight:600"></summary>'+
      '<div id="fam-assignments" style="margin-top:10px"></div>'+
    '</details>'+
    '<details id="fam-image-tools" style="border:1px solid #dde5df;border-radius:9px;padding:10px 12px;margin:12px 0">'+
      '<summary style="cursor:pointer;font-weight:600">Change image or reuse a layout</summary>'+
      '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;align-items:end">'+
        '<label style="flex:1;min-width:170px">Upload room image (PNG, JPG or WebP)<input id="fam-upload" type="file" accept="image/png,image/jpeg,image/webp"></label>'+
        '<button id="fam-download" type="button" class="secondary">Download image</button>'+
        '<button id="fam-reuse" type="button" class="secondary">Reuse prior venue layouts</button>'+
        '<button id="fam-clear" type="button" class="secondary">Remove this image</button>'+
      '</div>'+
      '<p class="muted" style="font-size:12px">Changing an image does not remove vendor assignments. Reusing a prior layout does reset assignments, after confirmation.</p>'+
    '</details>'+
  '</section>';
  const q=id=>host.querySelector('#'+id);
  const status=message=>{q('fam-status').textContent=message;};
  const markDirty=()=>{state.dirty=true;status('Unsaved edits — tap Save all event areas when ready.');};
  function renderMap(){
    const a=current(),map=q('fam-map');map.replaceChildren();
    if(!a)return;
    if(imageAllowed(a.image_data_url)){
      const img=image.cloneNode();img.src=a.image_data_url;
      map.appendChild(img);
    }else{
      const placeholder=document.createElement('div');
      placeholder.style.cssText='aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;padding:24px;color:#235044;text-align:center';
      placeholder.textContent='No floor plan image uploaded for '+a.title+'. Open "Change image or reuse a layout" to add one.';
      map.appendChild(placeholder);
    }
    renderPins();
    map.style.cursor=state.placing?'crosshair':'default';
    map.onclick=e=>{
      if(!state.placing||e.target.closest('button'))return;
      const r=map.getBoundingClientRect();
      const x=100*(e.clientX-r.left)/r.width,y=100*(e.clientY-r.top)/r.height;
      const selected=state.placing,before=a.assignments[selected]||{};
      a.assignments[selected]={...before,x:Math.max(3,Math.min(97,+x.toFixed(2))),y:Math.max(3,Math.min(97,+y.toFixed(2)))};
      state.placing=null;state.showNames=true;markDirty();render();
    };
  }
  function renderPins(){
    const a=current(),map=q('fam-map');if(!a)return;
    map.querySelectorAll('.fam-pin').forEach(x=>x.remove());
    if(!state.showNames)return;
    for(let i=0;i<a.capacity;i++){
      const id=spot(a,i),entry=a.assignments[id]||{};
      if(!entry.vendor_id)continue;
      const vendor=state.vendors.find(v=>String(v.id)===String(entry.vendor_id));
      if(!vendor)continue;
      const fallback=autoLabelPosition(a,i);
      const x=Number.isFinite(Number(entry.x))&&entry.x!=null?Number(entry.x):fallback.x;
      const y=Number.isFinite(Number(entry.y))&&entry.y!=null?Number(entry.y):fallback.y;
      const pin=document.createElement('button');pin.type='button';pin.className='fam-pin';
      pin.style.cssText='position:absolute;z-index:2;left:'+x+'%;top:'+y+'%;transform:translate(-50%,-50%);background:rgba(255,255,255,.96);color:#103e35;border:1px solid #16594a;border-radius:6px;font-size:clamp(9px,1.3vw,12px);line-height:1.15;font-weight:700;padding:3px 5px;max-width:22%;box-shadow:0 1px 3px #777;cursor:pointer;overflow-wrap:anywhere;text-align:center';
      pin.textContent=String(vendor.business||vendor.name);
      pin.title=id+' — '+String(vendor.business||vendor.name)+'. Tap to reposition name.';
      pin.setAttribute('aria-label','Move '+id+' '+String(vendor.business||vendor.name));
      pin.onclick=e=>{e.stopPropagation();state.selectedSpot=id;state.placing=id;render();status('Tap the image where '+id+' should display its vendor name.');};
      map.appendChild(pin);
    }
  }
  function render(){
    const a=current();if(!a)return;
    const ids=Array.from({length:a.capacity},(_,i)=>spot(a,i));
    if(!ids.includes(state.selectedSpot))state.selectedSpot=ids[0];
    const selected=state.selectedSpot,entry=a.assignments[selected]||{};
    const occupied=new Set(state.areas.flatMap(area=>Object.values(area.assignments||{}).map(x=>String(x.vendor_id||'')).filter(Boolean)));
    const overflow=state.vendors.filter(v=>!occupied.has(String(v.id)));
    const interior=overflow.filter(v=>!['outside','outdoor'].includes(String(v.space||'').toLowerCase()));
    const outside=overflow.filter(v=>['outside','outdoor'].includes(String(v.space||'').toLowerCase()));
    const assignedInArea=ids.filter(id=>!!a.assignments[id]?.vendor_id).length;
    q('fam-area').innerHTML=state.areas.map((v,i)=>'<option value="'+i+'"'+(i===state.active?' selected':'')+'>'+safe(v.title)+' ('+v.capacity+')</option>').join('');
    q('fam-area-info').textContent=a.title+' · '+assignedInArea+' of '+a.capacity+' booths assigned · '+a.space_type;
    q('fam-overflow-title').textContent=state.vendors.length+' active vendors · '+occupied.size+' assigned · '+overflow.length+' waiting for a spot (tap for names)';
    q('fam-overflow-content').innerHTML=overflow.length?
      '<strong>Unassigned / overflow</strong><p>'+overflow.map(v=>safe(v.business||v.name||'Vendor')+' ('+safe(v.space||'')+')').join(' · ')+'</p><p>Unassigned indoor: '+interior.length+'; outside: '+outside.length+'. Booking and payment statuses are unchanged.</p>':
      '<p>Every active vendor has an assigned booth.</p>';
    q('fam-reuse').disabled=!state.template.length;
    q('fam-download').disabled=!imageAllowed(a.image_data_url);
    q('fam-spot').innerHTML=ids.map(id=>'<option value="'+safe(id)+'"'+(id===selected?' selected':'')+'>'+safe(id)+(a.assignments[id]?.vendor_id?' · Assigned':' · Open')+'</option>').join('');
    q('fam-vendor').innerHTML=choices(entry.vendor_id||'',a);
    const selectedVendor=state.vendors.find(v=>String(v.id)===String(entry.vendor_id||''));
    q('fam-spot-info').textContent=selectedVendor?'Currently: '+String(selectedVendor.business||selectedVendor.name)+' at '+selected+'.':
      selected+' is currently unassigned.';
    q('fam-toggle').checked=state.showNames;
    q('fam-place').disabled=!entry.vendor_id;
    q('fam-assignments-title').textContent='View all '+a.capacity+' booths ('+assignedInArea+' assigned)';
    q('fam-assignments').innerHTML=ids.map(id=>{
      const vendor=state.vendors.find(v=>String(v.id)===String(a.assignments[id]?.vendor_id||''));
      return '<button type="button" data-open-spot="'+safe(id)+'" class="secondary" style="display:flex;justify-content:space-between;gap:12px;text-align:left;width:100%;font-size:13px;padding:8px 10px;margin:3px 0;border-radius:6px">'+
        '<strong>'+safe(id)+'</strong><span>'+safe(vendor?(vendor.business||vendor.name):'Open')+'</span></button>';
    }).join('');
    q('fam-assignments').querySelectorAll('[data-open-spot]').forEach(el=>el.onclick=()=>{
      state.selectedSpot=el.dataset.openSpot;render();
      q('fam-booth-editor').scrollIntoView({behavior:'smooth',block:'center'});
    });
    q('fam-spot').onchange=e=>{state.selectedSpot=e.target.value;state.placing=null;render();};
    q('fam-vendor').onchange=e=>{
      const newId=e.target.value;
      if(newId&&state.areas.some(area=>Object.entries(area.assignments||{}).some(([key,v])=>!(area===a&&key===selected)&&String(v.vendor_id||'')===newId))){
        notice('That vendor is already assigned to another booth.');render();return;
      }
      a.assignments[selected]={...(a.assignments[selected]||{}),vendor_id:newId};
      markDirty();render();
    };
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
      state.active=0;state.selectedSpot=null;state.showNames=true;state.dirty=false;
      status(result.areas?.length?'Loaded saved floor plans for this event.':'New event layouts prepared. Upload photos and save to keep these plans for this event.');
      render();
    }catch(e){status('Could not load area plans: '+e.message);}
  }
  q('fam-area').onchange=e=>{state.active=Number(e.target.value)||0;state.selectedSpot=null;state.placing=null;state.showNames=true;render();};
  q('fam-place').onclick=()=>{
    const a=current(),id=state.selectedSpot;
    if(!a||!a.assignments[id]?.vendor_id)return;
    state.placing=id;state.showNames=true;render();
    status('Tap the exact table/booth on the image to place '+id+"'s vendor label.");
    q('fam-map').scrollIntoView({behavior:'smooth',block:'center'});
  };
  q('fam-toggle').onchange=e=>{state.showNames=e.target.checked;renderPins();};

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
    state.areas=copyDefaults(state.template);state.active=0;state.selectedSpot=null;state.showNames=true;markDirty();render();
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
