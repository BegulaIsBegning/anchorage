/* global io */
"use strict";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const socket = io({ path: "/socket.io" });

const canvas   = document.getElementById("outCanvas");
const ctx      = canvas.getContext("2d");
const hiddenVid = document.getElementById("camVideo");
const $ = id => document.getElementById(id);

// ─── STATE ────────────────────────────────────────────────────────────────────
let live = false, channelId = "";
let source = "file";
let playlist = [], currentIdx = -1, activeVid = null;

// Audio - each HTMLVideoElement maps to its MediaElementSource (only created once!)
const audioSrcMap = new WeakMap();
let audioCtx = null, destNode = null, micGainNode = null, vidGainNode = null;
let micStreamSource = null, analyser = null, analyserData = null;

let outStream = null, rafId = null;
let tickerX = 0, overlayImg = null, urgentImg = null, urgentUntil = 0;
const peers = new Map(), iceQueue = new Map(), viewers = new Set();

// ─── CLOCK ────────────────────────────────────────────────────────────────────
setInterval(() => {
  $("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });
}, 1000);
$("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR", { hour12: false });

// ─── VU METER ─────────────────────────────────────────────────────────────────
(function() {
  const b = $("vuBars"), l = $("ledbar");
  for (let i=0;i<28;i++){const d=document.createElement("div");d.className="vu-bar";b.appendChild(d);}
  for (let i=0;i<20;i++){const d=document.createElement("div");d.className="ls";l.appendChild(d);}
})();

function updateVU() {
  const bars = $("vuBars").querySelectorAll(".vu-bar");
  const segs = $("ledbar").querySelectorAll(".ls");
  if (!analyser) {
    bars.forEach(b=>b.style.height="2px"); segs.forEach(s=>s.className="ls"); $("vuDb").textContent="-∞"; return;
  }
  analyser.getByteFrequencyData(analyserData);
  let peak = 0;
  bars.forEach((bar,i)=>{
    const v=analyserData[Math.floor(i*analyserData.length/bars.length)]/255;
    peak=Math.max(peak,v);
    bar.style.height=Math.round(v*26)+"px";
    bar.className="vu-bar"+(i>22?" r":i>18?" a":"");
  });
  const db=peak>0?Math.round(20*Math.log10(peak)):-Infinity;
  $("vuDb").textContent=isFinite(db)?db+"dB":"-∞";
  segs.forEach((s,i)=>{
    s.className="ls"+(peak>i/segs.length?(i>17?" ar":i>13?" aa":" ag"):"");
  });
}

// ─── LIVE UI ──────────────────────────────────────────────────────────────────
function setLiveUI(on) {
  $("liveBadge").className="live-badge "+(on?"on":"off");
  $("liveBadgeText").textContent=on?"NO AR":"FORA DO AR";
  $("btnGoLive").disabled=on; $("btnStop").disabled=!on; $("channelId").disabled=on;
  $("channelDisplay").textContent="CANAL: "+(on?channelId.toUpperCase():"—");
}
function updateViewers(){$("viewersCount").textContent=viewers.size;}

// ─── SOURCE ───────────────────────────────────────────────────────────────────
window.selectSource = function(s) {
  source=s;
  $("srcFile").classList.toggle("active",s==="file");
  $("srcCam").classList.toggle("active",s==="cam");
  $("fileSourcePanel").style.display=s==="file"?"":"none";
  $("camSourcePanel").style.display=s==="cam"?"":"none";
  if(s==="cam") loadCamDevices();
};
async function loadCamDevices() {
  try {
    const devs=await navigator.mediaDevices.enumerateDevices();
    $("camSelect").innerHTML=devs.filter(d=>d.kind==="videoinput")
      .map((d,i)=>`<option value="${d.deviceId}">${d.label||"Câmera "+(i+1)}</option>`).join("");
  } catch(e){console.warn(e);}
}
$("btnRefreshCam").onclick=loadCamDevices;

// ─── PLAYLIST ─────────────────────────────────────────────────────────────────
function fmtTime(s){
  if(!isFinite(s))return"--:--";
  return Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
}

function renderPlaylist() {
  const el=$("playlist");
  if(!playlist.length){el.innerHTML='<div class="pl-empty">Nenhum vídeo. Clique em + ADICIONAR.</div>';return;}
  el.innerHTML=playlist.map((item,i)=>`
    <div class="pl-item${i===currentIdx?" playing":""}" data-i="${i}">
      <span class="pl-ic">${i===currentIdx?"▶":"○"}</span>
      <span class="pl-name">${item.name}</span>
      <span class="pl-dur">${fmtTime(item.duration)}</span>
      <span class="pl-del" data-del="${i}">✕</span>
    </div>`).join("");
  el.querySelectorAll(".pl-item").forEach(row=>row.addEventListener("click",e=>{
    if(e.target.dataset.del!==undefined)return;
    switchToIdx(Number(row.dataset.i));
  }));
  el.querySelectorAll(".pl-del").forEach(btn=>btn.addEventListener("click",e=>{
    e.stopPropagation(); removeItem(Number(btn.dataset.del));
  }));
}

function removeItem(idx) {
  const item=playlist[idx]; if(!item)return;
  if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}
  URL.revokeObjectURL(item.objectURL);
  playlist.splice(idx,1);
  if(currentIdx===idx){currentIdx=-1;activeVid=null;}
  else if(currentIdx>idx)currentIdx--;
  renderPlaylist(); updateSourceBadge();
}

$("btnAddVideos").onclick=()=>$("videoFiles").click();
$("videoFiles").addEventListener("change",e=>{
  Array.from(e.target.files||[]).forEach(f=>{
    const url=URL.createObjectURL(f);
    const vid=document.createElement("video");
    vid.src=url; vid.preload="metadata"; vid.crossOrigin="anonymous";
    const item={name:f.name.replace(/\.[^.]+$/,""),objectURL:url,vid,duration:0};
    vid.addEventListener("loadedmetadata",()=>{item.duration=vid.duration;renderPlaylist();},{once:true});
    playlist.push(item);
  });
  renderPlaylist();
  if(currentIdx<0&&playlist.length)switchToIdx(0);
  e.target.value="";
});

$("btnClearPlaylist").onclick=()=>{
  playlist.forEach(item=>{
    if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}
    URL.revokeObjectURL(item.objectURL);
  });
  playlist=[];currentIdx=-1;activeVid=null;
  renderPlaylist();updateSourceBadge();
};

function wireVideoAudio(vid) {
  if(!audioCtx||!vidGainNode)return;
  if(audioSrcMap.has(vid))return; // already wired
  try {
    const src=audioCtx.createMediaElementSource(vid);
    src.connect(vidGainNode);
    audioSrcMap.set(vid,src);
  } catch(e){console.warn("wireVideoAudio:",e);}
}

function switchToIdx(idx) {
  if(idx<0||idx>=playlist.length)return;
  if(activeVid&&activeVid!==playlist[idx]?.vid){activeVid.pause();activeVid.currentTime=0;}
  currentIdx=idx;
  const item=playlist[idx];
  activeVid=item.vid;
  wireVideoAudio(item.vid);
  item.vid.onended=()=>{
    const next=currentIdx+1;
    if(next<playlist.length){switchToIdx(next);activeVid.play().catch(()=>{});}
    else if($("loopPlaylist").checked){switchToIdx(0);playlist[0].vid.play().catch(()=>{});}
  };
  if(live){activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ PAUSE";}
  renderPlaylist();updateSourceBadge();
}

$("btnPlayPause").onclick=()=>{
  if(!activeVid){if(playlist.length)switchToIdx(0);return;}
  if(activeVid.paused){activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ PAUSE";}
  else{activeVid.pause();$("btnPlayPause").textContent="▶ PLAY";}
};
$("btnNextVideo").onclick=()=>{
  if(!playlist.length)return;
  switchToIdx((currentIdx+1)%playlist.length);
  activeVid?.play().catch(()=>{});$("btnPlayPause").textContent="⏸ PAUSE";
};
$("btnPrevVideo").onclick=()=>{
  if(!playlist.length)return;
  switchToIdx((currentIdx-1+playlist.length)%playlist.length);
  activeVid?.play().catch(()=>{});$("btnPlayPause").textContent="⏸ PAUSE";
};
$("videoSeek").addEventListener("input",()=>{
  if(!activeVid||!isFinite(activeVid.duration))return;
  activeVid.currentTime=($("videoSeek").value/100)*activeVid.duration;
});

function updateProgress(){
  const vid=activeVid;
  if(!vid||!isFinite(vid.duration)||!vid.duration)return;
  if(!$("videoSeek").matches(":active"))$("videoSeek").value=(vid.currentTime/vid.duration)*100;
  $("videoCurrentTime").textContent=fmtTime(vid.currentTime);
  $("videoDuration").textContent=fmtTime(vid.duration);
}

function updateSourceBadge(){
  const b=$("sourceBadge");
  if(source==="cam"){b.textContent="CÂMERA AO VIVO";b.style.color="var(--green)";}
  else if(activeVid&&currentIdx>=0){b.textContent=playlist[currentIdx]?.name.toUpperCase().slice(0,32)||"ARQUIVO";b.style.color="var(--amber)";}
  else{b.textContent="SEM FONTE";b.style.color="";}
}

// ─── MIXER ────────────────────────────────────────────────────────────────────
function syncR(id,v1,v2){const v=$(id).value;if(v1)$(v1).textContent=v;if(v2)$(v2).textContent=v+"%";}
$("micGain").oninput=()=>{syncR("micGain","micVal","micValRight");if(micGainNode)micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;};
$("muteMic").onchange=()=>{if(micGainNode)micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;};
$("muteVideoAudio").onchange=()=>{if(vidGainNode)vidGainNode.gain.value=$("muteVideoAudio").checked?0:1;};
$("videoBright").oninput=()=>syncR("videoBright","brightVal","brightValRight");
$("videoContrast").oninput=()=>syncR("videoContrast","contrastVal","contrastValRight");
$("videoSat").oninput=()=>syncR("videoSat","satVal","satValRight");
$("tickerSpeed").oninput=()=>$("tickerSpeedVal").textContent=$("tickerSpeed").value;
$("overlayOpacity").oninput=()=>{$("overlayOpVal").textContent=$("overlayOpacity").value;$("overlayOpRight").textContent=$("overlayOpacity").value+"%";};

// ─── OVERLAYS ─────────────────────────────────────────────────────────────────
$("overlayFile").onchange=e=>{const f=e.target.files[0];if(!f)return;const u=URL.createObjectURL(f);const img=new Image();img.onload=()=>{overlayImg=img;URL.revokeObjectURL(u);};img.src=u;};
$("btnClearOverlay").onclick=()=>{overlayImg=null;$("overlayFile").value="";};
$("urgentFile").onchange=e=>{const f=e.target.files[0];$("btnUrgent").disabled=!f;if(!f){urgentImg=null;return;}const u=URL.createObjectURL(f);const img=new Image();img.onload=()=>{urgentImg=img;URL.revokeObjectURL(u);};img.src=u;};
$("btnUrgent").onclick=()=>{if(!urgentImg)return;urgentUntil=performance.now()+(Number($("urgentDuration").value)||5)*1000;};

// ─── CANVAS ───────────────────────────────────────────────────────────────────
function drawFrame() {
  const W=canvas.width,H=canvas.height;
  ctx.fillStyle="#000";ctx.fillRect(0,0,W,H);

  const vid=source==="cam"?hiddenVid:activeVid;
  if(vid&&vid.readyState>=2&&vid.videoWidth){
    ctx.filter=`brightness(${Number($("videoBright").value)/100}) contrast(${Number($("videoContrast").value)/100}) saturate(${Number($("videoSat").value)/100})`;
    const sc=Math.max(W/vid.videoWidth,H/vid.videoHeight);
    ctx.drawImage(vid,(W-vid.videoWidth*sc)/2,(H-vid.videoHeight*sc)/2,vid.videoWidth*sc,vid.videoHeight*sc);
    ctx.filter="none";
  }

  if(overlayImg){
    const op=Number($("overlayOpacity").value)/100,pos=$("overlayPos").value,m=18;
    ctx.save();ctx.globalAlpha=op;
    let dw,dh,dx,dy;
    if(pos==="fill"){const sc=Math.min(W/overlayImg.width,H/overlayImg.height);dw=overlayImg.width*sc;dh=overlayImg.height*sc;dx=(W-dw)/2;dy=(H-dh)/2;}
    else{const sc=Math.min(W*.24/overlayImg.width,H*.28/overlayImg.height,1);dw=overlayImg.width*sc;dh=overlayImg.height*sc;if(pos==="br"){dx=W-dw-m;dy=H-dh-m-50;}else if(pos==="bl"){dx=m;dy=H-dh-m-50;}else if(pos==="tr"){dx=W-dw-m;dy=m+44;}else{dx=m;dy=m+44;}}
    ctx.drawImage(overlayImg,dx,dy,dw,dh);ctx.restore();
  }

  if($("showLiveTag").checked){
    ctx.save();ctx.font="bold 18px monospace";const t="● AO VIVO",tw=ctx.measureText(t).width,px=12,py=6,x=W-tw-px*2-16,y=16;
    ctx.fillStyle="rgba(210,30,30,0.92)";ctx.beginPath();ctx.roundRect(x,y,tw+px*2,24+py,3);ctx.fill();
    ctx.fillStyle="#fff";ctx.fillText(t,x+px,y+19);ctx.restore();
  }

  if($("showDateTime").checked){
    const now=new Date(),str=now.toLocaleDateString("pt-BR")+" "+now.toLocaleTimeString("pt-BR",{hour12:false});
    ctx.save();ctx.font="15px monospace";ctx.fillStyle="rgba(0,0,0,0.6)";ctx.fillRect(10,12,195,26);
    ctx.fillStyle="#00ff88";ctx.fillText(str,14,29);ctx.restore();
  }

  const st=$("screenText").value.trim();
  if(st){
    ctx.save();ctx.font="bold 26px monospace";ctx.textAlign="center";ctx.strokeStyle="rgba(0,0,0,0.85)";ctx.lineWidth=5;ctx.fillStyle="#fff";
    const y=$("screenTextPos").value==="top"?58:$("screenTextPos").value==="center"?H/2:H-106;
    ctx.strokeText(st,W/2,y);ctx.fillText(st,W/2,y);ctx.restore();
  }

  if(urgentImg&&performance.now()<urgentUntil){
    ctx.save();ctx.fillStyle="rgba(0,0,0,0.45)";ctx.fillRect(0,0,W,H);
    const sc=Math.min(W/urgentImg.width,H/urgentImg.height);
    ctx.drawImage(urgentImg,(W-urgentImg.width*sc)/2,(H-urgentImg.height*sc)/2,urgentImg.width*sc,urgentImg.height*sc);
    ctx.restore();
  }

  if($("tickerOn").checked){
    const text=($("tickerText").value.trim()||"TELETOP")+"   ◆   ",speed=Number($("tickerSpeed").value)*1.1;
    tickerX-=speed;const bH=46,y0=H-bH;
    ctx.fillStyle="rgba(0,0,0,0.8)";ctx.fillRect(0,y0,W,bH);ctx.font="19px monospace";ctx.fillStyle="#ddd";
    const full=text+text,tw=ctx.measureText(full).width;
    if(tickerX<-tw)tickerX=W;
    ctx.save();ctx.rect(0,y0,W,bH);ctx.clip();ctx.fillText(full,tickerX,y0+30);ctx.restore();
  }

  updateVU();updateProgress();
  rafId=requestAnimationFrame(drawFrame);
}

// ─── AUDIO PIPELINE ───────────────────────────────────────────────────────────
async function buildAudio() {
  audioCtx=new AudioContext();
  if(audioCtx.state==="suspended")await audioCtx.resume();
  destNode=audioCtx.createMediaStreamDestination();
  micGainNode=audioCtx.createGain();
  vidGainNode=audioCtx.createGain();
  micGainNode.gain.value=$("muteMic").checked?0:Number($("micGain").value)/100;
  vidGainNode.gain.value=$("muteVideoAudio").checked?0:1;
  micGainNode.connect(destNode);
  vidGainNode.connect(destNode);
  analyser=audioCtx.createAnalyser();analyser.fftSize=256;analyserData=new Uint8Array(analyser.frequencyBinCount);
  micGainNode.connect(analyser);vidGainNode.connect(analyser);
}

async function startPipeline() {
  await buildAudio();

  if(source==="cam"){
    const deviceId=$("camSelect").value;
    const cs={video:{width:{ideal:1280},height:{ideal:720}},audio:true};
    if(deviceId)cs.video.deviceId={exact:deviceId};
    const camStream=await navigator.mediaDevices.getUserMedia(cs);
    hiddenVid.srcObject=camStream;await hiddenVid.play();
    const camAudioSrc=audioCtx.createMediaStreamSource(new MediaStream(camStream.getAudioTracks()));
    camAudioSrc.connect(micGainNode);micStreamSource=camAudioSrc;
  } else {
    if(activeVid){wireVideoAudio(activeVid);activeVid.play().catch(()=>{});$("btnPlayPause").textContent="⏸ PAUSE";}
  }
  updateSourceBadge();

  const vStream=canvas.captureStream(30);
  const aTrack=destNode.stream.getAudioTracks()[0];
  if(aTrack)vStream.addTrack(aTrack);
  outStream=vStream;
}

function teardownAudio(){
  playlist.forEach(item=>{if(audioSrcMap.has(item.vid)){try{audioSrcMap.get(item.vid).disconnect();}catch(_){}audioSrcMap.delete(item.vid);}});
  if(micStreamSource){try{micStreamSource.disconnect();}catch(_){}micStreamSource=null;}
  if(audioCtx){audioCtx.close().catch(()=>{});audioCtx=null;}
  destNode=null;micGainNode=null;vidGainNode=null;analyser=null;analyserData=null;
}

function stopPipeline(){
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  closeAllPeers();
  if(activeVid)activeVid.pause();
  $("btnPlayPause").textContent="▶ PLAY";
  if(hiddenVid.srcObject){hiddenVid.srcObject.getTracks().forEach(t=>t.stop());hiddenVid.srcObject=null;}
  teardownAudio();outStream=null;
  rafId=requestAnimationFrame(drawFrame);
}

// ─── WEBRTC ───────────────────────────────────────────────────────────────────
socket.on("viewer-ready",async({viewerId})=>{
  if(!live||!outStream)return;
  viewers.add(viewerId);updateViewers();
  try{await openPeer(viewerId);}catch(e){console.error(e);viewers.delete(viewerId);updateViewers();}
});
socket.on("viewer-gone",({viewerId})=>{viewers.delete(viewerId);updateViewers();closePeer(viewerId);});
socket.on("signal",async({from,data})=>{
  const pc=peers.get(from);if(!pc)return;
  try{
    if(data.type==="answer"){await pc.setRemoteDescription(new RTCSessionDescription(data));const q=iceQueue.get(from);if(q){iceQueue.delete(from);for(const c of q)await pc.addIceCandidate(new RTCIceCandidate(c));}}
    else if(data.candidate){if(!pc.remoteDescription){let q=iceQueue.get(from);if(!q){q=[];iceQueue.set(from,q);}q.push(data.candidate);}else await pc.addIceCandidate(new RTCIceCandidate(data.candidate));}
  }catch(e){console.warn(e);}
});
function closePeer(id){iceQueue.delete(id);const pc=peers.get(id);if(pc){pc.close();peers.delete(id);}}
function closeAllPeers(){for(const id of peers.keys())closePeer(id);viewers.clear();updateViewers();}
async function openPeer(viewerId){
  const pc=new RTCPeerConnection(ICE);peers.set(viewerId,pc);
  outStream.getTracks().forEach(t=>pc.addTrack(t,outStream));
  pc.onicecandidate=ev=>{if(ev.candidate)socket.emit("signal",{to:viewerId,data:{candidate:ev.candidate}});};
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  socket.emit("signal",{to:viewerId,data:offer});
}

// ─── GO LIVE ──────────────────────────────────────────────────────────────────
$("btnGoLive").onclick=async()=>{
  const raw=$("channelId").value.trim()||"canal-"+Math.random().toString(36).slice(2,7);
  $("channelId").value=raw;
  if(rafId){cancelAnimationFrame(rafId);rafId=null;}
  try{await startPipeline();}catch(e){alert("Erro: "+e.message);rafId=requestAnimationFrame(drawFrame);return;}
  socket.emit("broadcaster-register",raw,res=>{
    if(!res?.ok){alert(res?.error||"Erro ao registrar canal.");stopPipeline();return;}
    channelId=res.channelId;live=true;setLiveUI(true);
    rafId=requestAnimationFrame(drawFrame);
  });
};
$("btnStop").onclick=()=>{
  socket.emit("broadcaster-unregister");
  live=false;channelId="";stopPipeline();setLiveUI(false);
};

// ─── INIT ─────────────────────────────────────────────────────────────────────
setLiveUI(false);updateViewers();renderPlaylist();
rafId=requestAnimationFrame(drawFrame);
