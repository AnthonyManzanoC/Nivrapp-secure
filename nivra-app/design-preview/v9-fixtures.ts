import { computed, signal } from '@angular/core';

// Synthetic services for the actual production components. No API or notifications.
export function v9Fixtures(user:any,photo:string){
  const community={id:'community-preview',name:'Barrio Las Flores',description:'Nuestro barrio, conectado. Avisos, ideas y encuentros para todos.',photo,role:'Owner',memberCount:48,updatedAt:new Date().toISOString(),groups:[
    {id:'design',name:'Equipo creativo',photo,memberCount:12,joined:true},
    {id:'family',name:'Actividades y encuentros',photo:null,memberCount:24,joined:false},
  ]};
  const communities:any={items:signal<any[]>([community]),loading:signal(false),busy:signal(''),error:signal(''),load:async()=>{},
    create:async(value:any)=>{const item={...community,...value,id:'community-new',groups:[]};communities.items.update((all:any[])=>[...all,item]);return item;},
    update:async(id:string,value:any)=>{const item={...community,...value,id};communities.items.update((all:any[])=>all.map(c=>c.id===id?item:c));return item;},
    link:async()=>community,unlink:async()=>{},join:async()=> 'family',createGroup:async()=>community,leave:async()=>true,inviteLink:async()=> 'https://example.test/group/invite#synthetic',
  };
  const rooms:any[]=[{id:'studio',name:'Estudio creativo',accessMode:'PinOnly',retentionMode:'Persistent',owner:user,
    members:[{userId:user.id,displayName:user.displayName,status:'Active'},{userId:'peer-sofia',displayName:'Sofía',status:'Active'},{userId:'peer-daniel',displayName:'Daniel',status:'Invited'}]},
    {id:'invitation',name:'Ideas de fin de semana',accessMode:'InviteOnly',requiresPin:false,retentionMode:'ExpiresAfterTtl',owner:{id:'peer-daniel'},members:[{userId:user.id,status:'Invited'}]},
  ];
  const vault:any={unlocked:signal(false),loading:signal(false),items:signal([]),rooms:signal(rooms),people:signal([{id:'peer-martina',displayName:'Martina',alias:'martina'}]),
    activeRoomId:signal('studio'),activeMessages:signal([
      {id:'1',mine:false,at:new Date().toISOString(),payload:{type:'text',text:'Bienvenidos al espacio del equipo. Aquí reunimos nuestras ideas.'}},
      {id:'2',mine:true,at:new Date().toISOString(),payload:{type:'text',text:'Perfecto. Ya tengo lista la propuesta para mañana ✨'}},
    ]),mediaPreviews:signal({}),sending:signal(false),uploading:signal(false),voicePhase:signal('idle'),voiceRoomId:signal(null),voiceError:signal(''),voiceConnected:signal(false),
    voiceMuted:signal(false),voiceActiveSpeakers:signal([]),voiceRemoteEntries:signal([]),
    load:async()=>{},enablePrivacyShield:async()=>{},disablePrivacyShield:async()=>{},
    currentMember:(room:any)=>room?.members.find((m:any)=>m.userId===user.id),isCurrentUser:(id:string)=>id===user.id,
    canAttemptJoin:()=>true,canInviteGuests:(room:any)=>room?.owner.id===user.id,canModerate:(room:any)=>room?.owner.id===user.id,
    roomStatusLabel:()=> 'Abierta',retentionLabel:(mode:string)=>mode==='Persistent'?'Se conserva':mode==='BurnOnExit'?'Borrar al salir':'1 hora',
    accessLabel:(mode:string)=>mode==='InviteOnly'?'Solo invitados':mode==='WaitingRoom'?'Con aprobación':'Invitados + PIN',
    memberLabel:(m:any)=>m.displayName||'Alex',messageSender:(m:any)=>m.mine?'Tú':'Sofía',asFile:()=>null,preview:(payload:any)=>payload?.text||'',
    selectRoom:async(id:string)=>{vault.activeRoomId.set(id);},searchPeople:async()=>{},createRoom:async()=>rooms[0],
  };
  vault.activeRoom=computed(()=>vault.rooms().find((r:any)=>r.id===vault.activeRoomId())??null);
  return {communities,vault};
}
