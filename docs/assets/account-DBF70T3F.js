import"./modulepreload-polyfill-B5Qt9EMX.js";if(window.top!==window.self){try{window.top.location.replace(window.location.href)}catch{document.documentElement.innerHTML=""}throw new Error("framed")}const g=window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1"?"http://localhost:3030":"https://autoyield-api.fly.dev",f=new Set(["autoyield.org","www.autoyield.org","localhost","127.0.0.1"]);if(!f.has(location.hostname))throw document.body.innerHTML=`
    <div style="max-width:560px;margin:4rem auto;padding:2rem;font-family:system-ui;color:#fff;background:#1a0000;border:2px solid #ef4444;border-radius:12px">
      <h1 style="color:#ef4444;margin:0 0 1rem">⚠ Suspicious origin</h1>
      <p>This page is being served from <code>${location.hostname}</code>, not an authorized autoyield host.</p>
      <p>Close the tab — do not sign anything.</p>
    </div>`,new Error("blocked");const w=location.hostname==="localhost"||location.hostname==="127.0.0.1",u=new URLSearchParams(location.search),b=w?u.get("api"):null,h=(b??g).replace(/\/$/,""),l=(()=>{const n=u.get("response_type"),t=u.get("redirect_uri"),r=u.get("state")??"";return n!=="code"||!t?null:{redirectUri:t,state:r}})(),C=["smithery.run","smithery.ai","run.tools"],k=["localhost","127.0.0.1"];function P(n){try{const t=new URL(n);if(t.protocol!=="http:"&&t.protocol!=="https:")return!1;const r=t.hostname;return k.includes(r)?!0:C.some(a=>r===a||r.endsWith("."+a))}catch{return!1}}function S(n){try{const t=new URL(n);return t.protocol==="https:"||t.protocol==="http:"}catch{return!1}}const o=document.getElementById("signin"),d=document.getElementById("status"),m=document.getElementById("result");function s(n,t=""){if(n==="hidden"){d.style.display="none";return}d.style.display="block",d.className=`status${n==="info"?"":" "+n}`,d.textContent=t}function v(){var t;const n=((t=window.phantom)==null?void 0:t.solana)??window.solana;return n!=null&&n.isPhantom?n:null}function x(n){let t="";for(let a=0;a<n.length;a+=32768)t+=String.fromCharCode.apply(null,Array.from(n.slice(a,a+32768)));return btoa(t)}o.addEventListener("click",async()=>{s("hidden"),m.style.display="none";const n=v();if(!n){s("warn",`Phantom not detected.
Install it from https://phantom.com (Chrome / Brave / Firefox extension).`);return}o.disabled=!0,o.textContent="Connecting…";let t;try{t=(await n.connect()).publicKey.toString()}catch(e){s("err",`Connect failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}s("info",`Connected as ${t.slice(0,6)}…${t.slice(-6)}
Fetching challenge…`),o.textContent="Signing…";let r,a;try{const e=await fetch(`${h}/auth/challenge`,{method:"POST"});if(!e.ok)throw new Error(`HTTP ${e.status}`);const c=await e.json();r=c.nonce,a=c.message}catch(e){s("err",`Could not reach backend at ${h}
${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}s("info","Phantom will prompt to sign the login message. Approve.");let p;try{const e=new TextEncoder().encode(a),c=await n.signMessage(e,"utf8"),y=c.signature??c;p=x(y)}catch(e){/reject|denied|cancel/i.test((e==null?void 0:e.message)??"")?s("warn","You cancelled the signature."):s("err",`Sign failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}s("info","Verifying signature…");let i;try{const e=await fetch(`${h}/auth/verify`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pubkey:t,nonce:r,signatureBase64:p})});if(!e.ok)throw new Error(`${e.status}: ${await e.text()}`);i=(await e.json()).apiKey}catch(e){s("err",`Verify failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}if(l){if(!S(l.redirectUri)){s("err","Refused: the OAuth redirect_uri must use http or https. The MCP client appears to be misconfigured (or the page was opened from a malicious link)."),o.disabled=!0,o.textContent="Aborted";return}const e=new URL(l.redirectUri);if(e.searchParams.set("code",i),l.state&&e.searchParams.set("state",l.state),P(l.redirectUri)){s("ok",`Signed in as ${t.slice(0,6)}…${t.slice(-6)}
Returning to ${e.host}…`),window.location.replace(e.toString());return}o.textContent="Continue",s("warn",`An app at ${e.host} is asking to receive your autoyield API key.
This grants it full access to build transactions on your wallet's behalf.
(You still sign every tx in Phantom — this just controls who can ask.)

If you didn't expect this, close the tab.`),o.onclick=()=>{window.location.replace(e.toString())};return}s("ok",`Signed in as ${t.slice(0,6)}…${t.slice(-6)}`),o.textContent="✓ API key issued",m.style.display="block",m.innerHTML=`
    <div class="card" style="border-color:var(--accent)">
      <div style="font-weight:600;margin-bottom:0.5rem">Your API key (save it now — won't be shown again)</div>
      <div class="key-box" id="key">${i}</div>
      <button class="copy-btn" id="copy">Copy</button>
      <div class="small" style="margin-top:1rem">
        <strong>How to use in Claude Desktop:</strong> add this to your MCP config —
        <pre style="margin:0.5rem 0;background:#000;padding:0.75rem;border-radius:6px;font-size:0.8rem;white-space:pre-wrap;word-break:break-all"><code>{
  "mcpServers": {
    "autoyield": {
      "command": "npx",
      "args": ["mcp-remote", "https://autoyield-api.fly.dev/mcp", "--header", "Authorization: Bearer ${i}"]
    }
  }
}</code></pre>
        Or pass it as <code>Authorization: Bearer ${i.slice(0,12)}…</code> in any HTTP client.
      </div>
    </div>
  `,document.getElementById("copy").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(i);const e=document.getElementById("copy");e.textContent="✓ Copied",setTimeout(()=>e.textContent="Copy",1500)}catch{}})});
