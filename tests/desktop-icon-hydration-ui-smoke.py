"""Measure retained browser frames while slow icon work loads and scrolls."""
import functools
import http.server
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = '<!doctype html><html><head><link rel="stylesheet" href="/__icon_probe__.css"></head><body><main id="visible"></main><section id="scroll"></section><script type="module" src="/__icon_probe__.js"></script></body></html>'
CSS = 'body{margin:0}#visible{display:grid;grid-template-columns:repeat(10,60px);gap:4px;height:80px}#scroll{width:320px;height:240px;overflow:auto;display:grid;grid-template-columns:repeat(3,100px);grid-auto-rows:80px;gap:4px}.file-item{display:grid;place-items:center;min-height:72px;padding:0}.file-icon{display:block;width:32px;height:32px}img{width:32px;height:32px}'
JS = r"""
import {createIconHydrator} from '/src/desktop-organizer/icon-hydration.js';
window.__audit={active:0,peak:0,calls:[],gaps:[],phase:'first'};
const icon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let last=performance.now();function tick(now){__audit.gaps.push({phase:__audit.phase,gap:now-last});last=now;requestAnimationFrame(tick)}requestAnimationFrame(tick);
const invoke=async(_,args)=>{__audit.active++;__audit.peak=Math.max(__audit.peak,__audit.active);__audit.calls.push(args.path);await new Promise(resolve=>setTimeout(resolve,80));__audit.active--;return icon;};
const hydrator=createIconHydrator({invoke,document,window});
const create=(parent,path)=>{const item=document.createElement('button');item.type='button';item.className='file-item';item.dataset.appId=path;item.dataset.path=path;item.innerHTML='<span class="file-icon"></span>';parent.append(item);return item;};
for(let index=0;index<10;index++)create(document.querySelector('#visible'),'first-'+index);
create(document.querySelector('#visible'),'first-0');
hydrator.hydrate(document.querySelector('#visible'));
window.__hydrator=hydrator;window.__create=create;
window.__ready=true;
"""

def main():
    handler=functools.partial(http.server.SimpleHTTPRequestHandler,directory=str(ROOT))
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True)
            page=browser.new_page(viewport={'width':1000,'height':800})
            page.route('**/__icon_probe__.html',lambda route:route.fulfill(body=HTML,content_type='text/html'))
            page.route('**/__icon_probe__.css',lambda route:route.fulfill(body=CSS,content_type='text/css'))
            page.route('**/__icon_probe__.js',lambda route:route.fulfill(body=JS,content_type='application/javascript'))
            errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/__icon_probe__.html')
            page.wait_for_function('window.__ready')
            page.wait_for_function("document.querySelectorAll('#visible [data-icon-loaded]').length===11")
            first=page.evaluate("({...__audit,gaps:__audit.gaps.filter(frame=>frame.phase==='first').map(frame=>frame.gap)})")
            assert first['peak']==4,first
            assert len(first['calls'])==10,first
            assert first['calls'].count('first-0')==1,first
            assert len(first['gaps'])>=10,first
            assert max(first['gaps'][2:])<50,first
            page.evaluate("""() => { __audit.phase='scroll';const scroll=document.querySelector('#scroll');for(let index=0;index<217;index++)__create(scroll,'app-'+index);__hydrator.hydrate(scroll); }""")
            page.wait_for_function("document.querySelector('#scroll [data-path=\"app-0\"]').dataset.iconLoaded==='true'")
            initial_count=page.locator('#scroll [data-icon-loaded]').count()
            assert initial_count<96,initial_count
            page.locator('#scroll').evaluate('scroll=>scroll.scrollTop=scroll.scrollHeight')
            page.wait_for_function("document.querySelector('#scroll [data-path=\"app-216\"]').dataset.iconLoaded==='true'")
            last=page.evaluate("({peak:__audit.peak,totalRequests:__audit.calls.length,lastLoaded:document.querySelector('#scroll [data-path=\"app-216\"]').dataset.iconLoaded,tailCount:[...document.querySelectorAll('#scroll [data-app-id]')].slice(-12).filter(item=>item.dataset.iconLoaded).length,initialCount:"+str(initial_count)+"})")
            assert last['peak']==4 and last['tailCount']>0,last
            assert not errors,errors
            page.evaluate('__hydrator.destroy()')
            browser.close()
            print(json.dumps({'slowFirstBatch':{'requests':len(first['calls']),'peak':first['peak'],'frames':len(first['gaps']),'maxGapAfterStartup':round(max(first['gaps'][2:]),2)},'scroll217':last}))
    finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
