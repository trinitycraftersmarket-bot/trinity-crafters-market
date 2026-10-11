// Event-specific multi-area floor plan management, separate from the legacy editor.
export function setupFloorAreaManager({host,eventSelect,events,locations,api,esc,notice}) {
  const state={eventId:'',areas:[],vendors:[],template:[],active:0,selectedSpot:null,showNames:true,placing:null,dirty:false,request:0,revision:0,baseAreas:[]};
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
      {area_key:'main',title:'Indoor Room',capacity:9,space_type:'indoor',prefix:'HI'},
      {area_key:'hallway',title:'Hallway',capacity:1,space_type:'indoor',prefix:'HW'}
    ];
    if(/trinity yoga|holistic experience/.test(name))return [
      {area_key:'studio',title:'Yoga Studio',capacity:8,space_type:'indoor',prefix:'YS'}
    ];
    return [
      {area_key:'inside',title:'Indoor Area',capacity:9,space_type:'indoor',prefix:'IN'},
      {area_key:'outside',title:'Outdoor Area',capacity:2,space_type:'outdoor',prefix:'OUT'}
    ];
  };

  const hamptonHallwayArea=()=>({
    area_key:'hallway',title:'Hallway',capacity:1,
    space_type:'indoor',prefix:'HW',image_data_url:'',assignments:{}
  });
  const isHamptonEvent=event=>{
    const place=locations.find(x=>x.id===event?.location_id);
    const name=String((place?.name||'')+' '+(event?.title||'')).toLowerCase();
    return /hampton inn|odessa trinity/.test(name)&&!/hilton garden inn/.test(name);
  };
  const addHamptonHallway=(areas,event)=>{
    if(!isHamptonEvent(event)||areas.some(a=>a.area_key==='hallway'))return areas;
    return [...areas,hamptonHallwayArea()];
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
  // Selling information is only a selection aid for staff. The map and
  // printable booth roster continue to show the vendor's name, never products.
  const sells=v=>String(v?.products||v?.category||'Not specified').replace(/\s+/g,' ').trim();
  const sellerPreview=v=>{
    const detail=sells(v);
    return detail.length>85?detail.slice(0,82).trimEnd()+'…':detail;
  };
  const choices=(selected,area)=>{
    const assignedElsewhere=new Set(state.areas.flatMap(a=>Object.values(a.assignments||{}).map(v=>String(v.vendor_id||'')).filter(Boolean)));
    return '<option value="">Unassigned</option>'+state.vendors
      .filter(v=>(['outside','outdoor'].includes(String(v.space||'').toLowerCase())?'outdoor':'indoor')===area.space_type)
      .sort((a,b)=>String(a.business||a.name||'').localeCompare(String(b.business||b.name||'')))
      .map(v=>{
        const id=String(v.id),taken=assignedElsewhere.has(id)&&id!==String(selected||'');
        const label=String(v.business||v.name||'Unnamed vendor')+' — Sells: '+sellerPreview(v)+(taken?' (assigned elsewhere)':'');
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
      '<button type="button" id="fam-print" class="secondary" style="flex:0 0 auto">Print booth list</button>'+ 
      '<button type="button" id="fam-save" style="flex:0 0 auto">Save changes</button>'+
      '<button type="button" id="fam-refresh" class="secondary" style="flex:0 0 auto">Refresh shared plans</button>'+
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
        '<label style="min-width:0">Vendor — what they sell<select id="fam-vendor" style="width:100%"></select></label>'+
      '</div>'+
      '<p id="fam-spot-info" class="muted" style="font-size:13px;margin:9px 0 4px"></p>'+
      '<p id="fam-sells-info" style="font-size:13px;line-height:1.45;margin:0 0 12px;overflow-wrap:anywhere"></p>'+
      '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">'+
        '<button class="secondary" type="button" id="fam-reset">Reset name position</button>'+
        '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin:0">'+
          '<input type="checkbox" id="fam-toggle" style="width:16px;height:16px"> Show vendor names'+
        '</label>'+
      '</div>'+
      '<p class="muted" style="font-size:12px;margin:8px 0 0">Press and drag any vendor name directly on the floor plan. Release it where you want it — the position saves automatically.</p>'+
    '</section>'+
    '<details id="fam-assignment-details" style="border:1px solid #dde5df;border-radius:9px;padding:10px 12px;margin:12px 0">'+
      '<summary id="fam-assignments-title" style="cursor:pointer;font-weight:600"></summary>'+
      '<div id="fam-assignments" style="margin-top:10px"></div>'+
    '</details>'+
    '<details id="fam-image-tools" style="border:1px solid #dde5df;border-radius:9px;padding:10px 12px;margin:12px 0">'+
      '<summary style="cursor:pointer;font-weight:600">Change image or reuse a layout</summary>'+
      '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;align-items:end">'+
        '<label style="flex:1;min-width:170px">Upload room image (PNG, JPG or WebP)<input id="fam-upload" type="file" accept="image/png,image/jpeg,image/webp"></label>'+
        '<button id="fam-download" type="button" class="secondary">Download floor plan with names</button>'+
        '<button id="fam-reuse" type="button" class="secondary">Reuse prior venue layouts</button>'+
        '<button id="fam-clear" type="button" class="secondary">Remove this image</button>'+
      '</div>'+
      '<p class="muted" style="font-size:12px">Changing an image does not remove vendor assignments. Reusing a prior layout does reset assignments, after confirmation.</p>'+
    '</details>'+
  '</section>';
  const q=id=>host.querySelector('#'+id);
  const status=message=>{q('fam-status').textContent=message;};
  const markDirty=()=>{state.dirty=true;state.revision++;status('Unsaved changes — saving now… Please wait for confirmation before refreshing.');};
  const clone=data=>JSON.parse(JSON.stringify(data));
  const inputForSave=()=>{
    const bases=new Map(state.baseAreas.map(a=>[a.area_key,a]));
    return {
      event_id:state.eventId,
      areas:state.areas.map(a=>({...a,image_changed:(a.image_data_url||'')!==(bases.get(a.area_key)?.image_data_url||'')})),
      base_areas:state.baseAreas.map(a=>({area_key:a.area_key,title:a.title,prefix:a.prefix,capacity:a.capacity,space_type:a.space_type,updated_at:a.updated_at,assignments:a.assignments}))
    };
  };
  function rebaseEdits(server,currentEdits,sent){
    const sentByKey=new Map(sent.map(a=>[a.area_key,a]));
    const latestByKey=new Map(server.map(a=>[a.area_key,a]));
    for(const edited of currentEdits){
      const sentArea=sentByKey.get(edited.area_key);
      const latest=latestByKey.get(edited.area_key);
      if(!latest){latestByKey.set(edited.area_key,edited);continue;}
      if(!sentArea)continue;
      for(const [slot,entry] of Object.entries(edited.assignments||{})){
        if(JSON.stringify(entry)!==JSON.stringify(sentArea.assignments?.[slot])){
          latest.assignments[slot]=entry;
        }
      }
      if(edited.image_data_url!==sentArea.image_data_url)latest.image_data_url=edited.image_data_url;
    }
    return [...latestByKey.values()];
  }
  let saving=false;
  // Warn before abandoning the page while an image or booth edit is in flight.
  const warnUnsaved=event=>{if(state.dirty||saving){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',warnUnsaved);
  async function saveChanges(){
    if(saving||!state.eventId)return;
    saving=true;
    const eventId=state.eventId,saveButton=q('fam-save');
    saveButton.disabled=true;
    try{
      while(state.eventId===eventId&&state.dirty){
        const revision=state.revision;
        const payload=inputForSave();
        const sent=clone(state.areas);
        status('Saving shared booth assignments…');
        const result=await api('floor-area-plans-save',payload);
        if(state.eventId!==eventId)return;
        const server=result.areas.map(standardize);
        if(state.revision===revision){
          state.areas=clone(server);
          state.baseAreas=clone(server);
          state.dirty=false;
          const imageCount=server.filter(a=>imageAllowed(a.image_data_url)).length;
          status('Saved to database ✓ '+result.area_count+' floor plan area(s), '+imageCount+' uploaded image(s). You can safely refresh now.');
          render();
          return;
        }
        // Edits made locally while a request was in flight must be layered on top
        // of the server's merged result instead of discarding either editor's work.
        const pending=clone(state.areas);
        state.baseAreas=clone(server);
        state.areas=rebaseEdits(clone(server),pending,sent);
      }
    }catch(error){
      if(state.eventId===eventId){
        status('NOT SAVED — '+error.message+' Do not refresh until you retry Save changes or resolve the issue.');
      }
    }finally{
      saving=false;
      saveButton.disabled=false;
    }
  }
  function renderMap(){
    const a=current(),map=q('fam-map');map.replaceChildren();
    if(!a)return;
    if(imageAllowed(a.image_data_url)){
      const img=image.cloneNode();img.src=a.image_data_url;
      map.appendChild(img);
    }else{
      const placeholder=document.createElement('div');
      placeholder.style.cssText='aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;padding:24px;color:#235044;text-align:center';
      placeholder.textContent=a.area_key==='hallway'&&isHamptonEvent(events.find(e=>e.id===state.eventId))
        ?'Hampton Hallway — select HW-01 and choose an indoor vendor below. An image is optional. Keep entrances and emergency exits clear.'
        :'No floor plan image uploaded for '+a.title+'. Open "Change image or reuse a layout" to add one.';
      map.appendChild(placeholder);
    }
    renderPins();
    map.style.cursor='default';
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
      pin.style.cssText='position:absolute;z-index:2;left:'+x+'%;top:'+y+'%;transform:translate(-50%,-50%);background:rgba(255,255,255,.97);color:#103e35;border:1px solid #16594a;border-radius:6px;font-size:clamp(9px,1.3vw,12px);line-height:1.15;font-weight:700;padding:5px 7px;max-width:26%;box-shadow:0 1px 3px #777;cursor:grab;overflow-wrap:anywhere;text-align:center;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none';
      pin.textContent=String(vendor.business||vendor.name);
      pin.title=id+' — drag to move '+String(vendor.business||vendor.name);
      pin.setAttribute('aria-label','Drag '+id+' '+String(vendor.business||vendor.name)+' to reposition');
      let drag=null;
      pin.addEventListener('pointerdown',ev=>{
        if(ev.button!==0)return;
        ev.preventDefault();
        ev.stopPropagation();
        state.selectedSpot=id;
        // Keep the offset from the finger / mouse so the label does not jump.
        drag={pointerId:ev.pointerId,screenX:ev.clientX,screenY:ev.clientY,x,y,moved:false};
        pin.setPointerCapture(ev.pointerId);
        pin.style.cursor='grabbing';
        pin.style.zIndex='30';
      });
      pin.addEventListener('pointermove',ev=>{
        if(!drag||drag.pointerId!==ev.pointerId)return;
        ev.preventDefault();
        const bounds=map.getBoundingClientRect();
        if(!bounds.width||!bounds.height)return;
        const shiftX=ev.clientX-drag.screenX,shiftY=ev.clientY-drag.screenY;
        if(Math.hypot(shiftX,shiftY)>3)drag.moved=true;
        const halfWidth=pin.offsetWidth/bounds.width*50;
        const halfHeight=pin.offsetHeight/bounds.height*50;
        const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
        const nextX=clamp(drag.x+shiftX/bounds.width*100,halfWidth,100-halfWidth);
        const nextY=clamp(drag.y+shiftY/bounds.height*100,halfHeight,100-halfHeight);
        pin.style.left=nextX+'%';
        pin.style.top=nextY+'%';
      });
      pin.addEventListener('pointerup',ev=>{
        if(!drag||drag.pointerId!==ev.pointerId)return;
        ev.preventDefault();
        ev.stopPropagation();
        const moved=drag.moved;
        drag=null;
        pin.style.cursor='grab';
        pin.style.zIndex='2';
        if(pin.hasPointerCapture(ev.pointerId))pin.releasePointerCapture(ev.pointerId);
        if(moved){
          const left=parseFloat(pin.style.left),top=parseFloat(pin.style.top);
          a.assignments[id]={...a.assignments[id],x:+left.toFixed(3),y:+top.toFixed(3)};
          markDirty();
          render();
          void saveChanges();
        }else{
          render();
        }
      });
      pin.addEventListener('pointercancel',ev=>{
        if(!drag||drag.pointerId!==ev.pointerId)return;
        drag=null;
        pin.style.left=x+'%';
        pin.style.top=y+'%';
        pin.style.zIndex='2';
        pin.style.cursor='grab';
      });
      pin.addEventListener('click',ev=>ev.stopPropagation());
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
    q('fam-area-info').textContent=a.title+' · '+assignedInArea+' of '+a.capacity+' booths assigned · '+a.space_type+(a.area_key==='hallway'&&isHamptonEvent(events.find(e=>e.id===state.eventId))?' · Separate hallway placement (subject to venue clearance)':'');
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
    q('fam-sells-info').innerHTML=selectedVendor?'<strong>What they sell:</strong> '+safe(sells(selectedVendor)):
      '<span class="muted">Choose a vendor to see their products before assigning the booth.</span>';
    q('fam-toggle').checked=state.showNames;
    q('fam-reset').disabled=!entry.vendor_id||!(entry.x!=null&&entry.y!=null);
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
      markDirty();render();void saveChanges();
    };
    renderMap();
  }
  function printAssignments(){
    const event=events.find(e=>e.id===state.eventId);
    const venue=locations.find(l=>l.id===event?.location_id);
    if(!event||!state.areas.length){
      notice('Select an event with floor plan areas before printing.');return;
    }
    // Organizer-only printout; never transmitted through vendor mail.
    const vendorById=new Map(state.vendors.map(v=>[String(v.id),v]));
    const assigned=new Set();
    const blocks=state.areas.map(area=>{
      const boothRows=Array.from({length:area.capacity},(_,i)=>{
        const id=spot(area,i),vendorId=String(area.assignments[id]?.vendor_id||'');
        const vendor=vendorById.get(vendorId);
        if(vendor)assigned.add(vendorId);
        return {id,name:vendor?String(vendor.business||vendor.name||'Unnamed vendor'):'— Open —'};
      });
      return {title:String(area.title),space:String(area.space_type),capacity:area.capacity,filled:boothRows.filter(r=>r.name!=='— Open —').length,rows:boothRows};
    });
    const unassigned=state.vendors.filter(v=>!assigned.has(String(v.id))).sort((a,b)=>String(a.business||a.name||'').localeCompare(String(b.business||b.name||'')));
    const total=blocks.reduce((n,b)=>n+b.capacity,0),filled=blocks.reduce((n,b)=>n+b.filled,0);
    const eventDate=new Date(String(event.date).slice(0,10)+'T12:00:00');
    const dateText=Number.isNaN(eventDate.getTime())?String(event.date||''):eventDate.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    const title=String(venue?.market_name||event.title||'Market')+' — Booth Assignments';
    const sections=blocks.map(area=>'<section class="area"><div class="area-heading"><h2>'+safe(area.title)+'</h2><span>'+area.filled+' / '+area.capacity+' assigned · '+safe(area.space)+'</span></div>'+
      '<table><thead><tr><th class="booth">Booth</th><th>Vendor / Business</th><th class="check">Checked in</th></tr></thead><tbody>'+
      area.rows.map(r=>'<tr><td class="booth">'+safe(r.id)+'</td><td'+(r.name==='— Open —'?' class="open"':'')+'>'+safe(r.name)+'</td><td class="check"><span class="tick"></span></td></tr>').join('')+
      '</tbody></table></section>').join('');
    const pending=unassigned.length?'<section class="area"><div class="area-heading"><h2>Unassigned / Overflow</h2><span>'+unassigned.length+' vendor(s)</span></div>'+
      '<table><thead><tr><th>Vendor / Business</th><th class="booth">Booking</th><th>Placement notes</th></tr></thead><tbody>'+
      unassigned.map(v=>'<tr><td>'+safe(v.business||v.name||'Unnamed vendor')+'</td><td>'+safe(v.space||'')+'</td><td>&nbsp;</td></tr>').join('')+
      '</tbody></table></section>':'';
    const stylesheet='@page{size:letter portrait;margin:.48in .5in}'+
      '*{box-sizing:border-box}html,body{margin:0;padding:0;color:#172821;background:white;font:11pt Arial,Helvetica,sans-serif}'+
      'header{border-bottom:2px solid #174d40;padding-bottom:10px;margin-bottom:15px}h1{font:700 19pt Georgia,serif;color:#174d40;margin:0 0 5px}'+
      'header p{margin:3px 0;color:#34443d;font-size:10pt}.summary{font-weight:700;margin:12px 0;font-size:10pt}.private{font-size:8pt;letter-spacing:.7px;text-transform:uppercase;font-weight:700}'+
      '.draft{font-weight:700;color:#a13d18;margin-top:5px}.area{break-inside:avoid-page;page-break-inside:avoid;margin:12px 0 16px}'+
      '.area-heading{display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-bottom:1px solid #b9cec4;margin-bottom:5px}'+
      '.area-heading h2{margin:0;padding:3px 0 5px;font-size:13pt;color:#16483c}.area-heading span{font-size:9pt;color:#56675e}'+
      'table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}'+
      'th{background:#e8f1eb;color:#173d33;text-align:left;font-size:9pt;padding:6px;border:1px solid #d3dfd7}'+
      'td{padding:6px 8px;border:1px solid #d3dfd7;overflow-wrap:anywhere;font-size:10pt;line-height:1.15;height:25px}'+
      '.booth{width:21%;font-weight:700}.check{width:16%;text-align:center}.tick{display:inline-block;width:14px;height:14px;border:1.3px solid #65796c;border-radius:2px}'+
      '.open{color:#777;font-style:italic}.button-row{position:sticky;top:0;background:#fffefb;padding:12px 0;display:flex;gap:10px}'+
      'button{padding:10px 18px;border:0;border-radius:7px;background:#175745;color:white;font-weight:bold;font-size:13px;cursor:pointer}'+
      '@media print{.button-row{display:none!important}}';
    const doc='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+safe(title)+'</title><style>'+stylesheet+'</style></head><body>'+
      '<div class="button-row"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>'+
      '<header><h1>'+safe(title)+'</h1><p><strong>'+safe(dateText)+'</strong> · '+safe(venue?.name||event.title||'')+'</p>'+
      (venue?.address?'<p>'+safe(venue.address)+'</p>':'')+
      '<p class="private">Private organizer copy — do not distribute to vendors</p>'+
      (state.dirty?'<p class="draft">UNSAVED CHANGES — this printout includes edits not yet saved online.</p>':'')+
      '</header><p class="summary">'+filled+' of '+total+' booths assigned · '+(total-filled)+' open · '+unassigned.length+' vendors awaiting a booth</p>'+
      sections+pending+'</body></html>';
    // Open directly in this click handler, before browser popup protections apply.
    const popup=window.open('','_blank');
    if(!popup){notice('Your browser blocked the print preview. Allow pop-ups for this site and try again.');return;}
    popup.document.open();
    popup.document.write(doc);
    popup.document.close();
    popup.focus();
    status('Printable booth list opened in a new tab. Select Print / Save as PDF.');
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
      state.areas=addHamptonHallway((result.areas&&result.areas.length?result.areas:venueDefaults(event)).map(standardize),event);
      state.active=0;state.selectedSpot=null;state.showNames=true;state.dirty=false;state.revision=0;state.baseAreas=clone((result.areas||[]).map(standardize));
      status(result.areas?.length?'Loaded saved floor plans for this event.':'New event layouts prepared. Upload photos and save to keep these plans for this event.');
      render();
    }catch(e){status('Could not load area plans: '+e.message);}
  }
  q('fam-print').onclick=printAssignments;
  q('fam-area').onchange=e=>{state.active=Number(e.target.value)||0;state.selectedSpot=null;state.placing=null;state.showNames=true;render();};
  q('fam-reset').onclick=()=>{
    const a=current(),id=state.selectedSpot,entry=a?.assignments[id];
    if(!entry||entry.x==null||entry.y==null)return;
    const {x,y,...rest}=entry;
    a.assignments[id]=rest;
    markDirty();
    render();
    void saveChanges();
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
      a.image_data_url=output;markDirty();render();void saveChanges();
    }catch(error){notice('Image upload failed: '+error.message);}
    e.target.value='';
  };
  q('fam-clear').onclick=()=>{const a=current();if(!a||!a.image_data_url)return;if(!confirm('Remove this area image for this event? Existing vendor assignments will remain.'))return;a.image_data_url='';markDirty();render();void saveChanges();};
  q('fam-reuse').onclick=()=>{
    if(!state.template.length||!confirm('Copy the latest venue layouts and images into this event? Vendor assignments will be cleared.'))return;
    state.areas=addHamptonHallway(copyDefaults(state.template),events.find(e=>e.id===state.eventId));state.active=0;state.selectedSpot=null;state.showNames=true;markDirty();render();void saveChanges();
  };
  q('fam-save').onclick=()=>{void saveChanges();};
  q('fam-refresh').onclick=()=>{
    if(state.dirty&&!confirm('You have unsaved changes. Refreshing will discard only those local changes. Continue?'))return;
    void load();
  };
  q('fam-download').onclick=async()=>{
    const area=current();
    if(!area||!imageAllowed(area.image_data_url)){notice('Upload and save a floor plan image before downloading.');return;}
    const assignments=Array.from({length:area.capacity},(_,i)=>{
      const id=spot(area,i),entry=area.assignments?.[id]||{};
      const vendor=state.vendors.find(v=>String(v.id)===String(entry.vendor_id||''));
      if(!vendor)return null;
      const fallback=autoLabelPosition(area,i);
      return {
        label:String(vendor.business||vendor.name||'Vendor'),
        x:entry.x!=null&&Number.isFinite(Number(entry.x))?Number(entry.x):fallback.x,
        y:entry.y!=null&&Number.isFinite(Number(entry.y))?Number(entry.y):fallback.y
      };
    }).filter(Boolean);
    if(!assignments.length){notice('No vendor names are assigned in '+area.title+' yet. Assign vendors before downloading the completed floor plan.');return;}
    const button=q('fam-download'),oldLabel=button.textContent;
    button.disabled=true;button.textContent='Preparing named floor plan…';
    try{
      // The map contains the actual uploaded image and movable labels.
      // Capturing this element preserves the exact visible name positions and wraps.
      const el=q('fam-map');
      if(!window.html2canvas)throw Error('Floor plan image export is still loading. Refresh the page and try again.');
      // Make sure the image decoded before capture; otherwise some phones produce a blank picture.
      await Promise.all([...el.querySelectorAll('img')].map(img=>img.decode?img.decode():Promise.resolve()));
      const width=el.getBoundingClientRect().width||600;
      // Labels must be included even when the organizer toggled their view off.
      const wasShowing=state.showNames;
      state.showNames=true;renderPins();
      try{
        const canvas=await window.html2canvas(el,{
          backgroundColor:'#ffffff',scale:Math.min(3,Math.max(1.8,1500/width)),
          useCORS:true,logging:false,removeContainer:true
        });
        if(!canvas.width||!canvas.height)throw Error('The image export was empty. Please try again.');
        await new Promise((resolve,reject)=>{
          canvas.toBlob(blob=>{
            if(!blob){reject(Error('Could not prepare the exported image.'));return;}
            const href=URL.createObjectURL(blob),link=document.createElement('a');
            link.href=href;
            const evt=events.find(e=>e.id===state.eventId);
            link.download=String(evt?.date||'Event')+'-'+String(area.title||'Floor-Plan').replace(/[^a-z0-9]+/gi,'-')+'-With-Vendors.png';
            document.body.appendChild(link);link.click();link.remove();
            setTimeout(()=>URL.revokeObjectURL(href),15000);resolve();
          },'image/png');
        });
        status('Downloaded floor plan WITH '+assignments.length+' vendor name label(s).');
      }finally{
        state.showNames=wasShowing;
        renderPins();
        q('fam-toggle').checked=state.showNames;
      }
    }catch(error){
      status('Image download failed: '+error.message);
    }finally{
      button.disabled=false;button.textContent=oldLabel;
    }
  };
  return {load};
}
