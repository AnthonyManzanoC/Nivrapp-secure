// CI only. Synthetic preview build; no user account, API or local browser profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  if (process.env.CI !== 'true') throw Error('Run this check only in isolated CI.');
  const root = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'nivra-design-'));
  const mime = { '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.wasm':'application/wasm', '.json':'application/json' };
  const server = http.createServer(async (req, res) => {
    try {
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
      let file = path.resolve(root, relative || 'index.html');
      if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) throw Error('Invalid path');
      try { if (!(await fs.stat(file)).isFile()) file = path.join(root, 'index.html'); }
      catch { file = path.join(root, 'index.html'); }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio:['ignore','ignore','pipe'] });
  let browserDiagnostics = '';
  chrome.stderr.on('data', chunk => { browserDiagnostics = (browserDiagnostics + chunk.toString()).slice(-8000); });
  chrome.on('error', error => { browserDiagnostics += error.message; });
  let socket;
  try {
    let port;
    for (let i = 0; i < 300; i++) {
      if (chrome.exitCode !== null) break;
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!port) await fs.writeFile(path.join(output,'browser-startup.txt'),browserDiagnostics);
    assert(port, 'Chrome did not start: ' + browserDiagnostics);
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method:'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen=resolve; socket.onerror=reject; });
    let serial = 0;
    const pending = new Map(), errors = [];
    const call = (method, params={}) => new Promise((resolve,reject) => {
      const id=++serial; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params}));
    });
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) { const p=pending.get(message.id); pending.delete(message.id); message.error?p.reject(Error(message.error.message)):p.resolve(message.result); }
      else if (message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      else if (message.method==='Runtime.consoleAPICalled' && message.params.type==='error') errors.push(message.params.args.map(arg=>arg.description||arg.value||arg.type).join(' '));
      else if (message.method==='Fetch.requestPaused') {
        const url=message.params.request.url;
        void call(url.startsWith(base) || /^(data|blob):/.test(url)?'Fetch.continueRequest':'Fetch.failRequest',
          {requestId:message.params.requestId,...(url.startsWith(base) || /^(data|blob):/.test(url)?{}:{errorReason:'BlockedByClient'})}).catch(()=>{});
      }
    };
    await call('Runtime.enable'); await call('Page.enable');
    await call('Page.bringToFront');
    await call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    const evaluate = async expression => {
      const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async expression => {
      for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}
      const diagnostics=await evaluate("({text:document.body.innerText,focus:document.activeElement?.outerHTML,inputs:[...document.querySelectorAll('ion-input')].map(input=>({html:input.outerHTML,hasNative:!!input.querySelector('input'),classes:input.className}))})");
      await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({expression,diagnostics,errors},null,2));
      await capture('failure');
      throw Error('UI did not become ready: '+expression+'; '+errors.join('; '));
    };
    const capture = async name => {
      await evaluate('document.fonts.ready');
      await new Promise(resolve=>setTimeout(resolve,300));
      const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));
    };
    const viewport = (width,height,mobile) => call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    const tap = async selector => {
      // A newly attached Ionic modal can still be moving to its final position.
      await new Promise(resolve=>setTimeout(resolve,450));
      const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("!!document.querySelector('.chats-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.compact-stories');
    await waitFor("document.querySelectorAll('.story-highlight').length > 5 && !!document.querySelector('.story-strip-page:not(.previous):not(:disabled)')");
    assert(await evaluate("(()=>{const a=document.querySelector('.story-collapse').getBoundingClientRect(),b=document.querySelector('.story-highlight').getBoundingClientRect();return a.bottom<=b.top || a.left>=b.right || a.right<=b.left;})()"),'collapse control must not cover Mi historia');
    await tap('.story-strip-page:not(.previous)');
    await waitFor("document.querySelector('.story-strip').scrollLeft > 20");
    await capture('mobile-stories-scroll');
    await evaluate("document.querySelector('.story-strip').scrollLeft=0");
    await capture('mobile-chats');
    assert.equal(await evaluate("document.querySelectorAll('.header-refresh').length"),0,'refresh is removed from the heading');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.side-actions .new-chat-button')).display"),'none','mobile heading keeps only the menu action');
    await waitFor("document.querySelector('.mobile-message-fab').getBoundingClientRect().width<65");
    await capture('mobile-message-button');
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.chats-page.search-active')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.side-head')).display"),'none','mobile search replaces Chats heading');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.rail')).display"),'none','mobile search hides bottom navigation');
    assert.equal(await evaluate("(async()=>getComputedStyle(await document.querySelector('.search-box ion-input').getInputElement()).outlineStyle)()"),'none','native input must not draw a rectangle inside the search pill');
    assert(await evaluate("document.querySelector('.search-box').getBoundingClientRect().top < 40"),'search uses the top of the screen');
    await capture('mobile-search');
    await evaluate("localStorage.setItem('nivra_recent_searches.preview-owner',JSON.stringify([{id:'peer-1',alias:'sofia',displayName:'Sofía Martínez',isDiscoverable:true}]))");
    await call('Page.navigate',{url:base+'/app/chats?theme=light&recent=1'});
    await waitFor("!!document.querySelector('.search-box ion-input')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.clear-recents')");
    assert(await evaluate("(()=>{const b=document.querySelector('.clear-recents');return b.getBoundingClientRect().width>100 && getComputedStyle(b).whiteSpace==='nowrap';})()"),'delete recent searches is a readable full-width action');
    await capture('mobile-search-recents');
    await tap('.clear-recents');
    await waitFor("document.querySelectorAll('.recent-tile').length===0");
    await evaluate("document.querySelector('.search-back').click()");
    await waitFor("!document.querySelector('.chats-page.search-active')");
    await tap('.mobile-message-fab');
    await waitFor("!!document.querySelector('.contacts-page')");
    assert(await evaluate("document.querySelector('.self-contact').textContent.includes('(Tú)')"),'self notes are accessible from Contacts');
    await capture('mobile-contacts');
    await evaluate("document.querySelector('.contacts-head button[aria-label=\"Buscar contactos\"]').click()");
    await waitFor("!!document.querySelector('.contacts-surface.searching')");
    await capture('mobile-contacts-search');
    await viewport(1440,900,false);
    await call('Page.navigate',{url:base+'/app/contacts?theme=light'});
    await waitFor("!!document.querySelector('.contacts-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-contacts');
    await tap('.directory-tabs button:nth-child(2)');
    await waitFor("!!document.querySelector('app-friend-requests')");
    assert(await evaluate("document.querySelector('app-friend-requests').textContent.includes('Daniela López')"),'requests remain accessible from Contacts');
    await capture('desktop-requests');
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("!!document.querySelector('.chats-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.chats-page.search-active')");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.side-head')).display"),'none','desktop preserves its split layout');
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.new-chat-button')).display"),'none','desktop keeps the new-chat shortcut');
    await capture('desktop-search');
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/app/games?theme=light'});
    await waitFor("document.querySelectorAll('.game-choice').length===8");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-games');
    await evaluate("[...document.querySelectorAll('.game-choice')].find(button=>button.textContent.includes('Reversi')).click()");
    await waitFor("document.querySelectorAll('.reversi-board button').length===36");
    await capture('mobile-reversi');
    await call('Page.navigate',{url:base+'/app/games?theme=light'});
    await waitFor("document.querySelectorAll('.game-choice').length===8");
    await evaluate("document.querySelector('.preview-controls').style.display='none';[...document.querySelectorAll('.game-choice')].find(button=>button.textContent.includes('Puntos')).click()");
    await waitFor("document.querySelectorAll('.dots-board button').length===12");
    await capture('mobile-dots');
    await call('Page.navigate',{url:base+'/app/world?theme=light'});
    await waitFor("!!document.querySelector('.world-search') && document.querySelectorAll('.story-bucket-row').length>3");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert.equal(await evaluate("document.querySelectorAll('.radar-panel, #friend-requests').length"),0,'Mundo focuses on stories while phone tools stay paused');
    await capture('mobile-world');
    assert(await evaluate("[...document.querySelectorAll('.story-open .story-avatar')].every(image=>{const a=image.getBoundingClientRect(),b=image.parentElement.getBoundingClientRect();return Math.abs(a.width-a.height)<1 && a.left-4>=b.left && a.right+4<=b.right;})"),'story avatar and its ring fit inside the open button');
    await call('Page.navigate',{url:base+'/app/world?theme=dark'});
    await waitFor("document.querySelectorAll('.story-bucket-row').length>3");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.story-bucket-row.viewed')).opacity"),'1','viewed stories retain readable contrast');
    await capture('mobile-world-dark');
    await call('Page.navigate',{url:base+'/preview/profile?theme=dark'});
    await waitFor("!!document.querySelector('.profile-hero')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await evaluate("(()=>{const a=document.querySelector('.profile-avatar-control').getBoundingClientRect(),b=document.querySelector('.profile-hero-copy').getBoundingClientRect();return a.right<=b.left;})()"),'profile avatar and identity stay alongside each other');
    await capture('mobile-profile-dark');
    await call('Page.navigate',{url:base+'/preview/profile?theme=light'});
    await waitFor("!!document.querySelector('.profile-hero')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-profile-light');
    await call('Page.navigate',{url:base+'/app/composer?theme=light'});
    await waitFor("!!document.querySelector('.source-text')");
    await tap('.source-text');
    await waitFor("document.querySelectorAll('.story-color').length===12");
    await tap('.story-color:nth-of-type(4)');
    assert(await evaluate("document.querySelectorAll('.story-color[aria-pressed=true]').length===1"),'selected theme is unambiguous');
    await capture('mobile-story-colors');
    await call('Page.navigate',{url:base+'/preview/viewer?theme=light'});
    await waitFor("!!document.querySelector('.story-text-content')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await evaluate("(()=>{const a=document.querySelector('.story-text-content').getBoundingClientRect(),b=document.querySelector('.story-viewer-top').getBoundingClientRect(),c=document.querySelector('.story-action-bar').getBoundingClientRect();return a.top>=b.bottom&&a.bottom<=c.top;})()"),'story text stays between the playback controls and replies');
    await capture('mobile-story-viewer');
    await viewport(1440,900,false);
    await call('Page.navigate',{url:base+'/app/world?theme=light'});
    await waitFor("document.querySelectorAll('.story-bucket-row').length>3");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-world');
    await call('Page.navigate',{url:base+'/app/invitation?theme=light'});
    await waitFor("!!document.querySelector('.game-invitation')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-game-invitation');
    await waitFor("!document.querySelector('preview-invitation p[role=status]')?.textContent.trim()");
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/app/chats?theme=light&incoming=voice'});
    await waitFor("!!document.querySelector('.incoming-call-card')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.incoming-call-card h2')).color"),'rgb(242, 251, 247)','incoming caller remains readable with the light theme');
    await capture('mobile-incoming-voice');
    await tap('.reply-call-toggle');
    await waitFor("document.querySelectorAll('.call-quick-replies button').length===3");
    await capture('mobile-call-quick-replies');
    await tap('.call-quick-replies button');
    await waitFor("!!document.querySelector('.call-result')");
    await capture('mobile-call-reply-result');
    await call('Page.navigate',{url:base+'/app/chats?theme=light&incoming=video'});
    await waitFor("!!document.querySelector('.video-incoming')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-incoming-video');
    await viewport(1440,900,false);
    await call('Page.navigate',{url:base+'/preview/calls?theme=light'});
    await waitFor("document.querySelectorAll('.history-row').length===6");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-call-history');
    await tap('.history-filters button:nth-child(2)');
    await waitFor("document.querySelectorAll('.history-row').length===2");
    assert.equal(await evaluate("document.querySelectorAll('.history-rejoin').length"),0,'missed calls cannot show rejoin');
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/preview/calls?theme=dark&mode=voice'});
    await waitFor("!!document.querySelector('.voice-connected')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-active-voice');
    await call('Page.navigate',{url:base+'/preview/calls?theme=dark&mode=video'});
    await waitFor("!!document.querySelector('.direct-video')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-active-video');
    await evaluate("document.querySelector('.minimize-call').focus()");
    await new Promise(resolve=>setTimeout(resolve,5500));
    assert.equal(await evaluate("!!document.querySelector('.call-chrome-hidden')"),false,'keyboard focus keeps video controls visible');
    await tap('.minimize-call');
    await waitFor("location.pathname==='/app/chats'");
    assert(await evaluate("!!document.querySelector('.active-call-banner') || document.body.textContent.includes('Volver a la llamada')"),'minimize keeps the active call available');
    await waitFor("!!document.querySelector('.ongoing-call') && !!document.querySelector('.mobile-message-fab')");
    assert(await evaluate("(()=>{const fab=document.querySelector('.mobile-message-fab'), sample=document.createElement('span'); sample.style.color='var(--nivra-brand)'; fab.appendChild(sample); const themed=getComputedStyle(fab).backgroundColor===getComputedStyle(sample).color; sample.remove(); return themed;})()"),'Contacts action uses the app theme color');
    assert(await evaluate("(()=>{const a=document.querySelector('.ongoing-call').getBoundingClientRect(),b=document.querySelector('.mobile-message-fab').getBoundingClientRect();return a.bottom<=b.top||a.right<=b.left||a.left>=b.right;})()"),'active call navigation must not cover Contacts');
    await evaluate("document.querySelector('.list').scrollTop=document.querySelector('.list').scrollHeight");
    await capture('mobile-call-and-contacts');
    assert(await evaluate("(()=>{const row=[...document.querySelectorAll('.conversation-item')].at(-1).getBoundingClientRect(),fab=document.querySelector('.mobile-message-fab').getBoundingClientRect();return row.bottom<=fab.top;})()"),'last chat remains fully accessible above Contacts when scrolled to the end');
    await call('Page.navigate',{url:base+'/app/communities?theme=light&id=community-preview'});
    await waitFor("document.querySelectorAll('.linked-group').length===2");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-community');
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'community layout fits the phone');
    await call('Page.navigate',{url:base+'/app/communities?theme=dark&create=1'});
    await waitFor("!!document.querySelector('.create-community')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-community-create-dark');
    await call('Page.navigate',{url:base+'/app/vault?theme=dark'});
    await waitFor("document.querySelectorAll('.room-card').length===2");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.create-room-cta');
    await waitFor("!!document.querySelector('.room-create-dialog')");
    await capture('mobile-vault-create-dark');
    assert(await evaluate("document.querySelector('.room-create-dialog').getBoundingClientRect().width<=innerWidth"),'room creation fits the phone');
    await viewport(1440,900,false);
    await call('Page.navigate',{url:base+'/app/communities?theme=light&id=community-preview'});
    await waitFor("document.querySelectorAll('.linked-group').length===2");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-community');
    await call('Page.navigate',{url:base+'/app/world?theme=light'});
    await waitFor("!!document.querySelector('.world-group-hub')");
    await evaluate("document.querySelector('.preview-controls').style.display='none';document.querySelector('.world-group-hub').open=true;document.querySelector('.world-group-hub').scrollIntoView()");
    await capture('desktop-community-hub');
    assert.equal(await evaluate("document.querySelectorAll('app-group-hub img.photo').length"),1,'group hub displays the actual group photo');
    await call('Page.navigate',{url:base+'/app/vault?theme=light'});
    await waitFor("!!document.querySelector('.vault-chat')");
    assert(await evaluate("(()=>{const a=document.querySelector('.room-list-panel').getBoundingClientRect(),b=document.querySelector('.room-workspace').getBoundingClientRect();return a.right<=b.left&&Math.abs(a.top-b.top)<2;})()"),'Vault rooms and chat share one desktop row');
    await evaluate("document.querySelector('.preview-controls').style.display='none';document.querySelector('.room-workspace').scrollIntoView()");
    await capture('desktop-vault-room');
    await evaluate("document.querySelector('.create-room-cta').scrollIntoView()");
    await tap('.create-room-cta');
    await waitFor("!!document.querySelector('.room-create-dialog')");
    await capture('desktop-vault-create');
    assert.deepEqual(errors,[],'preview must not throw runtime errors');
    console.log('PASS mobile search, Contacts, self notes entry and desktop layout; screenshots saved.');
  } finally { socket?.close(); chrome.kill(); server.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
