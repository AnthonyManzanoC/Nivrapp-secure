// Isolated Chrome profile. Network traffic is limited to the supplied local build.
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
      if (process.argv.includes('--public')) {
        await evaluate(`Promise.allSettled(document.getAnimations()
          .filter(animation => animation.playState === 'running' &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map(animation => animation.finished))`);
      }
      const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));
    };
    const viewport = (width,height,mobile) => call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    const backgroundUses = (selector, token) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const sample = document.createElement('span');
      sample.style.color = 'var(${token})';
      el.append(sample);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(sample).color;
      sample.remove();
      return matches;
    })()`);
    const tap = async selector => {
      // A newly attached Ionic modal can still be moving to its final position.
      await new Promise(resolve=>setTimeout(resolve,450));
      const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const holdChat = async (id, drag = false) => {
      const selector = `[data-chat-id="${id}"] .conversation-title`;
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',behavior:'instant'})`);
      await new Promise(resolve => setTimeout(resolve, 120));
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+Math.min(r.width/2,25), y:r.y+r.height/2 }; })()`);
      await call('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
      if (drag) await call('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:point.x,y:point.y-65}]});
      await new Promise(resolve => setTimeout(resolve, 620));
      await call('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    };
    if (process.argv.includes('--public')) {
      for (const [width, height, mobile, theme] of [[390, 844, true, 'light'], [1440, 900, false, 'dark']]) {
        await viewport(width, height, mobile);
        await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await call('Page.navigate', { url: base + '/' });
        await waitFor("!!document.querySelector('#hero-title')");
        await waitFor("document.documentElement.classList.contains(" + JSON.stringify(theme === 'dark' ? 'ion-palette-dark' : 'nivra-light-theme') + ")");
        await capture('production-landing-' + width + '-' + theme);
        await evaluate("document.querySelector('.hero-actions .primary').click()");
        if (mobile) {
          await waitFor("!!document.querySelector('#welcome-title')");
          await capture('production-welcome-' + width + '-' + theme);
          await evaluate("document.querySelector('.next-button').click()");
        }
        await waitFor("!!document.querySelector('#auth-title')");
        await capture('production-auth-' + width + '-' + theme);
        await evaluate("document.querySelector('.password-toggle').click()");
        await waitFor("document.querySelector('ion-input[name=password]').type === 'text'");
        await evaluate("document.querySelector('a[href$=\"/recover\"]').click()");
        await waitFor("!!document.querySelector('.recovery-card input[name=identifier]')");
        await evaluate("document.querySelector('.recovery-card summary').click()");
        await waitFor("!!document.querySelector('.recovery-card details[open]')");
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'production recovery fits the viewport');
        await capture('production-recovery-' + width + '-' + theme);
        await evaluate("document.querySelector('.back-link').click()");
        await waitFor("!!document.querySelector('#auth-title')");
      }
      assert.deepEqual(errors, [], 'guest routes should not throw runtime errors');
      console.log('PASS production web entry, welcome, sign-in controls and recovery in light and dark.');
      return;
    }
    if (!process.argv.includes('--v10-only')) {
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
    await call('Page.navigate',{url:base+'/app/contacts?theme=dark'});
    await waitFor("!!document.querySelector('.contacts-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await backgroundUses('.contact-shortcuts span','--nivra-selection'),'dark Contactos shortcuts use the selected surface');
    assert(await backgroundUses('.directory-tabs button[aria-pressed=true]','--nivra-selection'),'dark Contactos tab uses the selected surface');
    await capture('mobile-contacts-dark');
    await tap('.contacts-head button[aria-label="Buscar contactos"]');
    await waitFor("!!document.querySelector('.contacts-surface.searching')");
    assert(await backgroundUses('.people-panel .search-line','--nivra-bg-3'),'dark Contactos search has a dark surface after focus');
    await evaluate("(async()=>{const input=await document.querySelector('.search-line ion-input').getInputElement();input.value='sofia';input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));})()");
    await waitFor("!!document.querySelector('.search-clear')");
    await capture('mobile-contacts-search-dark');
    await tap('.search-clear');
    await waitFor("!document.querySelector('.search-clear')");
    await tap('.search-back');
    await waitFor("!document.querySelector('.contacts-surface.searching')");
    await tap('.directory-tabs button:nth-child(2)');
    await waitFor("!!document.querySelector('app-friend-requests .request-search')");
    assert(await backgroundUses('app-friend-requests .request-search','--nivra-bg-3'),'dark Solicitudes also uses the dark search surface');
    await capture('mobile-requests-dark');
    await call('Page.navigate',{url:base+'/app/chats?theme=dark'});
    await waitFor("!!document.querySelector('.search-box ion-input')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.chats-page.search-active')");
    await capture('mobile-search-dark');
    assert(await backgroundUses('.search-panel','--nivra-panel-solid'),'expanded dark Chats header uses the panel surface');
    assert(await backgroundUses('.search-box','--nivra-bg-3'),'expanded dark Chats input uses the dark control surface');
    await viewport(1440,900,false);
    await evaluate("localStorage.removeItem('nivra.navigation.rail-expanded')");
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("!!document.querySelector('.collapsible-rail .rail-toggle')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await evaluate("(()=>{const r=document.querySelector('.rail'),labels=[...r.querySelectorAll('.nav-btn>span:not(.nav-unread-badge),.rail-brand>span,.connection-label')];return r.getBoundingClientRect().width>=66&&r.getBoundingClientRect().width<=70&&labels.length===8&&labels.every(s=>getComputedStyle(s).fontSize==='10px'&&s.getBoundingClientRect().height>0)&&getComputedStyle(r.querySelector('.nav-btn')).flexDirection==='column';})()"),'compact desktop rail preserves 68px and visible 10px micro labels');
    await capture('desktop-rail-compact');
    await tap('.rail-toggle');
    await waitFor("document.querySelector('.rail-toggle').getAttribute('aria-expanded')==='true'&&document.querySelector('.rail').getBoundingClientRect().width>180");
    assert(await evaluate("getComputedStyle(document.querySelector('.rail .nav-btn')).flexDirection==='row'"),'expanded labels appear beside their icons');
    await capture('desktop-rail-expanded');
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("document.querySelector('.rail-toggle')?.getAttribute('aria-expanded')==='true'");
    await tap('.rail-toggle');
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("document.querySelector('.rail-toggle')?.getAttribute('aria-expanded')==='false'");
    await call('Page.navigate',{url:base+'/app/contacts?theme=light'});
    await waitFor("!!document.querySelector('.contacts-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await evaluate("document.querySelector('.rail a.active[aria-current]')?.getAttribute('href') === '/app/chats'"), 'the navigation keeps Chats selected inside Contacts');
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
    // Warm only the two pages actually visited. An inert same-session preview
    // then forms a real two-page corridor while the finger is still down.
    await tap('nav.rail a.nav-btn[href="/app/chats"]');
    await waitFor("!!document.querySelector('.chats-page')");
    await tap('nav.rail a.nav-btn[href="/app/world"]');
    await waitFor("!!document.querySelector('.world-surface')");
    const tabGestureY = await evaluate("(()=>{const r=document.querySelector('.world-surface .page-head h1').getBoundingClientRect();return r.top+r.height/2})()");
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:90,y:tabGestureY}]});
    await new Promise(resolve=>setTimeout(resolve,100));
    await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:150,y:tabGestureY}]});
    await new Promise(resolve=>setTimeout(resolve,100));
    await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:210,y:tabGestureY}]});
    assert(await evaluate("(()=>{const p=document.querySelector('[data-tab-preview=\"/app/chats\"]'),live=document.querySelector('.route-stage router-outlet').nextElementSibling;return !!p&&p.inert&&p.getAttribute('aria-hidden')==='true'&&!p.querySelector('[data-tab-preview-loading]')&&Math.abs(new DOMMatrix(getComputedStyle(live).transform).m41-120)<2&&Math.abs(p.getBoundingClientRect().width-innerWidth)<2&&location.pathname==='/app/world'})()"),'slow swipe follows the finger 1:1 and reveals a cached full-width adjacent tab before navigation');
    await capture('mobile-tabs-live-corridor');
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await waitFor("location.pathname==='/app/chats'&&!document.querySelector('[data-tab-preview]')");
    const chatGestureY = await evaluate("(()=>{const r=document.querySelector('.side-heading h1').getBoundingClientRect();return r.top+r.height/2})()");
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:300,y:chatGestureY}]});
    await new Promise(resolve=>setTimeout(resolve,120));
    await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:265,y:chatGestureY}]});
    assert(await evaluate("!!document.querySelector('[data-tab-preview=\"/app/world\"]')"),'a short drag still reveals the adjacent page while held');
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await waitFor("!document.querySelector('[data-tab-preview]')&&location.pathname==='/app/chats'");
    await tap('nav.rail a.nav-btn[href="/app/world"]');
    await waitFor("!!document.querySelector('.world-surface')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.stories-feed')).overflow"),'visible','rounded panel cannot clip the first letter in Mis historias');
    assert(await evaluate("[...document.querySelectorAll('.story-open .story-avatar')].every(image=>{const a=image.getBoundingClientRect(),b=image.parentElement.getBoundingClientRect();return Math.abs(a.width-a.height)<1 && a.left-4>=b.left && a.right+4<=b.right;})"),'story avatar and its ring fit inside the open button');
    await call('Page.navigate',{url:base+'/app/world?theme=dark'});
    await waitFor("document.querySelectorAll('.story-bucket-row').length>3");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.story-bucket-row.viewed')).opacity"),'1','viewed stories retain readable contrast');
    await capture('mobile-world-dark');
    assert(await evaluate("!document.querySelector('.world-group-hub').open && !!document.querySelector('.community-hub .view-all')"),'Communities can be opened without expanding groups');
    await tap('.world-communities-shortcut');
    await waitFor("!!document.querySelector('.community-directory .community-item')");
    await capture('mobile-community-directory-dark');
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
    await call('Page.navigate',{url:base+'/app/calls?theme=dark&mode=missed-voice'});
    await waitFor("!!document.querySelector('app-call-result.expanded-result .close-result')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert.equal(await evaluate("document.querySelectorAll('.result-actions button').length"),2,'outgoing result offers message and redial');
    await capture('mobile-outgoing-missed-voice');
    await viewport(320,568,true);
    assert(await evaluate("(()=>{const r=document.querySelector('.call-result').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"),'post-call actions fit a small phone');
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/app/calls?theme=light&mode=missed-video'});
    await waitFor("!!document.querySelector('app-call-result.expanded-result .video')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-outgoing-missed-video');
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
    await call('Page.navigate', { url: base + '/app/calls?theme=light&mode=video' });
    await waitFor("!!document.querySelector('.direct-video')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('desktop-active-video');
    await viewport(320, 568, true);
    await call('Page.navigate', { url: base + '/app/calls?theme=light&mode=reconnecting' });
    await waitFor("!!document.querySelector('.direct-video') && document.querySelector('.connection-state').textContent.includes('Reconectando')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    assert(await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.call-controls .call-action')];
      const boxes = buttons.map(button => button.getBoundingClientRect());
      const rail = document.querySelector('.workspace .rail');
      return getComputedStyle(rail).display === 'none' && boxes.length === 5 &&
        boxes.every(box => box.top === boxes[0].top && box.left >= 0 && box.right <= innerWidth &&
          box.bottom <= innerHeight && box.width >= 44);
    })()`), 'all five call actions fit a small screen in one row during reconnection');
    await capture('mobile-reconnecting-video');
    await call('Page.navigate', { url: base + '/app/calls?theme=dark&mode=failed' });
    await waitFor("!!document.querySelector('.connection-error ion-button')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-call-retry');
    await tap('.connection-error ion-button');
    await waitFor("!!document.querySelector('.direct-video') && !document.querySelector('.connection-error')");
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/preview/calls?theme=dark&mode=voice'});
    await waitFor("!!document.querySelector('.voice-connected')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-active-voice');
    await call('Page.navigate',{url:base+'/preview/calls?theme=dark&mode=video'});
    await waitFor("!!document.querySelector('.direct-video')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-active-video');
    await tap('.call-mic');
    await waitFor("document.querySelector('.call-mic').getAttribute('aria-pressed') === 'true'");
    await tap('.call-mic');
    await tap('.call-output');
    await waitFor("!!document.querySelector('.call-audio-modal [aria-labelledby=call-audio-title]')");
    await tap('.call-audio-routes button:nth-child(2)');
    await waitFor("document.querySelector('.call-output').getAttribute('aria-label').includes('Auriculares')");
    await capture('mobile-call-audio');
    await tap('.call-audio-sheet header ion-button');
    await waitFor("!document.querySelector('.call-audio-modal [aria-labelledby=call-audio-title]')");
    await tap('.call-more');
    await waitFor("!!document.querySelector('ion-modal ion-icon[name=person-add-outline]')");
    await capture('mobile-call-actions');
    await tap('ion-modal .call-audio-sheet header ion-button');
    await waitFor("!document.querySelector('ion-modal ion-icon[name=person-add-outline]')");
    await evaluate("document.activeElement.blur()");
    await new Promise(resolve=>setTimeout(resolve,5500));
    assert(await evaluate("getComputedStyle(document.querySelector('.call-controls')).pointerEvents !== 'none'"),
      'video controls stay reachable after inactivity');
    await evaluate("document.querySelector('.minimize-call').focus()");
    await new Promise(resolve=>setTimeout(resolve,5500));
    assert.equal(await evaluate("!!document.querySelector('.call-chrome-hidden')"),false,'keyboard focus keeps video controls visible');
    await tap('.minimize-call');
    await waitFor("location.pathname==='/app/chats'");
    await waitFor("!!document.querySelector('app-call-return-bar .return-action') && !!document.querySelector('.mobile-message-fab')");
    assert(await evaluate("document.querySelector('.call-return-bar').getAttribute('aria-label').includes('Volver')"),'minimize keeps the active call available');
    assert(await evaluate("(()=>{const fab=document.querySelector('.mobile-message-fab'), sample=document.createElement('span'); sample.style.color='var(--nivra-brand)'; fab.appendChild(sample); const themed=getComputedStyle(fab).backgroundColor===getComputedStyle(sample).color; sample.remove(); return themed;})()"),'Contacts action uses the app theme color');
    assert(await evaluate("(()=>{const a=document.querySelector('.call-return-bar').getBoundingClientRect(),b=document.querySelector('.mobile-message-fab').getBoundingClientRect();return a.bottom<=b.top||a.right<=b.left||a.left>=b.right;})()"),'active call navigation must not cover Contacts');
    await evaluate("document.querySelector('.list').scrollTop=document.querySelector('.list').scrollHeight");
    await capture('mobile-call-and-contacts');
    assert(await evaluate("(()=>{const row=[...document.querySelectorAll('.conversation-item')].at(-1).getBoundingClientRect(),fab=document.querySelector('.mobile-message-fab').getBoundingClientRect();return row.bottom<=fab.top;})()"),'last chat remains fully accessible above Contacts when scrolled to the end');
    await call('Page.navigate',{url:base+'/app/communities?theme=light&id=community-preview'});
    await waitFor("document.querySelectorAll('.linked-group').length===2");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-community');
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'community layout fits the phone');
    await tap('.mobile-back');
    await waitFor("!document.querySelector('.community-page.detail-open')");
    await capture('mobile-community-directory-light');
    await tap('.new-community');
    await waitFor("!!document.querySelector('.create-community')");
    await capture('mobile-community-create-light');
    await call('Page.navigate',{url:base+'/app/communities?theme=dark&create=1'});
    await waitFor("!!document.querySelector('.create-community')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-community-create-dark');
    await viewport(320,568,true);
    await evaluate("(async()=>{const s=await document.querySelector('.community-page').parentElement.getScrollElement();s.scrollTop=s.scrollHeight})()");
    assert(await evaluate("(()=>{const b=document.querySelector('.form-footer [type=submit]').getBoundingClientRect(),p=document.querySelector('.community-page').parentElement.getBoundingClientRect();return b.top>=p.top && b.bottom<=p.bottom;})()"),'community submit is above the app navigation on a small phone');
    await viewport(390,844,true);
    await evaluate("(()=>{const input=document.querySelector('.create-community [name=communityName]');input.value='Comunidad de prueba';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor("!document.querySelector('.form-footer [type=submit]').disabled");
    await evaluate("document.querySelector('.form-footer [type=submit]').click()");
    await waitFor("document.querySelector('.community-cover h2')?.textContent.includes('Comunidad de prueba')");
    await call('Page.navigate',{url:base+'/app/chats?theme=dark'});
    await waitFor("!!document.querySelector('.chat-heading-shortcuts .chat-communities-shortcut') && !document.querySelector('.conversation-list-stage .chat-communities-shortcut')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.chat-communities-shortcut');
    await waitFor("document.querySelector('.community-directory .back-link')?.getAttribute('href')==='/app/chats'");
    await tap('.community-directory .back-link');
    await waitFor("!!document.querySelector('[data-chat-id=community-preview].community-conversation')");
    await evaluate("document.querySelector('[data-chat-id=community-preview]').scrollIntoView({block:'nearest'})");
    await tap('[data-chat-id=community-preview] .conversation-title');
    await waitFor("document.querySelector('.community-cover h2')?.textContent.includes('Barrio Las Flores')");
    assert(await evaluate("document.querySelectorAll('.group-section').length===2"),'community shows joined and available groups separately');
    await waitFor("!!document.querySelector('.community-review-row')");
    await capture('mobile-community-requests-dark');
    await evaluate("document.querySelector('.community-review-row [aria-label^=Aceptar]').click()");
    await waitFor("!document.querySelector('.community-review-row')");
    await evaluate("document.querySelector('.linked-group [aria-label^=Solicitar]').click()");
    await waitFor("document.querySelector('.linked-group .group-request-state')?.textContent.includes('Pendiente')");
    assert(await evaluate("location.pathname==='/app/communities'"),'sending a request does not open the group');
    await tap('.mobile-back');
    await waitFor("!document.querySelector('.community-page.detail-open')");
    await tap('.community-directory .back-link');
    await waitFor("!!document.querySelector('[data-chat-id=sofia]')");
    await holdChat('sofia', true);
    assert.equal(await evaluate("document.querySelectorAll('.chat-selection-toolbar').length"),0,'scrolling a chat row does not select it');
    await holdChat('sofia');
    await waitFor("document.querySelector('.chat-selection-count strong')?.textContent==='1'");
    await tap('[data-chat-id=family] .conversation-title');
    await waitFor("document.querySelectorAll('.conversation-item.bulk-selected').length===2");
    assert(await evaluate("!location.pathname.includes('/app/chats/') && !document.querySelector('.mobile-message-fab')"),'selecting rows does not open a chat or obscure the list');
    assert(await evaluate("[...document.querySelectorAll('.chat-selection-mark')].every(mark=>{const a=mark.parentElement.getBoundingClientRect(),r=mark.getBoundingClientRect();return r.left>=a.left&&r.top>=a.top&&r.right<=a.right+3&&r.bottom<=a.bottom+3})"),'selection badge stays attached to each avatar');
    await capture('mobile-chat-selection-dark');
    await tap('.chat-selection-toolbar button[aria-label="Fijar chats seleccionados"]');
    await waitFor("!document.querySelector('.chat-selection-toolbar') && document.querySelector('[data-chat-id=sofia]').classList.contains('pinned') && document.querySelector('[data-chat-id=family]').classList.contains('pinned')");
    await holdChat('sofia');
    await waitFor("!!document.querySelector('.chat-selection-toolbar')");
    await tap('[data-chat-id=family] .conversation-title');
    await waitFor("document.querySelector('.chat-selection-count strong')?.textContent==='2'");
    await tap('.chat-selection-toolbar button[aria-label="Archivar chats seleccionados"]');
    await waitFor("!document.querySelector('[data-chat-id=sofia]') && !document.querySelector('[data-chat-id=family]')");
    // The preceding upward row gesture can fold the mobile controls. Reveal
    // them with a real downward gesture before choosing the archived folder.
    if (await evaluate("!!document.querySelector('.sidebar.mobile-header-collapsed')")) {
      const point = await evaluate("(() => { const r=document.querySelector('.conversation-list-stage .list').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+Math.min(80,r.height/3)}; })()");
      await call('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
      await call('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:point.x,y:point.y+70}]});
      await call('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      await waitFor("!document.querySelector('.sidebar.mobile-header-collapsed')");
    }
    await tap('.chat-folders button:last-child');
    await waitFor("!!document.querySelector('[data-chat-id=sofia]')");
    await holdChat('sofia');
    await waitFor("!!document.querySelector('.chat-selection-toolbar')");
    await tap('.bulk-delete-action');
    await waitFor("!!document.querySelector('.bulk-chat-delete-dialog')");
    assert(await evaluate("!!document.querySelector('[data-chat-id=sofia]')"),'opening confirmation does not delete the chat');
    await tap('.bulk-chat-delete-dialog .bulk-delete-confirm');
    await waitFor("!document.querySelector('[data-chat-id=sofia]') && !document.querySelector('.chat-selection-toolbar')");
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
    await call('Page.navigate',{url:base+'/app/vault?theme=light&vaultNotes=1'});
    await waitFor("document.querySelectorAll('.notes-panel .vault-row').length===2");
    await evaluate("document.querySelector('.preview-controls').style.display='none';document.querySelector('.notes-panel').scrollIntoView({block:'center'})");
    assert(await evaluate("(()=>{const notes=document.querySelector('.notes-panel').getBoundingClientRect(),grid=document.querySelector('.vault-surface>.grid').getBoundingClientRect(),cards=[...document.querySelectorAll('.notes-panel .vault-row')].map(e=>e.getBoundingClientRect());return Math.abs(notes.width-grid.width)<2&&Math.abs(cards[0].top-cards[1].top)<2&&cards[0].right<=cards[1].left;})()"),'unlocked Vault notes fill the desktop grid with both columns');
    await capture('desktop-vault-notes');
    await evaluate("document.querySelector('.vault-key-state ion-button').click()");
    await waitFor("!document.querySelector('.notes-panel')&&!document.querySelector('.note-composer-panel')");
    assert(await evaluate("!document.body.textContent.includes('Ideas para mañana')&&!document.body.textContent.includes('Lista de tareas')"),'locking removes note contents and metadata from the DOM');
    await capture('desktop-vault-locked');
    await evaluate("document.querySelector('.create-room-cta').scrollIntoView()");
    await tap('.create-room-cta');
    await waitFor("!!document.querySelector('.room-create-dialog')");
    await capture('desktop-vault-create');
    for(const theme of ['light','dark']){
      await viewport(390,844,true);
      await call('Page.navigate',{url:base+'/app/communities?theme='+theme+'&id=community-preview&info=1'});
      await waitFor("document.querySelectorAll('.community-member').length===2");
      assert(await evaluate("[...document.querySelectorAll('.linked-group .item-copy')].every(item=>item.getBoundingClientRect().width>=120)"),'community group names retain readable space beside their actions');
      await evaluate("document.querySelector('.preview-controls').style.display='none';document.querySelector('.community-members').scrollIntoView()");
      await capture('mobile-community-members-'+theme);
      await evaluate("document.querySelector('.community-actions .primary').click()");
      await waitFor("!!document.querySelector('app-group-invite-share')");
      await evaluate("document.querySelector('app-group-invite-share button').click()");
      await waitFor("!!document.querySelector('app-group-invite-share input[readonly]')");
      await evaluate("document.querySelector('app-group-invite-share .actions button:last-child').click();document.querySelector('app-group-invite-share').scrollIntoView()");
      await waitFor("document.querySelectorAll('app-group-invite-share .target').length>1");
      await capture('mobile-community-invitation-'+theme);
      await call('Page.navigate',{url:base+'/preview/recovery?theme='+theme});
      await waitFor("!!document.querySelector('app-account-identity-recovery input[type=password]')");
      await evaluate("document.querySelector('.preview-controls').style.display='none'");
      await capture('mobile-account-recovery-'+theme);
      assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'recovery controls fit a phone');
    }
    for (const [width,height,mobile] of [[390,844,true],[1440,900,false]]) {
      await viewport(width,height,mobile);
      for (const theme of ['light','dark']) {
        await call('Page.navigate',{url:base+'/app/guide?theme='+theme});
        await waitFor("document.querySelectorAll('.guide .tasks article').length===5");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert.equal(await evaluate("document.querySelectorAll('.guide .features details').length"),16,'all features are explained');
        assert.equal(await evaluate("document.querySelectorAll('.guide .tasks article:not([hidden])').length"),1,'guide begins with one manageable step');
        await evaluate("document.querySelector('.next-step').scrollIntoView({block:'center'})");
        await tap('.next-step');
        await waitFor("document.querySelector('.step-dots button:nth-child(2)')?.getAttribute('aria-current')==='step'");
        await tap('.guide-tabs button:nth-child(2)');
        await waitFor("!document.querySelector('#guide-features').hidden&&document.querySelector('#guide-start').hidden");
        await tap('.guide-tabs button:nth-child(3)');
        await waitFor("!document.querySelector('#guide-delivery').hidden&&document.querySelector('#guide-features').hidden");
        await capture('guide-help-'+width+'-'+theme);
        await tap('.guide-tabs button:first-child');
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'guide fits viewport');
        await capture('guide-'+width+'-'+theme);
        await call('Page.navigate',{url:base+'/app/notification-check?theme='+theme});
        await waitFor("!!document.querySelector('app-notification-check li')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'notification check fits viewport');
        await capture('notification-check-'+width+'-'+theme);
        await call('Page.navigate',{url:base+'/app/vault?room=incognito-preview&mode=incognito&theme='+theme});
        await waitFor("!!document.querySelector('.incognito-view .vault-chat')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.incognito-view .unlock-panel')).display"),'none','incognito hides unrelated Vault panels');
        assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),'temporary chat fits viewport');
        assert(await evaluate("(()=>{const c=document.querySelector('.vault-chat').getBoundingClientRect();const s=document.querySelector('.vault-input-area').getBoundingClientRect();return c.height>150 && s.top>=c.bottom-2;})()"),'composer remains below the message timeline');
        await capture('incognito-'+width+'-'+theme);
        await call('Page.navigate',{url:base+'/preview/incognito-dialog?theme='+theme});
        await waitFor("!!document.querySelector('#preview-open-incognito')");
        await evaluate("document.querySelector('#preview-open-incognito').click()");
        await waitFor("!!document.querySelector('ion-modal.nivra-incognito-modal .incognito-confirm')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert(await evaluate("(()=>{const r=document.querySelector('.nivra-incognito-modal .incognito-confirm').getBoundingClientRect();return r.height<550 && r.left>=0 && r.right<=innerWidth;})()"),'confirmation has a compact readable layout');
        await capture('incognito-dialog-'+width+'-'+theme);
        const launchScreens = [
          ['landing', '/', '#hero-title', '.hero-actions .primary'],
          ['welcome', '/welcome', '#welcome-title', '.next-button'],
          ['auth', '/auth', '#auth-title', '.auth-panel ion-button[type=submit]'],
          ['recover', '/recover', '.recovery-card h1', '.recovery-card ion-button'],
          ['share', '/app/share', '.target-list button', '.send-bar .send'],
        ];
        for (const [name, route, ready, action] of launchScreens) {
          await call('Page.navigate', { url: base + route + '?theme=' + theme });
          await waitFor('!!document.querySelector(' + JSON.stringify(ready) + ')');
          await evaluate("document.querySelector('.preview-controls').style.display='none'");
          await waitFor('!!document.querySelector(' + JSON.stringify(action) + ')');
          const fits = await evaluate(`(() => {
            const rect = document.querySelector(${JSON.stringify(action)}).getBoundingClientRect();
            return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1 &&
              document.documentElement.scrollWidth <= innerWidth;
          })()`);
          assert(fits, name + ' primary action fits at ' + width + 'px in ' + theme);
          if (name === 'share') {
            assert(await evaluate("document.querySelector('.send-bar .send').disabled"), 'sharing needs a recipient');
            await evaluate("document.querySelector('.target-list button').click()");
            await waitFor("document.querySelector('.target-list button').getAttribute('aria-pressed') === 'true' && !document.querySelector('.send-bar .send').disabled");
          }
          await capture('launch-' + name + '-' + width + '-' + theme);
          if (name === 'share') {
            await evaluate(`(() => {
              const note = document.querySelector('ion-textarea textarea');
              note.value = '';
              note.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await waitFor("document.querySelector('.send-bar .send').disabled");
          }
        }
      }
    }
    }
    for(const [width,height,mobile] of [[390,844,true],[1440,900,false]]){
      await viewport(width,height,mobile);
      for(const theme of ['light','dark']){
        await call('Page.navigate',{url:base+'/app/chats?theme='+theme+'&active-call=1'});
        await waitFor("!!document.querySelector('app-call-return-bar .call-return-bar')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert.equal(await evaluate("document.querySelectorAll('app-call-return-bar').length"),1,'one call return bar is rendered');
        assert(await evaluate("(()=>{const a=document.querySelector('.call-return-bar').getBoundingClientRect(),h=document.querySelector('.side-head').getBoundingClientRect();return a.left>=0&&a.right<=innerWidth+1&&a.bottom<=h.top+1;})()"),'call return bar occupies its own row above Chats without covering the header');
        assert(await evaluate("getComputedStyle(document.querySelector('.chat-communities-shortcut')).boxShadow==='none'"),'Communities has a neutral button without a green shadow');
        await capture('call-return-'+width+'-'+theme);
        await call('Page.navigate',{url:base+'/app/chats/sofia?theme='+theme+'&privacy=1'});
        await waitFor("!!document.querySelector('.privacy-marker.expiry time[datetime]')&&!!document.querySelector('.privacy-marker.once')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        assert(await evaluate("[...document.querySelectorAll('.privacy-marker')].every(marker=>{const r=marker.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1;})"),'expiry and one-view markers fit the chat');
        await capture('message-privacy-'+width+'-'+theme);
        await call('Page.navigate',{url:base+'/preview/schedule?theme='+theme});
        await waitFor("!!document.querySelector('.schedule-open')");
        await evaluate("document.querySelector('.preview-controls').style.display='none'");
        await tap('.schedule-open');
        await waitFor("!!document.querySelector('app-scheduled-text-control dialog[open]')");
        assert(await evaluate("(()=>{const d=document.querySelector('app-scheduled-text-control dialog').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth+1&&d.top>=0&&d.bottom<=innerHeight;})()"),'scheduling dialog fits the viewport');
        assert(await evaluate("document.querySelector('.explanation').textContent.includes('desbloqueada')"),'scheduling explains its local unlocked-session requirement');
        await capture('schedule-dialog-'+width+'-'+theme);
        await tap('.presets button:first-child');
        await tap('app-scheduled-text-control .confirm');
        await waitFor("!!document.querySelector('.scheduled-list')&&!document.querySelector('dialog[open]')");
        await tap('.scheduled-list summary');
        assert(await evaluate("!!document.querySelector('.scheduled-list time[datetime]')"),'scheduled text keeps a visible absolute delivery time');
        await capture('schedule-saved-'+width+'-'+theme);
        await tap('.scheduled-list article button');
        await waitFor("!document.querySelector('.scheduled-list')");
      }
    }
    assert.deepEqual(errors,[],'preview must not throw runtime errors');
    console.log(process.argv.includes('--v10-only')
      ? 'PASS v10 call return, privacy markers and local scheduling; screenshots saved.'
      : 'PASS isolated mobile/desktop design, tab gestures, call return, message privacy and local scheduling; screenshots saved.');
  } finally { socket?.close(); chrome.kill(); server.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
