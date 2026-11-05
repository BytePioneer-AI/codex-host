/** Sign-in document and the inline scripts that turn a `#token=` link into a sign-in. */
import type { IncomingMessage } from "node:http";

const COPY = {
  en: {
    lang: "en",
    prompt: "Enter the access token. Copy it on your computer in Settings → Connect devices.",
    placeholder: "Access token",
    submit: "Continue",
    invalid: "That access token is not valid.",
    limited: "Too many attempts. Try again in a minute.",
    expired:
      "This sign-in is no longer valid. The token may have been regenerated: scan the new QR code or enter it.",
    queryToken: "That link is not valid here. Sign in with a token link or enter the token.",
    unreachable: "Could not reach the server. Try again.",
  },
  zh: {
    lang: "zh-CN",
    prompt: "请输入访问令牌。可在电脑上的“设置 → 连接设备”中复制。",
    placeholder: "访问令牌",
    submit: "继续",
    invalid: "访问令牌无效。",
    limited: "尝试次数过多，请一分钟后再试。",
    expired: "登录已失效，令牌可能已重新生成。请重新扫码或输入新令牌。",
    queryToken: "此链接在这里无效。请用令牌链接登录，或手动输入令牌。",
    unreachable: "无法连接服务器，请重试。",
  },
} as const;

export type SignInNotice = "invalid" | "limited" | "expired" | "queryToken";

function copyFor(request: IncomingMessage): (typeof COPY)[keyof typeof COPY] {
  return /^\s*zh\b/iu.test(request.headers["accept-language"] ?? "") ? COPY.zh : COPY.en;
}

/**
 * Runs first in the app document: another token's link switches this browser to that token. A link
 * opened in a tab already showing this page only changes the fragment, so that is watched as well.
 */
export const SWITCH_TOKEN_SCRIPT = `<script>(()=>{const take=()=>{const u=new URL(location.href);if(!u.hash.startsWith("#token="))return;const token=new URLSearchParams(u.hash.slice(1)).get("token");u.hash="";history.replaceState(null,"",u.href);fetch("api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({token})}).then(r=>{if(r.ok)location.reload()}).catch(()=>{})};addEventListener("hashchange",take);take()})();</script>`;

export function signInDocument(request: IncomingMessage, notice?: SignInNotice): string {
  const copy = copyFor(request);
  const messages = JSON.stringify({
    invalid: copy.invalid,
    limited: copy.limited,
    unreachable: copy.unreachable,
  });
  return `<!doctype html>
<html lang="${copy.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodexHost</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#151517;--muted:#6b6b72;--line:#e3e3e8;--accent:#151517;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--fg:#f2f2f5;--muted:#9a9aa3;--line:#2c2c31;--accent:#f2f2f5;--accent-fg:#151517}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(360px,calc(100vw - 32px))}
h1{font-size:22px;margin:0 0 6px}
p{color:var(--muted);margin:0 0 20px}
input{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600}
.err{color:#d92d20}
</style></head>
<body><main>
<h1>CodexHost</h1>
<p>${copy.prompt}</p>
<p id="error" class="err" role="alert"${notice === undefined ? " hidden" : ""}>${notice === undefined ? "" : copy[notice]}</p>
<form id="form"><input id="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${copy.placeholder}" aria-label="${copy.placeholder}" autofocus><button type="submit">${copy.submit}</button></form>
</main>
<script>(()=>{
const messages=${messages};
const error=document.getElementById("error");
const show=(text)=>{error.textContent=text;error.hidden=false};
const url=new URL(location.href);
url.hash="";url.searchParams.delete("token");
const signIn=async(token)=>{
  try{
    const response=await fetch("api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({token})});
    if(response.ok){location.replace(url.href);return}
    show(response.status===429?messages.limited:messages.invalid);
  }catch{show(messages.unreachable)}
};
document.getElementById("form").addEventListener("submit",(event)=>{
  event.preventDefault();
  const token=document.getElementById("token").value.trim();
  if(token!=="")void signIn(token);
});
const take=()=>{
  const linked=location.hash.startsWith("#token=")?new URLSearchParams(location.hash.slice(1)).get("token"):null;
  history.replaceState(null,"",url.href);
  if(linked)void signIn(linked);
};
addEventListener("hashchange",take);
take();
})();</script>
</body></html>`;
}
