import assert from 'node:assert/strict';
import test from 'node:test';
import { bounds, visualBounds, penGeometry, editHistory, fitsHistory, toWorld, snapPosition, layoutNodes, diffOperations, validateExportSize, exportArea, selectionArea } from '../src/tools/clipboard-puzzle/model.js';

const nodes = [{id:'a',x:100,y:120,w:200,h:150},{id:'b',x:350,y:300,w:80,h:40}];
test('screen coordinates and region selection remain correct after pan and zoom',()=>{
    assert.deepEqual(toWorld({x:420,y:380},{left:20,top:30},{x:100,y:50,z:2}),{x:150,y:150});
    assert.deepEqual(selectionArea({x:80,y:90},{x:20,y:10}),{x:20,y:10,w:60,h:80});
});
test('snap threshold is measured in screen pixels and Alt bypass is exact',()=>{
    const source = [nodes[0]], target = [{x:400,y:200,w:200,h:200}];
    assert.equal(snapPosition(source,target,396,196,1).x,400);
    assert.equal(snapPosition(source,target,395,195,2).x,395);
    assert.deepEqual(snapPosition(source,target,396,196,1,false),{x:396,y:196,lines:[]});
});
test('layout retains content IDs and separates each row by a gap',()=>{
    const result=layoutNodes(nodes,'vertical');assert.equal(result[1].y,result[0].y+result[0].h+24);
    assert.deepEqual(result.map(n=>n.id),['a','b']);assert.equal(nodes[1].y,300);
});
test('edits send only touched objects, preserving independently arriving captures',()=>{
    const after=[{...nodes[0],x:140},nodes[1]];
    assert.deepEqual(diffOperations(nodes,after),[{type:'upsert',nodes:[after[0]]}]);
    assert.deepEqual(diffOperations(nodes,[nodes[1]]),[{type:'remove',ids:['a']}]);
});
test('exports exclude unused canvas space and reject oversized allocations',()=>{
    assert.deepEqual(bounds(nodes),{x:100,y:120,w:330,h:220});
    const task={nodes,frame:{x:0,y:0,w:900,h:600}};
    assert.deepEqual(exportArea(task,new Set(['b']),'selected'),{x:334,y:284,w:112,h:72});
    assert.throws(()=>validateExportSize({w:8000,h:8000},1),/导出区域过大/);
    assert.deepEqual(validateExportSize({w:400,h:300},2),{w:800,h:600});
});
test('pen bounds include the whole closed or backward stroke rather than its endpoints',()=>{
    const points=[{x:100,y:100},{x:160,y:80},{x:40,y:140},{x:100,y:100}];
    const stroke=penGeometry(points);
    assert.deepEqual({x:stroke.x,y:stroke.y,w:stroke.w,h:stroke.h},{x:37,y:77,w:126,h:66});
    assert.deepEqual(stroke.points.map(p=>({x:p.x+stroke.x,y:p.y+stroke.y})),points);
    assert.deepEqual(penGeometry([{x:10,y:20},{x:50,y:20}]).h,6);
});
test('visual bounds include rotated image corners without clipping or altering source geometry',()=>{
    const image={type:'image',x:100,y:120,w:200,h:100,rotation:90};
    assert.deepEqual(visualBounds(image),{x:150,y:70,w:100,h:200});
    assert.equal(image.x,100);
});
test('cut history budget accounts for original editable content and ignores concurrent untouched captures',()=>{
    const source={id:'large',type:'text',body:'字'.repeat(1_500_000),originalBody:'字'.repeat(1_500_000)};
    const replacement={id:'large',type:'image',assetId:'residual'},region={id:'region',type:'image',assetId:'region-image'};
    const operations=[{type:'upsert',nodes:[replacement,region]}];
    const history=editHistory([source],[replacement,region,{id:'concurrent',type:'text',body:'其他窗口收集'}],operations);
    assert.equal(fitsHistory(history),false);
    assert.deepEqual(history.inverse.map(op=>op.ids||op.nodes.map(n=>n.id)),[['region'],['large']]);
    source.body='字'.repeat(1_400_000);source.originalBody='字'.repeat(1_400_000);
    assert.equal(fitsHistory(editHistory([source],[replacement,region],operations)),true);
});
