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
  ], { stdio:'ignore' });
  let socket;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(port, 'Chrome did not start');
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
      const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    await viewport(390,844,true);
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("!!document.querySelector('.chats-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await capture('mobile-chats');
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.chats-page.search-active')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.side-head')).display"),'none','mobile search replaces Chats heading');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.rail')).display"),'none','mobile search hides bottom navigation');
    assert(await evaluate("document.querySelector('.search-box').getBoundingClientRect().top < 40"),'search uses the top of the screen');
    await capture('mobile-search');
    await evaluate("document.querySelector('.search-back').click()");
    await waitFor("!document.querySelector('.chats-page.search-active')");
    await evaluate("document.querySelector('.new-chat-button').click()");
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
    await call('Page.navigate',{url:base+'/app/chats?theme=light'});
    await waitFor("!!document.querySelector('.chats-page')");
    await evaluate("document.querySelector('.preview-controls').style.display='none'");
    await tap('.search-box ion-input');
    await waitFor("!!document.querySelector('.chats-page.search-active')");
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.side-head')).display"),'none','desktop preserves its split layout');
    await capture('desktop-search');
    assert.deepEqual(errors,[],'preview must not throw runtime errors');
    console.log('PASS mobile search, Contacts, self notes entry and desktop layout; screenshots saved.');
  } finally { socket?.close(); chrome.kill(); server.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
