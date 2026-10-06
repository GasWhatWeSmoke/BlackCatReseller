import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const source=ts.transpileModule(fs.readFileSync('src/components/ListingVerification.tsx','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;

function elements(node:any):any[] {
  if(!node || typeof node!=='object')return [];
  return [node,...[node.props?.children].flat().flatMap(elements)];
}

for(const conflict of [false,true])test(`verification sends the displayed revision and ${conflict?'clears stale confirmation':'refreshes after success'}`,async()=>{
  const states:unknown[]=['',true,false];let index=0,refreshes=0;
  const messages:string[]=[],requests:{url:string;body:any}[]=[];
  const modules:Record<string,unknown>={
    react:{useState:()=>{const i=index++;return [states[i],(value:unknown)=>{states[i]=value;}];},useRef:(value:unknown)=>({current:value})},
    'react/jsx-runtime':jsx,
    sonner:{toast:{success:(message:string)=>messages.push(message),error:(message:string)=>messages.push(message)}},
  };
  const exports:Record<string,any>={};
  vm.compileFunction(source,['exports','require','fetch'])(exports,(name:string)=>{
    assert.ok(Object.hasOwn(modules,name),name);return modules[name];
  },async(url:string,options:{body:string})=>{
    requests.push({url,body:JSON.parse(options.body)});
    return {ok:!conflict,status:conflict?409:200,json:async()=>conflict?{ok:false,error:'This publication attempt changed.'}:{ok:true}};
  });
  const rendered=exports.default({jobId:12,sku:'TEST',marketplace:'Depop',revision:'displayed-attempt',onResolved:async()=>{refreshes++;}});
  const button=elements(rendered).find(node=>node.type==='button'&&node.props.children==='Confirm not published');
  assert.equal(button.props.disabled,false);
  button.props.onClick();
  button.props.onClick(); // An in-flight click cannot submit twice.
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,[{url:'/api/publish/jobs/12/resolve',body:{outcome:'not_published',url:'',confirmed:true,expectedRevision:'displayed-attempt'}}]);
  assert.equal(refreshes,1);assert.equal(states[2],false);
  if(conflict){assert.equal(states[1],false);assert.equal(states[0],'');assert.deepEqual(messages,['This publication attempt changed.']);}
  else assert.deepEqual(messages,['Verified not published. You can now retry.']);
});
