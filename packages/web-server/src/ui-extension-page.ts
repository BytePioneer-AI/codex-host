import { WEB_EXTENSIONS_RPC } from "@codexhost/shared-contracts";

/** Recovery management stays available without the DSH shell or any installed extension. */
export const UI_EXTENSION_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web extensions · codexhost</title><style>
:root{color-scheme:light dark;font:16px/1.5 system-ui}body{max-width:850px;margin:40px auto;padding:0 20px}a{color:LinkText}input,button,select{font:inherit;padding:8px 12px}input{min-width:0}form{display:grid;gap:12px}label{display:grid;gap:4px}label[hidden]{display:none}article{padding:16px 0;border-bottom:1px solid #8885}article p{margin:6px 0;overflow-wrap:anywhere}.actions{display:flex;gap:8px}#error{color:light-dark(#a02020,#ff9d9d);white-space:pre-wrap}.muted{opacity:.75}button{cursor:pointer}button:disabled{cursor:wait}h2{font-size:1.1rem}
</style></head><body><main><h1>界面扩展 / Web extensions</h1>
<p>此页面不加载第三方插件。This page works independently of installed extensions.</p>
<p><a href="./?extensions=off">仅加载内置界面 / Open built-in UI</a> · <a href="./">正常打开 / Open Web</a></p>
<p>安装默认禁用；启停实时生效，不重启 Web 或终端。仅首页初始化的注入需要刷新普通页面。Extensions update live; homepage-only injections require a page refresh. Server loading does not confirm every page has applied the extension.</p>
<form id="install">
<label>包名或地址 / Package name or address<input id="spec" placeholder="package-name / https://github.com/owner/plugin / /absolute/plugin" autocapitalize="none" spellcheck="false" required></label>
<label>安装源 / Installation source<select id="registry"><option value="https://registry.npmjs.org/">npm 官方源 / npm official</option><option value="https://registry.npmmirror.com/">中国大陆镜像源 / China mirror</option><option value="custom">自定义地址 / Custom URL</option></select></label>
<label id="custom-registry-field" hidden>自定义安装源地址 / Custom registry URL<input id="custom-registry" type="url" placeholder="https://npm.example.com/"></label>
<button>安装 / Install</button></form>
<p class="muted">支持 npm 包名、GitHub 仓库、运行 Web 的电脑上的绝对目录或 .tgz 安装包。Accepts npm packages, GitHub repositories, or absolute directories and .tgz archives on the Web server.</p>
<p class="muted">仅支持预构建的 Web 前端插件，不执行安装或构建脚本。安装源用于下载 npm 包及依赖，不代理 GitHub。Prebuilt Web client plugins only; package scripts are disabled. The registry serves npm packages and dependencies, not GitHub.</p>
<p id="error" role="alert"></p><p id="status" role="status"></p><section id="list"></section>
<section><h2>原生扩展 / Native extensions</h2><p id="native-status" role="status"></p><div id="native-list"></div></section></main>
<script>
const list=document.getElementById('list'),error=document.getElementById('error'),status=document.getElementById('status');
function text(tag,value,parent){const node=document.createElement(tag);node.textContent=value;parent.appendChild(node);return node}
const nativeMethods=${JSON.stringify(WEB_EXTENSIONS_RPC)};
const rpc=(action,args)=>request('codexhost/uiExtensions/'+action,args);
async function request(method,args={}){const response=await fetch('api/'+method,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'extensions-'+Date.now(),method,payload:{args}})});if(!response.ok)throw new Error('HTTP '+response.status);const reply=await response.json();if(!reply.result.ok)throw new Error(method.startsWith('codexhost/uiExtensions/')&&reply.result.error.code==='auth/disabled'?'未启用访问认证时不能管理界面扩展。Enable authentication to manage extensions.':reply.result.error.message);return reply.result.value}
function render(state){list.replaceChildren();status.textContent=state.safeMode?'当前以仅内置模式运行 / Built-in-only mode':state.extensions.length+' 个已安装扩展 / installed extensions';if(state.storeError)error.textContent=state.storeError;for(const item of state.extensions){const row=document.createElement('article');list.appendChild(row);text('h2',item.name+' '+item.version,row);const enabled=item.enabledTargets.includes('web');text('p',(enabled?'已启用 Web / Web enabled':'已禁用 / Disabled')+' · '+(state.loadedIds.includes(item.id)?'服务端已加载 / Loaded on server':'服务端未加载 / Not loaded on server'),row);if(item.loadError)text('p',item.loadError,row);const actions=text('div','',row);actions.className='actions';const toggle=text('button',enabled?'禁用 / Disable':'启用 / Enable',actions);toggle.onclick=()=>run('setEnabled',{id:item.id,enabled:!enabled});const remove=text('button','卸载 / Remove',actions);remove.onclick=()=>run('remove',{id:item.id})}}
let busy=false;
async function run(action,args){if(busy)return;busy=true;error.textContent='';document.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);try{render(await rpc(action,args))}catch(e){error.textContent=e.message}finally{busy=false;document.querySelectorAll('button,input,select').forEach(b=>b.disabled=false)}}
const registry=document.getElementById('registry'),customRegistry=document.getElementById('custom-registry');
registry.onchange=()=>{const custom=registry.value==='custom';document.getElementById('custom-registry-field').hidden=!custom;customRegistry.required=custom};
document.getElementById('install').onsubmit=e=>{e.preventDefault();run('install',{spec:document.getElementById('spec').value,registry:registry.value==='custom'?customRegistry.value.trim():registry.value})};run('list');
const nativeList=document.getElementById('native-list'),nativeStatus=document.getElementById('native-status');
function renderNative(state){nativeList.replaceChildren();const items=state.extensions.filter(item=>item.format==='codexhost');nativeStatus.textContent=items.length+' 个已安装原生扩展 / installed native extensions';for(const item of items){const row=text('article','',nativeList);text('h3',(item.manifest?.name??item.id)+' '+(item.version??''),row);text('p',(item.enabled?'已启用 / Enabled':'已禁用 / Disabled')+' · Backend: '+item.backendState,row);if(item.error)text('p',item.error,row);const actions=text('div','',row);actions.className='actions';if(item.enabled)text('button','禁用 / Disable',actions).onclick=()=>runNative(nativeMethods.setEnabled,{format:item.format,id:item.id,enabled:false});text('button','卸载 / Remove',actions).onclick=()=>runNative(nativeMethods.uninstall,{format:item.format,id:item.id})}}
let nativeBusy=false;
async function runNative(method,args){if(nativeBusy)return;nativeBusy=true;try{renderNative(await request(method,args))}catch(e){nativeStatus.textContent=e.message}finally{nativeBusy=false}}
runNative(nativeMethods.list);
</script></body></html>`;
