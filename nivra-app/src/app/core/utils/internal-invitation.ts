/** Only canonical capability links may bypass the external browser. */
export function internalInvitationRoute(href:string):string|null{
  try{const url=new URL(href);if(url.protocol!=='https:'||url.hostname!=='nivrapp-secure.vercel.app'||url.username||url.password||url.port||url.pathname.replace(/\/+$/,'')!=='/group/invite')return null;
    const code=url.hash.slice(1);return /^[A-Za-z0-9_-]{43}$/.test(code)?'/group/invite#'+code:null;
  }catch{return null;}
}
