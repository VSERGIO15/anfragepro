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

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
 secret:process.env.SESSION_SECRET||"change-this-secret",
 resave:false,saveUninitialized:false,
 store:useDb?new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}):undefined,
 cookie:{httpOnly:true,sameSite:"lax",secure:true,maxAge:1000*60*60*24*30}
}));
app.use(express.static(path.join(__dirname,"public")));
const upload=multer({dest:UPLOADS});

function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Nicht angemeldet"});next();}

app.post("/api/register",async(req,res)=>{
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

app.post("/api/login",async(req,res)=>{
 try{
  const email=(req.body.email||"").trim().toLowerCase();
  let u;
  if(useDb) u=(await pool.query("SELECT * FROM users WHERE LOWER(TRIM(email))=$1",[email])).rows[0];
  else u=read().users.find(x=>x.email===email);
  const password=String(req.body.password||"");
  if(!u)return res.status(401).json({error:"E-Mail nicht gefunden."});
  if(!u.password_hash||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:"Passwort falsch."});
  req.session.userId=u.id;await new Promise((resolve,reject)=>req.session.save(err=>err?reject(err):resolve()));res.json({ok:true,company:u.company});
 }catch(e){console.error(e);res.status(500).json({error:"Serverfehler beim Login."});}
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

app.post("/api/requests",upload.array("photos",8),async(req,res)=>{
 try{
  const {service_type,service,place,date,scope,frequency,description,name,phone,email}=req.body;
  const id=Date.now(),photoCount=(req.files||[]).length,requestToken=crypto.randomBytes(18).toString("hex");
  if(useDb) await pool.query(
   "INSERT INTO requests(id,user_id,service_type,service,place,date,scope,frequency,description,name,phone,email,photo_count,status,provider_id,created_at,request_token) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',NULL,NOW(),$13)",
   [id,service_type,service,place,date,scope,frequency,description,name,phone,email,photoCount,requestToken]
  );
  else{const d=read();d.requests.push({id,user_id:null,service_type,service,place,date,scope,frequency,description,name,phone,email,photo_count:photoCount,status:"new",provider_id:null,created_at:new Date().toISOString(),request_token:requestToken});write(d);}
  res.json({ok:true,id,request_token:requestToken});
 }catch(e){console.error(e);res.status(500).json({error:"Anfrage konnte nicht gespeichert werden."});}
});

app.get("/api/request-status/:token",async(req,res)=>{
 try{
  const token=String(req.params.token||"");
  let r;
  if(useDb) r=(await pool.query("SELECT service_type,service,place,status,provider_id FROM requests WHERE request_token=$1",[token])).rows[0];
  else r=read().requests.find(x=>x.request_token===token);
  if(!r)return res.status(404).json({error:"Anfrage nicht gefunden."});
  res.json({service_type:r.service_type,service:r.service,place:r.place,status:r.status,claimed:!!r.provider_id});
 }catch(e){console.error(e);res.status(500).json({error:"Status konnte nicht geladen werden."});}
});

app.post("/api/requests/:id/claim",auth,async(req,res)=>{
 try{
  const id=Number(req.params.id);
  if(useDb){
   const r=(await pool.query("SELECT * FROM requests WHERE id=$1",[id])).rows[0];
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(r.provider_id&&Number(r.provider_id)!==Number(req.session.userId))return res.status(409).json({error:"Anfrage bereits übernommen."});
   await pool.query("UPDATE requests SET provider_id=$1 WHERE id=$2",[req.session.userId,id]);
  }else{
   const d=read(),r=d.requests.find(x=>x.id===id);
   if(!r)return res.status(404).json({error:"Nicht gefunden"});
   if(r.provider_id&&r.provider_id!==req.session.userId)return res.status(409).json({error:"Anfrage bereits übernommen."});
   r.provider_id=req.session.userId;write(d);
  }
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Anfrage konnte nicht übernommen werden."});}
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



dbInit().then(()=>app.listen(PORT,()=>console.log(`AnfragePro läuft auf http://localhost:${PORT} | DB: ${useDb?"Postgres":"JSON"}`))).catch(e=>{console.error("DB init failed",e);process.exit(1);});
