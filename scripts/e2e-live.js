#!/usr/bin/env node
const readline = require("node:readline");

const baseUrl = (process.argv[2] || process.env.BASE_URL || "").replace(/\/$/, "");
if (!baseUrl) {
  console.error("Использование: node scripts/e2e-live.js https://deine-domain.example");
  process.exit(2);
}

const rl = readline.createInterface({input:process.stdin,output:process.stdout});
const ask = q => new Promise(resolve => rl.question(q, resolve));

class Client {
  constructor(name){ this.name=name; this.cookies=new Map(); }
  async request(path, options={}){
    const headers = {...(options.headers||{})};
    if(this.cookies.size) headers.cookie=[...this.cookies].map(([k,v])=>k+"="+v).join("; ");
    if(options.body && typeof options.body !== "string"){
      headers["content-type"]="application/json";
      options={...options,body:JSON.stringify(options.body)};
    }
    const res=await fetch(baseUrl+path,{...options,headers,redirect:"manual"});
    const setCookies=res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for(const line of setCookies){
      const first=line.split(";")[0], i=first.indexOf("=");
      if(i>0)this.cookies.set(first.slice(0,i),first.slice(i+1));
    }
    let data=null;
    const text=await res.text();
    try{data=text?JSON.parse(text):null}catch{data=text}
    return {status:res.status,data};
  }
}

function ok(cond,msg){
  if(cond) console.log("  PASS  "+msg);
  else { console.log("  FAIL  "+msg); failures++; }
}
function sameSet(values, expected){return JSON.stringify([...values].sort())===JSON.stringify([...expected].sort());}
let failures=0;

async function loginProvider(label,email,password){
  const c=new Client(label);
  const login=await c.request("/api/login",{method:"POST",body:{email,password}});
  ok(login.status===200, label+" login");
  const me=await c.request("/api/me");
  ok(me.status===200, label+" /api/me");
  ok(me.data?.email_verified===true, label+" ist per E-Mail verifiziert");
  ok(me.data?.city && me.data?.services, label+" hat Ort und Leistungen im Profil");
  return {c,me:me.data};
}

(async()=>{
  console.log("\nAnfragePro — Live E2E / E2");
  console.log("Ziel: "+baseUrl+"\n");

  const health=new Client("health");
  const h=await health.request("/health");
  ok(h.status===200 && h.data?.ok===true,"/health erreichbar");
  if(h.status!==200){ console.log("Abbruch: Deployment nicht erreichbar."); process.exit(1); }

  const p1Email=await ask("E-Mail Ausführer 1 (verifiziert): ");
  const p1Password=await ask("Passwort Ausführer 1: ");
  const p2Email=await ask("E-Mail Ausführer 2 (verifiziert): ");
  const p2Password=await ask("Passwort Ausführer 2: ");
  rl.close();

  const p1=await loginProvider("Provider 1",p1Email.trim(),p1Password);
  const p2=await loginProvider("Provider 2",p2Email.trim(),p2Password);
  if(failures) {
    console.log("\nSTOP: Beide Provider müssen sich anmelden lassen und verifiziert sein.");
    process.exit(1);
  }

  const stamp=Date.now();
  const makeCustomer=async(n)=>{
    const c=new Client("Client "+n);
    const email="e2e-client-"+stamp+"-"+n+"@example.test";
    const r=await c.request("/api/customer/register",{method:"POST",body:{
      name:"E2E Kunde "+n,email,password:"E2E-test-2026!"
    }});
    ok(r.status===200,"Client "+n+" automatisch erstellt");
    return {c,email};
  };

  const c1=await makeCustomer(1);
  const c2=await makeCustomer(2);
  if(failures)process.exit(1);

  const city=String(p1.me.city).trim();
  const services=String(p1.me.services).split(/[,;]+/).map(x=>x.trim()).filter(Boolean);
  const service=services[0]||"Dienstleistung";

  const createRequest=async(client,n)=>{
    const r=await client.request("/api/requests",{method:"POST",body:{
      service_type:service,service,place:city,date:"",scope:"E2E",frequency:"einmalig",
      description:"Automatischer E2E-Test — bitte ignorieren.",
      name:"E2E Kunde "+n,phone:"+491234567890",email:client.email
    }});
    ok(r.status===200 && r.data?.request_token,"Client "+n+" kann Anfrage erstellen");
    return r.data;
  };

  const req=await createRequest(c1.c,1);
  const req2=await createRequest(c2.c,2);

  const own1=await c1.c.request("/api/customer/requests");
  const own2=await c2.c.request("/api/customer/requests");
  ok(own1.status===200 && own1.data.some(x=>String(x.request_token)===String(req.request_token)),"Client 1 sieht eigene Anfrage");
  ok(own2.status===200 && own2.data.some(x=>String(x.request_token)===String(req2.request_token)),"Client 2 sieht eigene Anfrage");
  ok(own1.status===200 && !own1.data.some(x=>String(x.request_token)===String(req2.request_token)),"Client 1 sieht Anfrage von Client 2 nicht");
  ok(own2.status===200 && !own2.data.some(x=>String(x.request_token)===String(req.request_token)),"Client 2 sieht Anfrage von Client 1 nicht");

  const m1=await p1.c.request("/api/requests");
  const m2=await p2.c.request("/api/requests");
  ok(m1.status===200 && m1.data.some(x=>Number(x.id)===Number(req.id)),"Provider 1 sieht Testanfrage");
  ok(m2.status===200 && m2.data.some(x=>Number(x.id)===Number(req.id)),"Provider 2 sieht Testanfrage");

  console.log("\nConcurrent claim …");
  const [claim1,claim2]=await Promise.all([
    p1.c.request("/api/requests/"+req.id+"/claim",{method:"POST",body:{}}),
    p2.c.request("/api/requests/"+req.id+"/claim",{method:"POST",body:{}})
  ]);
  const claimStatuses=[claim1.status,claim2.status];
  ok(claimStatuses.filter(x=>x===200).length===1 && claimStatuses.filter(x=>x===409).length===1,
     "genau ein Provider erhält 200, der andere 409");

  const winner=claim1.status===200?p1:p2;
  const loser=claim1.status===200?p2:p1;

  const status=await c1.c.request("/api/request-status/"+req.request_token);
  ok(status.status===200 && status.data?.claimed===true,"Anfrage ist genau einem Provider zugeordnet");
  ok(Number(status.data?.provider_id)===Number(winner.me.id),"zugeordneter Provider ist der Gewinner");

  const offer=await winner.c.request("/api/requests/"+req.id+"/offer",{method:"POST",body:{
    price_min:100,price_max:150,availability:"Morgen 10:00",message:"E2E Testangebot"
  }});
  ok(offer.status===200,"Gewinner kann Angebot senden");

  const accept=await c1.c.request("/api/request-status/"+req.request_token+"/offer/accept",{method:"POST",body:{}});
  ok(accept.status===200,"Kunde kann Angebot annehmen");

  const acceptAgain=await c1.c.request("/api/request-status/"+req.request_token+"/offer/accept",{method:"POST",body:{}});
  ok(acceptAgain.status===409,"zweite Annahme wird mit 409 abgelehnt");

  const cancel=await c1.c.request("/api/request-status/"+req.request_token+"/cancel",{method:"POST",body:{}});
  ok(cancel.status===200,"Kunde kann Auftrag nach Annahme stornieren");

  const offerAfterCancel=await winner.c.request("/api/requests/"+req.id+"/offer",{method:"POST",body:{
    price_min:200,message:"Muss abgelehnt werden"
  }});
  ok(offerAfterCancel.status===400,"Angebot nach Stornierung wird abgelehnt");

  const rollback=await winner.c.request("/api/requests/"+req.id,{method:"PATCH",body:{status:"new"}});
  ok(rollback.status===400,"stornierter Auftrag kann nicht zurückgesetzt werden");

  console.log("\nE2E Ergebnis: "+(failures?"FAIL":"PASS")+" ("+failures+" Fehler)");
  console.log("Testdaten: zwei Kundenanfragen wurden erstellt; die Testdaten bleiben zur manuellen Kontrolle im System.");
  process.exit(failures?1:0);
})().catch(e=>{
  rl.close();
  console.error("\nE2E ABGEBROCHEN:",e.message);
  process.exit(1);
});
