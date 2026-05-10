import"./modulepreload-polyfill-B5Qt9EMX.js";const g=window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1"?"http://localhost:3030":"https://autoyield-api.fly.dev",u=new Set(["autoyield.org","www.autoyield.org","localhost","127.0.0.1"]);if(!u.has(location.hostname))throw document.body.innerHTML=`
    <div style="max-width:560px;margin:4rem auto;padding:2rem;font-family:system-ui;color:#fff;background:#1a0000;border:2px solid #ef4444;border-radius:12px">
      <h1 style="color:#ef4444;margin:0 0 1rem">⚠ Suspicious origin</h1>
      <p>This page is being served from <code>${location.hostname}</code>, not an authorized autoyield host.</p>
      <p>Close the tab — do not sign anything.</p>
    </div>`,new Error("blocked");const d=(new URLSearchParams(location.search).get("api")??g).replace(/\/$/,""),o=document.getElementById("signin"),c=document.getElementById("status"),m=document.getElementById("result");function a(t,n=""){if(t==="hidden"){c.style.display="none";return}c.style.display="block",c.className=`status${t==="info"?"":" "+t}`,c.textContent=n}function p(){var n;const t=((n=window.phantom)==null?void 0:n.solana)??window.solana;return t!=null&&t.isPhantom?t:null}function f(t){let n="";for(let i=0;i<t.length;i+=32768)n+=String.fromCharCode.apply(null,Array.from(t.slice(i,i+32768)));return btoa(n)}o.addEventListener("click",async()=>{a("hidden"),m.style.display="none";const t=p();if(!t){a("warn",`Phantom not detected.
Install it from https://phantom.com (Chrome / Brave / Firefox extension).`);return}o.disabled=!0,o.textContent="Connecting…";let n;try{n=(await t.connect()).publicKey.toString()}catch(e){a("err",`Connect failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info",`Connected as ${n.slice(0,6)}…${n.slice(-6)}
Fetching challenge…`),o.textContent="Signing…";let l,i;try{const e=await fetch(`${d}/auth/challenge`,{method:"POST"});if(!e.ok)throw new Error(`HTTP ${e.status}`);const s=await e.json();l=s.nonce,i=s.message}catch(e){a("err",`Could not reach backend at ${d}
${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info","Phantom will prompt to sign the login message. Approve.");let h;try{const e=new TextEncoder().encode(i),s=await t.signMessage(e,"utf8"),y=s.signature??s;h=f(y)}catch(e){/reject|denied|cancel/i.test((e==null?void 0:e.message)??"")?a("warn","You cancelled the signature."):a("err",`Sign failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("info","Verifying signature…");let r;try{const e=await fetch(`${d}/auth/verify`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pubkey:n,nonce:l,signatureBase64:h})});if(!e.ok)throw new Error(`${e.status}: ${await e.text()}`);r=(await e.json()).apiKey}catch(e){a("err",`Verify failed: ${e.message??e}`),o.disabled=!1,o.textContent="Connect Phantom & get API key";return}a("ok",`Signed in as ${n.slice(0,6)}…${n.slice(-6)}`),o.textContent="✓ API key issued",m.style.display="block",m.innerHTML=`
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
