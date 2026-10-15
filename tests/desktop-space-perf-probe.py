"""Read-only desktop space performance probe, with a disposable native bridge."""
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('desktop_perf_helper', ROOT / 'tests/desktop-presentation-ui-smoke.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
OUT = Path(tempfile.mkdtemp(prefix='dtkit-desktop-perf-'))
SEED = r"""
localStorage.setItem('dtkit_desktop_organizer', JSON.stringify({enabled:true,presentation:'space',layout:'islands',appearance:'liquid',reducedMotion:false}));
window.__probe = {longTasks:[],frames:[],html:[],mutations:0,animations:[],regions:[]};
new PerformanceObserver(list => window.__probe.longTasks.push(...list.getEntries().map(entry=>({at:entry.startTime,duration:entry.duration})))).observe({type:'longtask',buffered:true});
let last=performance.now(); function tick(now){window.__probe.frames.push({at:now,gap:now-last});last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
const originalAnimate=Element.prototype.animate;
Element.prototype.animate=function(frames,options){window.__probe.animations.push({at:performance.now(),className:this.className,keys:Object.keys(frames[0]||{}),duration:options?.duration});return originalAnimate.call(this,frames,options);};
const originalHtml=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
Object.defineProperty(Element.prototype,'innerHTML',{...originalHtml,set(value){const start=performance.now();originalHtml.set.call(this,value);window.__probe.html.push({at:start,id:this.id,className:this.className,length:value.length,duration:performance.now()-start});}});
document.addEventListener('DOMContentLoaded',()=>new MutationObserver(list=>window.__probe.mutations+=list.length).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','hidden','aria-expanded']}));
const invoke=window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke=async(command,args)=>{if(command==='desktop_space_set_regions') window.__probe.regions.push({at:performance.now(),count:args.regions.length});const result=await invoke(command,args);if(command==='desktop_scan'&&window.__largeFixture){const first=result.applications[0];result.applications=Array.from({length:217},(_,index)=>({...first,app_id:'app-'+index,path:'C:/Tools/app-'+index+'.exe',name:'Application '+index}));result.total_count+=216;}return result;};
"""

def metrics(cdp):
    return {item['name']:item['value'] for item in cdp.send('Performance.getMetrics')['metrics']}

def measure(page, cdp, name, action):
    before=metrics(cdp)
    start=page.evaluate('performance.now()')
    action()
    page.wait_for_timeout(100)
    end=page.evaluate('performance.now()')
    after=metrics(cdp)
    probe=page.evaluate('window.__probe')
    frames=[entry['gap'] for entry in probe['frames'] if start<=entry['at']<=end]
    frames.sort()
    return {'scenario':name,'wallMs':round(end-start,1),'frames':len(frames),'maxFrameGap':round(max(frames,default=0),2),'p95FrameGap':round(frames[min(len(frames)-1,int(len(frames)*.95))],2) if frames else 0,'over33ms':sum(gap>33 for gap in frames),'longTasks':[entry for entry in probe['longTasks'] if start<=entry['at']<=end],
            'domWrites':[entry for entry in probe['html'] if start<=entry['at']<=end], 'regionCalls':len([entry for entry in probe['regions'] if start<=entry['at']<=end]),
            'animations':[entry for entry in probe['animations'] if start<=entry['at']<=end],
            'cpu':{key:round((after[key]-before[key])*(1000 if key.endswith('Duration') else 1),3) for key in ['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration']}}

def main():
    base,close=helper.local_test_url()
    results=[]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True)
            for large in (False,True):
                context=browser.new_context(viewport={'width':1440,'height':900})
                context.add_init_script(helper.MOCK_TAURI+'\n'+SEED+f'\nwindow.__largeFixture={str(large).lower()};')
                page=context.new_page()
                page.goto(base+'/desktop-organizer/index.html?host=desktop',wait_until='networkidle')
                page.wait_for_function("Number(getComputedStyle(document.querySelector('#panel')).opacity)===1")
                cdp=context.new_cdp_session(page);cdp.send('Performance.enable')
                prefix='217_apps' if large else '16_items'
                def hover():
                    blocks=page.locator('.space-block').all()[:3]
                    for _ in range(5):
                        for block in blocks:
                            box=block.bounding_box();page.mouse.move(box['x']+box['width']/2,box['y']+45);page.wait_for_timeout(100)
                    page.mouse.move(50,50);page.wait_for_timeout(300)
                results.append({'fixture':prefix,**measure(page,cdp,'hover_15_entries',hover)})
                target='.space-block[data-space-group="program"] .space-folder-surface'
                def popup():
                    for _ in range(5):
                        page.locator(target).click();page.wait_for_timeout(460)
                        page.locator('.space-popup [data-space-close]').click();page.wait_for_timeout(310)
                results.append({'fixture':prefix,**measure(page,cdp,'popup_5_cycles',popup)})
                if large:
                    page.locator(target).click();page.wait_for_timeout(500)
                    page.locator('.space-popup .space-file-grid').evaluate('grid=>grid.scrollTop=grid.scrollHeight')
                    page.wait_for_timeout(500)
                    results.append({'fixture':prefix,'scenario':'icons_after_scroll_to_bottom',**page.evaluate("""() => {
                        const icons=[...document.querySelectorAll('.space-popup [data-space-icon][data-app-id]')];
                        return {total:icons.length,markedLoaded:icons.filter(icon=>icon.dataset.iconLoaded).length,
                          tailMarkedLoaded:icons.slice(-12).filter(icon=>icon.dataset.iconLoaded).length,
                          iconIpc:window.__calls.filter(call=>call.command==='desktop_get_app_icon').length};
                    }""")})
                    page.locator('.space-popup [data-space-close]').click();page.wait_for_timeout(350)
                def furniture():
                    box=page.locator('.space-block[data-space-group="document"] .space-caption').bounding_box()
                    x=box['x']+box['width']/2;y=box['y']+box['height']/2
                    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-350,y+150,steps=60);page.mouse.up();page.wait_for_timeout(300)
                results.append({'fixture':prefix,**measure(page,cdp,'furniture_60_moves',furniture)})
                def layout():
                    for kind,value in [('layout','zones'),('layout','drawer'),('layout','islands'),('appearance','warm'),('appearance','liquid')]:
                        helper.choose(page,kind,value);page.wait_for_timeout(540)
                results.append({'fixture':prefix,**measure(page,cdp,'3_layouts_2_materials',layout)})
                if os.environ.get('DTKIT_PROBE_TRANSFORM'):
                    page.locator('#appearanceBtn').click()
                    page.evaluate(r"""() => {
                      const original=Element.prototype.animate;
                      Element.prototype.animate=function(frames,options) {
                        if(this.classList.contains('space-motion-material')) {
                          const base=frames.at(-1),x=parseFloat(base.left),y=parseFloat(base.top),w=parseFloat(base.width),h=parseFloat(base.height);
                          this.style.left=base.left;this.style.top=base.top;this.style.width=base.width;this.style.height=base.height;this.style.transformOrigin='0 0';
                          frames=frames.map(f=>({offset:f.offset,opacity:f.opacity,borderRadius:f.borderRadius,transform:`translate(${parseFloat(f.left)-x}px,${parseFloat(f.top)-y}px) scale(${parseFloat(f.width)/w},${parseFloat(f.height)/h})`}));
                        }
                        return original.call(this,frames,options);
                      }
                    }""")
                    results.append({'fixture':prefix,**measure(page,cdp,'runtime_transform_glass_popup_5_cycles',popup)})
                context.close()
            browser.close()
    finally:close()
    (OUT/'report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    for result in results:
        text={key:value for key,value in result.items() if key not in ('animations','domWrites')}
        text['domWrites']=[{key:item[key] for key in ('id','className','length','duration')} for item in result.get('domWrites',[])]
        text['animationCount']=len(result.get('animations',[]))
        print(json.dumps(text,ensure_ascii=False))
    print(f'PROBE_REPORT={OUT / "report.json"}')

if __name__=='__main__':main()
