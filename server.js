const express=require("express");
const crypto=require("crypto");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const multer=require("multer");
const fs=require("fs");
const path=require("path");
const {Pool}=require("pg");
const PgSession=require("connect-pg-simple")(session);

const app=express(), PORT=process.env.PORT||3000;
app.set("trust proxy",1);
const DATA=path.join(__dirname,"data.json");
const UPLOADS=path.join(__dirname,"uploads");
if(!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS,{recursive:true});
if(!fs.existsSync(DATA)) fs.writeFileSync(DATA,JSON.stringify({users:[],requests:[]},null,2));
const read=()=>JSON.parse(fs.readFileSync(DATA,"utf8"));
const write=d=>fs.writeFileSync(DATA,JSON.stringify(d,null,2));
const useDb=!!process.env.DATABASE_URL;
const pool=useDb?new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}):null;

const rateBuckets=new Map();
function rateLimit({windowMs,max,keyPrefix}){
 return (req,res,next)=>{
  const key=keyPrefix+":"+String(req.ip||req.socket.remoteAddress||"unknown");
  const now=Date.now();
  let b=rateBuckets.get(key);
  if(!b||now-b.start>=windowMs){b={start:now,count:0};rateBuckets.set(key,b)}
  b.count++;
  if(b.count>max){
   const retry=Math.max(1,Math.ceil((windowMs-(now-b.start))/1000));
   res.set("Retry-After",String(retry));
   return res.status(429).json({error:"Zu viele Versuche. Bitte später erneut versuchen."});
  }
  next();
 };
}
setInterval(()=>{const now=Date.now();for(const [k,b] of rateBuckets)if(now-b.start>60*60*1000)rateBuckets.delete(k)},15*60*1000).unref();

const publicRequestLimit=rateLimit({windowMs:60*60*1000,max:10,keyPrefix:"request"});
const loginLimit=rateLimit({windowMs:15*60*1000,max:10,keyPrefix:"login"});
const registerLimit=rateLimit({windowMs:60*60*1000,max:5,keyPrefix:"register"});
const reviewLimit=rateLimit({windowMs:60*60*1000,max:10,keyPrefix:"review"});
const claimLimit=rateLimit({windowMs:15*60*1000,max:30,keyPrefix:"claim"});



async function sendCustomerClaimEmail(request){
  const to=String(request?.email||"").trim();
  const apiKey=String(process.env.RESEND_API_KEY||"").trim();
  const from=String(process.env.RESEND_FROM||"").trim();
  if(!to||!apiKey||!from)return false;
  const provider=String(request.provider_company||"Dienstleister").trim();
  const statusUrl=(String(process.env.APP_URL||"https://anfragepro.onrender.com").replace(/\/$/,""))+"/?request="+encodeURIComponent(String(request.request_token||""));
  const subject="AnfragePro: Ein Dienstleister hat deine Anfrage übernommen";
  const html=`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#0e315f">
    <h2>Ein Dienstleister hat deine Anfrage übernommen.</h2>
    <p>Deine Anfrage bei AnfragePro wurde übernommen. Du kannst jetzt direkt Kontakt aufnehmen.</p>
    <div style="background:#f4f7fb;border-radius:14px;padding:16px;margin:20px 0">
      <strong>${String(request.service||request.service_type||"Deine Anfrage")}</strong><br>
      ${String(request.place||"")}
    </div>
    <p><strong>Dienstleister:</strong> ${provider}</p>
    <p><a href="${statusUrl}" style="display:inline-block;background:#0e315f;color:#fff;text-decoration:none;padding:13px 18px;border-radius:10px;font-weight:700">Meine Anfrage öffnen →</a></p>
    <p style="color:#667085;font-size:12px">AnfragePro · Lokal. Direkt. Transparent.</p>
  </div>`;
  try{
    const response=await fetch("https://api.resend.com/emails",{
      method:"POST",
      headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
      body:JSON.stringify({from,to:[to],subject,html})
    });
    if(!response.ok){console.error("Resend:",await response.text());return false;}
    return true;
  }catch(e){console.error("E-Mail Versand:",e);return false;}
}

async function dbInit(){
 if(!useDb)return;
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users(
  id BIGINT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  company TEXT NOT NULL,
  phone TEXT DEFAULT '',
  city TEXT DEFAULT '',
  services TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  request_token TEXT UNIQUE
 );
 CREATE TABLE IF NOT EXISTS request_reviews(
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT UNIQUE NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
 );
 CREATE TABLE IF NOT EXISTS request_offers(
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT UNIQUE NOT NULL,
  provider_id BIGINT NOT NULL,
  price_min NUMERIC(10,2),
  price_max NUMERIC(10,2),
  availability TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL
 );
 CREATE TABLE IF NOT EXISTS requests(
  id BIGINT PRIMARY KEY,
  user_id BIGINT,
  service_type TEXT,
  service TEXT,
  place TEXT,
  date TEXT,
  scope TEXT,
  frequency TEXT,
  description TEXT,
  name TEXT,
  phone TEXT,
  email TEXT,
  photo_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  provider_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL
 );
 `);
 await pool.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS request_token TEXT UNIQUE");
 await pool.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS customer_claim_notified_at TIMESTAMPTZ");
 const count=(await pool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
 if(count===0){
  const d=read();
  for(const u of d.users||[]) await pool.query(
   "INSERT INTO users(id,email,password_hash,company,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
   [u.id,u.email,u.password_hash,u.company,u.created_at]
  );
  for(const r of d.requests||[]) await pool.query(
   "INSERT INTO requests(id,user_id,service_type,service,place,date,scope,frequency,description,name,phone,email,photo_count,status,provider_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING",
   [r.id,r.user_id||null,r.service_type,r.service,r.place,r.date,r.scope,r.frequency,r.description,r.name,r.phone,r.email,r.photo_count||0,r.status||"new",r.provider_id||null,r.created_at]
  );
 }
}

app.disable("x-powered-by");
app.use((req,res,next)=>{
 res.setHeader("X-Content-Type-Options","nosniff");
 res.setHeader("X-Frame-Options","DENY");
 res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
 next();
});
app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:true,limit:"50kb"}));
app.use(session({
 secret:process.env.SESSION_SECRET||"change-this-secret",
 resave:false,saveUninitialized:false,
 store:useDb?new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}):undefined,
 cookie:{httpOnly:true,sameSite:"lax",secure:true,maxAge:1000*60*60*24*30}
}));
app.use(express.static(path.join(__dirname,"public")));
const upload=multer({
 dest:UPLOADS,
 limits:{files:8,fileSize:5*1024*1024},
 fileFilter:(req,file,cb)=>{
  if(/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(String(file.mimetype||"")))return cb(null,true);
  cb(new Error("Nur Bilddateien sind erlaubt."));
 }
});

function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Nicht angemeldet"});next();}

app.post("/api/register",registerLimit,async(req,res)=>{
 try{
  const {email,password,company}=req.body;
  if(!email||!password||!company||password.length<8)return res.status(400).json({error:"Firma, E-Mail und mindestens 8 Zeichen Passwort erforderlich."});
  const emailNorm=email.trim().toLowerCase();
  if(useDb){
   const exists=await pool.query("SELECT id FROM users WHERE email=$1",[emailNorm]);
   if(exists.rowCount)return res.status(400).json({error:"E-Mail bereits registriert."});
   const id=Date.now();
   await pool.query("INSERT INTO users(id,email,password_hash,company,created_at) VALUES($1,$2,$3,$4,NOW())",[id,emailNorm,await bcrypt.hash(password,12),company]);
   req.session.userId=id;
   await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
  }else{
   const d=read();
   if(d.users.some(u=>u.email===emailNorm))return res.status(400).json({error:"E-Mail bereits registriert."});
   const u={id:Date.now(),email:emailNorm,password_hash:await bcrypt.hash(password,12),company,created_at:new Date().toISOString(),phone:"",city:"",services:"",description:""};
   d.users.push(u);write(d);req.session.userId=u.id;
   await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Serverfehler bei der Registrierung."});}
});

app.post("/api/login",loginLimit,async(req,res)=>{
 try{
  const email=(req.body.email||"").trim().toLowerCase();
  let u;
  if(useDb) u=(await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email))=$1",[email])).rows[0];
  else u=read().users.find(x=>x.email===email);
  const password=String(req.body.password||"");
  if(!u)return res.status(401).json({error:"E-Mail nicht gefunden."});
  if(!u.password_hash||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:"Passwort falsch."});
  req.session.userId=u.id;await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));const tokenData=String(u.id)+"."+Date.now();const token=Buffer.from(tokenData+"."+crypto.createHmac("sha256",process.env.SESSION_SECRET||"change-this-secret").update(tokenData).digest("hex")).toString("base64url");res.json({ok:true,company:u.company,remember_token:token});
 }catch(e){console.error(e);res.status(500).json({error:"Serverfehler beim Login."});}
});

app.get("/api/restore-session",async(req,res)=>{
 try{
  const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  const raw=Buffer.from(token,"base64url").toString("utf8");
  const parts=raw.split(".");
  if(parts.length!==3)return res.status(401).json({error:"Keine gespeicherte Anmeldung."});
  const userId=parts[0],issued=Number(parts[1]),sig=parts[2];
  if(!userId||!issued||Date.now()-issued>1000*60*60*24*30)return res.status(401).json({error:"Gespeicherte Anmeldung abgelaufen."});
  const tokenData=userId+"."+issued;
  const expected=crypto.createHmac("sha256",process.env.SESSION_SECRET||"change-this-secret").update(tokenData).digest("hex");
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return res.status(401).json({error:"Ungültige Anmeldung."});
  let u;
  if(useDb)u=(await pool.query("SELECT id,email,company FROM users WHERE id=$1",[userId])).rows[0];
  else u=read().users.find(x=>String(x.id)===String(userId));
  if(!u)return res.status(401).json({error:"Benutzer nicht gefunden."});
  req.session.userId=u.id;await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));
  res.json({ok:true,company:u.company});
 }catch(e){console.error(e);res.status(401).json({error:"Gespeicherte Anmeldung konnte nicht wiederhergestellt werden."});}
});

app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/api/me",auth,async(req,res)=>{
 try{
  let u;
  if(useDb) u=(await pool.query("SELECT id,email,company,phone,city,services,description FROM users WHERE id=$1",[req.session.userId])).rows[0];
  else u=read().users.find(x=>x.id===req.session.userId);
  if(!u){req.session.destroy(()=>{});return res.status(401).json({error:"Sitzung abgelaufen. Bitte neu einloggen."});}
  res.json({id:u.id,email:u.email,company:u.company,phone:u.phone||"",city:u.city||"",services:u.services||"",description:u.description||""});
 }catch(e){console.error(e);res.status(500).json({error:"Serverfehler."});}
});

app.patch("/api/profile",auth,async(req,res)=>{
 try{
  const {company,phone,city,services,description}=req.body;
  if(!company?.trim())return res.status(400).json({error:"Firmenname erforderlich."});
  if(useDb){
   await pool.query("UPDATE users SET company=$1,phone=$2,city=$3,services=$4,description=$5 WHERE id=$6",[company.trim(),phone||"",city||"",services||"",description||"",req.session.userId]);
  }else{
   const d=read(),u=d.users.find(x=>x.id===req.session.userId);
   if(!u)return res.status(401).json({error:"Sitzung abgelaufen."});
   Object.assign(u,{company:company.trim(),phone:phone||"",city:city||"",services:services||"",description:description||""});write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Profil konnte nicht gespeichert werden."});}
});

app.get("/api/requests",auth,async(req,res)=>{
 try{
  let me;
  let requests;
  if(useDb){
   me=(await pool.query("SELECT city,services FROM users WHERE id=$1",[req.session.userId])).rows[0];
   requests=(await pool.query("SELECT * FROM requests ORDER BY id DESC")).rows;
  }else{
   const d=read();
   me=d.users.find(x=>x.id===req.session.userId)||{};
   requests=d.requests.sort((a,b)=>b.id-a.id);
  }
  requests=requests.filter(r=>!r.provider_id||Number(r.provider_id)===Number(req.session.userId));
  const normalize=x=>String(x||"").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"");
  const city=normalize(me?.city);
  const services=normalize(me?.services).split(/[,;]+/).map(x=>x.trim()).filter(Boolean);
  const scored=requests.map(r=>{
   const place=normalize(r.place);
   const serviceType=normalize(r.service_type);
   const service=normalize(r.service);
   let score=0;
   const reasons=[];
   if(city && place && (place.includes(city)||city.includes(place))){score+=1;reasons.push("Ort passt");}
   if(services.some(s=>s && (serviceType.includes(s)||service.includes(s)||s.includes(serviceType)||s.includes(service)))){score+=1;reasons.push("Leistung passt");}
   return {...r,match_score:score,matched:score>0,match_reasons:reasons};
  }).sort((a,b)=>(b.match_score-a.match_score)||((b.id||0)-(a.id||0)));
  res.json(scored.map(r=>{
   if(r.provider_id&&Number(r.provider_id)===Number(req.session.userId)) return r;
   return {...r,name:"",phone:"",email:""};
  }));
 }catch(e){console.error(e);res.status(500).json({error:"Anfragen konnten nicht geladen werden."});}
});

app.post("/api/requests",publicRequestLimit,upload.array("photos",8),async(req,res)=>{
 try{
  const {service_type,service,place,date,scope,frequency,description,name,phone,email}=req.body;
  const emailNorm=String(email||"").trim().toLowerCase();
  if(!service_type||!service||!name||!phone||!emailNorm)return res.status(400).json({error:"Bitte alle Pflichtfelder ausfüllen."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))return res.status(400).json({error:"Bitte eine gültige E-Mail-Adresse eingeben."});
  if(String(service).length>200||String(name).length>120||String(phone).length>50||String(description||"").length>3000)return res.status(400).json({error:"Ein Feld ist zu lang."});
  const id=Date.now(),photoCount=(req.files||[]).length,requestToken=crypto.randomBytes(18).toString("hex");
  if(useDb) await pool.query(
   "INSERT INTO requests(id,user_id,service_type,service,place,date,scope,frequency,description,name,phone,email,photo_count,status,provider_id,created_at,request_token) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',NULL,NOW(),$13)",
   [id,service_type,service,place,date,scope,frequency,description,name,phone,emailNorm,photoCount,requestToken]
  );
  else{const d=read();d.requests.push({id,user_id:null,service_type,service,place,date,scope,frequency,description,name,phone,email:emailNorm,photo_count:photoCount,status:"new",provider_id:null,created_at:new Date().toISOString(),request_token:requestToken});write(d);}
  res.json({ok:true,id,request_token:requestToken});
 }catch(e){console.error(e);res.status(500).json({error:"Anfrage konnte nicht gespeichert werden."});}
});

app.get("/api/request-status/:token",async(req,res)=>{
 try{
  const token=String(req.params.token||"");
  let r;
  if(useDb) r=(await pool.query(`
   SELECT r.service_type,r.service,r.place,r.status,r.provider_id,
          u.company AS provider_company,u.phone AS provider_phone,
          u.city AS provider_city,u.services AS provider_services,
          u.description AS provider_description
   FROM requests r
   LEFT JOIN users u ON u.id=r.provider_id
   WHERE r.request_token=$1
  `,[token])).rows[0];
  else{
   const d=read();
   r=d.requests.find(x=>x.request_token===token);
   if(r&&r.provider_id){
    const u=d.users.find(x=>Number(x.id)===Number(r.provider_id))||{};
    r={...r,provider_company:u.company||"",provider_phone:u.phone||"",provider_city:u.city||"",provider_services:u.services||"",provider_description:u.description||""};
   }
  }
  if(!r)return res.status(404).json({error:"Anfrage nicht gefunden."});
  let review=null,providerRating=null;
  if(useDb){
   review=(await pool.query("SELECT rating,comment,created_at FROM request_reviews WHERE request_id=(SELECT id FROM requests WHERE request_token=$1)",[token])).rows[0]||null;
   if(r.provider_id){
    providerRating=(await pool.query("SELECT ROUND(AVG(rr.rating)::numeric,1) AS avg, COUNT(*)::int AS count FROM request_reviews rr JOIN requests rq ON rq.id=rr.request_id WHERE rq.provider_id=$1",[r.provider_id])).rows[0];
   }
  }else{
   const d=read();
   const rr=(d.reviews||[]).find(x=>Number(x.request_id)===Number(r.id));
   review=rr||null;
   if(r.provider_id){
    const list=(d.reviews||[]).filter(x=>{const rq=d.requests.find(q=>Number(q.id)===Number(x.request_id));return rq&&Number(rq.provider_id)===Number(r.provider_id)});
    providerRating=list.length?{avg:(list.reduce((s,x)=>s+Number(x.rating),0)/list.length).toFixed(1),count:list.length}:null;
   }
  }
  res.json({
   service_type:r.service_type,service:r.service,place:r.place,status:r.status,claimed:!!r.provider_id,
   review,providerRating,
   provider:r.provider_id?{
    company:r.provider_company||"Dienstleister",
    phone:r.provider_phone||"",
    city:r.provider_city||"",
    services:r.provider_services||"",
    description:r.provider_description||""
   }:null
  });
 }catch(e){console.error(e);res.status(500).json({error:"Status konnte nicht geladen werden."});}
});

app.post("/api/requests/:id/claim",auth,claimLimit,async(req,res)=>{
 try{
  const id=Number(req.params.id);
  let request,providerCompany="";
  if(useDb){
   request=(await pool.query("SELECT * FROM requests WHERE id=$1",[id])).rows[0];
   if(!request)return res.status(404).json({error:"Nicht gefunden"});
   if(request.provider_id&&Number(request.provider_id)!==Number(req.session.userId))return res.status(409).json({error:"Anfrage bereits übernommen."});
   const provider=(await pool.query("SELECT company FROM users WHERE id=$1",[req.session.userId])).rows[0];
   providerCompany=provider?.company||"Dienstleister";
   await pool.query("UPDATE requests SET provider_id=$1 WHERE id=$2",[req.session.userId,id]);
   request.provider_company=providerCompany;
   if(!request.customer_claim_notified_at){
    const sent=await sendCustomerClaimEmail(request);
    if(sent)await pool.query("UPDATE requests SET customer_claim_notified_at=NOW() WHERE id=$1",[id]);
   }
  }else{
   const d=read(),r=d.requests.find(x=>x.id===id);
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(r.provider_id&&r.provider_id!==req.session.userId)return res.status(409).json({error:"Anfrage bereits übernommen."});
   const provider=d.users.find(x=>x.id===req.session.userId)||{};
   r.provider_id=req.session.userId;r.provider_company=provider.company||"Dienstleister";
   if(!r.customer_claim_notified_at){
    const sent=await sendCustomerClaimEmail(r);
    if(sent)r.customer_claim_notified_at=new Date().toISOString();
   }
   write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Anfrage konnte nicht übernommen werden."});}
});

app.post("/api/requests/:id/offer",auth,async(req,res)=>{
 try{
  const id=Number(req.params.id);
  const priceMin=req.body.price_min===""||req.body.price_min==null?null:Number(req.body.price_min);
  const priceMax=req.body.price_max===""||req.body.price_max==null?null:Number(req.body.price_max);
  const availability=String(req.body.availability||"").trim().slice(0,120);
  const message=String(req.body.message||"").trim().slice(0,1000);
  if(priceMin!==null&&(!Number.isFinite(priceMin)||priceMin<0))return res.status(400).json({error:"Ungültiger Mindestpreis."});
  if(priceMax!==null&&(!Number.isFinite(priceMax)||priceMax<0))return res.status(400).json({error:"Ungültiger Höchstpreis."});
  if(priceMin!==null&&priceMax!==null&&priceMax<priceMin)return res.status(400).json({error:"Der Höchstpreis darf nicht kleiner sein."});
  if(!availability&&!message&&priceMin===null&&priceMax===null)return res.status(400).json({error:"Bitte mindestens Preis, Verfügbarkeit oder Nachricht angeben."});
  if(useDb){
   const r=(await pool.query("SELECT provider_id,status FROM requests WHERE id=$1",[id])).rows[0];
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(Number(r.provider_id)!==Number(req.session.userId))return res.status(403).json({error:"Anfrage zuerst übernehmen."});
   await pool.query("INSERT INTO request_offers(request_id,provider_id,price_min,price_max,availability,message,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'pending',NOW()) ON CONFLICT(request_id) DO UPDATE SET price_min=EXCLUDED.price_min,price_max=EXCLUDED.price_max,availability=EXCLUDED.availability,message=EXCLUDED.message,status='pending',created_at=NOW()",[id,req.session.userId,priceMin,priceMax,availability,message]);
  }else{
   const d=read(),r=d.requests.find(x=>Number(x.id)===id);
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(Number(r.provider_id)!==Number(req.session.userId))return res.status(403).json({error:"Anfrage zuerst übernehmen."});
   d.offers=d.offers||[];
   const old=d.offers.find(x=>Number(x.request_id)===id);
   const offer={id:old?.id||Date.now(),request_id:id,provider_id:req.session.userId,price_min:priceMin,price_max:priceMax,availability,message,status:"pending",created_at:new Date().toISOString()};
   if(old)Object.assign(old,offer);else d.offers.push(offer);write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Angebot konnte nicht gespeichert werden."});}
});

app.get("/api/request-status/:token/offer",async(req,res)=>{
 try{
  const token=String(req.params.token||"");
  let o;
  if(useDb)o=(await pool.query("SELECT o.price_min,o.price_max,o.availability,o.message,o.status,o.created_at,u.company,u.phone,u.city,u.services,u.description FROM request_offers o JOIN requests r ON r.id=o.request_id LEFT JOIN users u ON u.id=o.provider_id WHERE r.request_token=$1",[token])).rows[0];
  else{
   const d=read(),r=d.requests.find(x=>x.request_token===token); o=r?(d.offers||[]).find(x=>Number(x.request_id)===Number(r.id)):null;
   if(o){const u=d.users.find(x=>Number(x.id)===Number(o.provider_id))||{};o={...o,company:u.company||"Dienstleister",phone:u.phone||"",city:u.city||"",services:u.services||"",description:u.description||""}}
  }
  if(!o)return res.json({offer:null});
  res.json({offer:{price_min:o.price_min,price_max:o.price_max,availability:o.availability||"",message:o.message||"",status:o.status,provider:{company:o.company||"Dienstleister",phone:o.phone||"",city:o.city||"",services:o.services||"",description:o.description||""}}});
 }catch(e){console.error(e);res.status(500).json({error:"Angebot konnte nicht geladen werden."});}
});

app.post("/api/request-status/:token/offer/accept",async(req,res)=>{
 try{
  const token=String(req.params.token||"");
  if(useDb){
   const r=(await pool.query("SELECT id,provider_id FROM requests WHERE request_token=$1",[token])).rows[0];
   if(!r)return res.status(404).json({error:"Anfrage nicht gefunden."});
   const o=(await pool.query("SELECT id FROM request_offers WHERE request_id=$1",[r.id])).rows[0];
   if(!o)return res.status(404).json({error:"Kein Angebot vorhanden."});
   await pool.query("UPDATE request_offers SET status='accepted' WHERE request_id=$1",[r.id]);
   await pool.query("UPDATE requests SET status='accepted' WHERE id=$1",[r.id]);
  }else{
   const d=read(),r=d.requests.find(x=>x.request_token===token); if(!r)return res.status(404).json({error:"Anfrage nicht gefunden."});
   const o=(d.offers||[]).find(x=>Number(x.request_id)===Number(r.id)); if(!o)return res.status(404).json({error:"Kein Angebot vorhanden."});
   o.status="accepted";r.status="accepted";write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Angebot konnte nicht angenommen werden."});}
});

app.post("/api/request-status/:token/review",reviewLimit,async(req,res)=>{
 try{
  const token=String(req.params.token||"");
  const rating=Number(req.body.rating);
  const comment=String(req.body.comment||"").trim().slice(0,1000);
  if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:"Bitte eine Bewertung von 1 bis 5 Sternen wählen."});
  let r;
  if(useDb)r=(await pool.query("SELECT id,status,provider_id FROM requests WHERE request_token=$1",[token])).rows[0];
  else r=read().requests.find(x=>x.request_token===token);
  if(!r)return res.status(404).json({error:"Anfrage nicht gefunden."});
  if(r.status!=="completed")return res.status(400).json({error:"Bewertung ist erst nach Abschluss des Auftrags möglich."});
  if(!r.provider_id)return res.status(400).json({error:"Kein Dienstleister zugeordnet."});
  if(useDb){
   const exists=await pool.query("SELECT id FROM request_reviews WHERE request_id=$1",[r.id]);
   if(exists.rowCount)return res.status(409).json({error:"Diese Anfrage wurde bereits bewertet."});
   await pool.query("INSERT INTO request_reviews(request_id,rating,comment,created_at) VALUES($1,$2,$3,NOW())",[r.id,rating,comment]);
  }else{
   const d=read();d.reviews=d.reviews||[];
   if(d.reviews.some(x=>Number(x.request_id)===Number(r.id)))return res.status(409).json({error:"Diese Anfrage wurde bereits bewertet."});
   d.reviews.push({id:Date.now(),request_id:r.id,rating,comment,created_at:new Date().toISOString()});write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Bewertung konnte nicht gespeichert werden."});}
});

app.patch("/api/requests/:id",auth,async(req,res)=>{
 try{
  const id=Number(req.params.id),allowed=["new","contacted","accepted","completed"];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:"Ungültiger Status."});
  if(useDb){
   const r=(await pool.query("SELECT provider_id FROM requests WHERE id=$1",[id])).rows[0];
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(Number(r.provider_id)!==Number(req.session.userId))return res.status(403).json({error:"Anfrage zuerst übernehmen."});
   await pool.query("UPDATE requests SET status=$1 WHERE id=$2",[req.body.status,id]);
  }else{
   const d=read(),r=d.requests.find(x=>x.id===id);
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(r.provider_id!==req.session.userId)return res.status(403).json({error:"Anfrage zuerst übernehmen."});
   r.status=req.body.status;write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Status konnte nicht geändert werden."});}
});

app.get("/health",(req,res)=>res.json({ok:true,service:"AnfragePro",database:useDb?"postgres":"json"}));

app.use((err,req,res,next)=>{
 if(err&&err.code==="LIMIT_FILE_SIZE")return res.status(400).json({error:"Ein Bild ist zu groß. Maximal 5 MB pro Datei."});
 if(err&&err.code==="LIMIT_FILE_COUNT")return res.status(400).json({error:"Maximal 8 Bilder erlaubt."});
 if(err&&err.message==="Nur Bilddateien sind erlaubt.")return res.status(400).json({error:err.message});
 console.error(err);
 res.status(500).json({error:"Interner Serverfehler."});
});



dbInit().then(()=>app.listen(PORT,()=>console.log(`AnfragePro läuft auf http://localhost:${PORT} | DB: ${useDb?"Postgres":"JSON"}`))).catch(e=>{console.error("DB init failed",e);process.exit(1);});
