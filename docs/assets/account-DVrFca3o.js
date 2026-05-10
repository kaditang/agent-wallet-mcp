import"./modulepreload-polyfill-B5Qt9EMX.js";if(window.top!==window.self){try{window.top.location.replace(window.location.href)}catch{document.documentElement.innerHTML=""}throw new Error("framed")}const p=window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1"?"http://localhost:3030":"https://autoyield-api.fly.dev",w=new Set(["autoyield.org","www.autoyield.org","localhost","127.0.0.1"]);if(!w.has(location.hostname))throw document.body.innerHTML=`
    <div style="max-width:560px;margin:4rem auto;padding:2rem;font-family:system-ui;color:#fff;background:#1a0000;border:2px solid #ef4444;border-radius:12px">
      <h1 style="color:#ef4444;margin:0 0 1rem">⚠ Suspicious origin</h1>
      <p>This page is being served from <code>${location.hostname}</code>, not an authorized autoyield host.</p>
      <p>Close the tab — do not sign anything.</p>
    </div>`,new Error("blocked");const f=location.hostname==="localhost"||location.hostname==="127.0.0.1",u=new URLSearchParams(location.search),b=f?u.get("api"):null,h=(b??p).replace(/\/$/,""),l=(()=>{const n=u.get("response_type"),t=u.get("redirect_uri"),s=u.get("state")??"";return n!=="code"||!t?null:{redirectUri:t,state:s}})(),k=["smithery.run","smithery.ai","run.tools","localhost","127.0.0.1"];function C(n){try{const t=new URL(n);return k.some(s=>t.hostname===s||t.hostname.endsWith("."+s))}catch{return!1}}const o=document.getElementById("signin"),d=document.getElementById("status"),m=document.getElementById("result");function a(n,t=""){if(n==="hidden"){d.style.display="none";return}d.style.display="block",d.className=`status${n==="info"?"":" "+n}`,d.textContent=t}function v(){var t;const n=((t=window.phantom)==null?void 0:t.solana)??window.solana;return n!=null&&n.isPhantom?n:null}function P(n){let t="";for(let i=0;i<n.length;i+=32768)t+=String.fromCharCode.apply(null,Array.from(n.slice(i,i+32768)));return btoa(t)}o.addEventListener("click",async()=>{a("hidden"),m.style.display="none";const n=v();if(!n){a("warn",`Phantom not detected.
Install it from https://phantom.com (Chrome / Brave / Firefox extension).`);return}o.disabled=!0,o.textContent="Connecting…";let t;try{t=(await n.connect()).publicKey.toString()}catch(e){a("err",`Connect failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info",`Connected as ${t.slice(0,6)}…${t.slice(-6)}
Fetching challenge…`),o.textContent="Signing…";let s,i;try{const e=await fetch(`${h}/auth/challenge`,{method:"POST"});if(!e.ok)throw new Error(`HTTP ${e.status}`);const c=await e.json();s=c.nonce,i=c.message}catch(e){a("err",`Could not reach backend at ${h}
${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info","Phantom will prompt to sign the login message. Approve.");let y;try{const e=new TextEncoder().encode(i),c=await n.signMessage(e,"utf8"),g=c.signature??c;y=P(g)}catch(e){/reject|denied|cancel/i.test((e==null?void 0:e.message)??"")?a("warn","You cancelled the signature."):a("err",`Sign failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info","Verifying signature…");let r;try{const e=await fetch(`${h}/auth/verify`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pubkey:t,nonce:s,signatureBase64:y})});if(!e.ok)throw new Error(`${e.status}: ${await e.text()}`);r=(await e.json()).apiKey}catch(e){a("err",`Verify failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}if(l){const e=new URL(l.redirectUri);if(e.searchParams.set("code",r),l.state&&e.searchParams.set("state",l.state),C(l.redirectUri)){a("ok",`Signed in as ${t.slice(0,6)}…${t.slice(-6)}
Returning to ${e.host}…`),window.location.replace(e.toString());return}o.textContent="Continue",a("warn",`An app at ${e.host} is asking to receive your autoyield API key.
This grants it full access to build transactions on your wallet's behalf.
(You still sign every tx in Phantom — this just controls who can ask.)

If you didn't expect this, close the tab.`),o.onclick=()=>{window.location.replace(e.toString())};return}a("ok",`Signed in as ${t.slice(0,6)}…${t.slice(-6)}`),o.textContent="✓ API key issued",m.style.display="block",m.innerHTML=`
    <div class="card" style="border-color:var(--accent)">
      <div style="font-weight:600;margin-bottom:0.5rem">Your API key (save it now — won't be shown again)</div>
      <div class="key-box" id="key">${r}</div>
      <button class="copy-btn" id="copy">Copy</button>
      <div class="small" style="margin-top:1rem">
        <strong>How to use in Claude Desktop:</strong> add this to your MCP config —
        <pre style="margin:0.5rem 0;background:#000;padding:0.75rem;border-radius:6px;font-size:0.8rem;white-space:pre-wrap;word-break:break-all"><code>{
  "mcpServers": {
    "autoyield": {
      "command": "npx",
      "args": ["mcp-remote", "https://autoyield-api.fly.dev/mcp", "--header", "Authorization: Bearer ${r}"]
    }
  }
}</code></pre>
        Or pass it as <code>Authorization: Bearer ${r.slice(0,12)}…</code> in any HTTP client.
      </div>
    </div>
  `,document.getElementById("copy").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(r);const e=document.getElementById("copy");e.textContent="✓ Copied",setTimeout(()=>e.textContent="Copy",1500)}catch{}})});
