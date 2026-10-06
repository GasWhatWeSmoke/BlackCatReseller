module.exports=function(source){
 const scope='fixture_'+require('node:path').basename(this.resourcePath).replace(/\W/g,'_')+'_';
 const names=[...new Set([...source.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match=>match[1]))];
 const css=source.replace(/\.([A-Za-z_][\w-]*)/g,(_match,name)=>'.'+scope+name);
 return `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);module.exports=${JSON.stringify(Object.fromEntries(names.map(name=>[name,scope+name])))};`;
};
