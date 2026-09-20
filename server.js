const express=require("express");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const multer=require("multer");
const fs=require("fs");
const path=require("path");

const app=express(), PORT=process.env.PORT||3000;
const DATA=path.join(__dirname,"data.json");
const UPLOADS=path.join(__dirname,"uploads");
if(!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS,{recursive:true});
if(!fs.existsSync(DATA)) fs.writeFileSync(DATA,JSON.stringify({users:[],requests:[]},null,2));
const read=()=>JSON.parse(fs.readFileSync(DATA,"utf8"));
const write=d=>fs.writeFileSync(DATA,JSON.stringify(d,null,2));

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({secret:process.env.SESSION_SECRET||"change-this-secret",resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"}}));
app.use(express.static(path.join(__dirname,"public")));
const upload=multer({dest:UPLOADS});

function auth(req,res,next){if(!req.session.userId)return res.status(401).json({error:"Nicht angemeldet"});next();}

app.post("/api/register",async(req,res)=>{
 const {email,password,company}=req.body;
 if(!email||!password||!company||password.length<8)return res.status(400).json({error:"Firma, E-Mail und mindestens 8 Zeichen Passwort erforderlich."});
 const d=read();
 if(d.users.some(u=>u.email===email.toLowerCase()))return res.status(400).json({error:"E-Mail bereits registriert."});
 const u={id:Date.now(),email:email.toLowerCase(),password_hash:await bcrypt.hash(password,12),company,created_at:new Date().toISOString()};
 d.users.push(u); write(d); req.session.userId=u.id; res.json({ok:true});
});

app.post("/api/login",async(req,res)=>{
 const d=read(),u=d.users.find(x=>x.email===(req.body.email||"").toLowerCase());
 if(!u||!(await bcrypt.compare(req.body.password||"",u.password_hash)))return res.status(401).json({error:"Login-Daten nicht korrekt."});
 req.session.userId=u.id; res.json({ok:true,company:u.company});
});

app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",auth,(req,res)=>{
 const u=read().users.find(x=>x.id===req.session.userId);
 res.json({id:u.id,email:u.email,company:u.company});
});
app.get("/api/requests",auth,(req,res)=>{
 res.json(read().requests.filter(x=>x.user_id===req.session.userId).sort((a,b)=>b.id-a.id));
});
app.post("/api/requests",upload.array("photos",8),(req,res)=>{
 const {user_id,service_type,service,place,date,scope,frequency,description,name,phone,email}=req.body;
 const d=read(),u=d.users.find(x=>x.id===Number(user_id));
 if(!u)return res.status(400).json({error:"Unternehmen nicht gefunden."});
 const r={id:Date.now(),user_id:u.id,service_type,service,place,date,scope,frequency,description,name,phone,email,photo_count:(req.files||[]).length,status:"new",created_at:new Date().toISOString()};
 d.requests.push(r); write(d); res.json({ok:true,id:r.id});
});
app.patch("/api/requests/:id",auth,(req,res)=>{
 const d=read(),r=d.requests.find(x=>x.id===Number(req.params.id)&&x.user_id===req.session.userId);
 if(!r)return res.status(404).json({error:"Nicht gefunden"});
 r.status=req.body.status; write(d); res.json({ok:true});
});
app.get("/health",(req,res)=>res.json({ok:true,service:"AnfragePro"}));
app.listen(PORT,()=>console.log(`AnfragePro läuft auf http://localhost:${PORT}`));