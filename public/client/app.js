/* global io */
"use strict";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const socket = io({ path: "/socket.io" });
const $ = id => document.getElementById(id);

let channels = [], currentChannel = null, pc = null;
let pendingIn = [], pendingOut = [], bcSocketId = null;
let mediaStream = null;

// Clock
setInterval(()=>{ $("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR",{hour12:false}); }, 1000);
$("clockDisplay").textContent = new Date().toLocaleTimeString("pt-BR",{hour12:false});

// Volume
$("volControl").oninput = () => { $("tvVideo").volume = $("volControl").value; };

function setStatus(live, msg) {
  $("statusDot").classList.toggle("live", live);
  $("statusText").textContent = msg;
}

function renderChannels() {
  const el = $("channelList");
  el.innerHTML = "";
  if (!channels.length) { $("noChannels").classList.remove("hidden"); return; }
  $("noChannels").classList.add("hidden");
  channels.forEach((id, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.innerHTML = `<span class="ch-dot"></span><span class="ch-num">CH ${String(i+1).padStart(2,"0")}</span>${id}`;
    btn.onclick = () => tuneChannel(id);
    li.appendChild(btn);
    el.appendChild(li);
  });
}

socket.on("channels-updated", list => { channels = Array.isArray(list)?list:[]; renderChannels(); });
socket.on("viewer-error", ({message}) => { alert(message||"Erro"); showScan(); });
socket.on("broadcaster-left", () => {
  $("tvOverlayMsg").textContent = "TRANSMISSÃO ENCERRADA";
  $("tvOverlay").classList.remove("hidden");
  setStatus(false, "SINAL PERDIDO");
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  $("tvVideo").srcObject = null;
  teardown();
});

function teardown() {
  pendingIn=[]; pendingOut=[]; bcSocketId=null;
  if (pc) { pc.close(); pc=null; }
}

function showScan() {
  if (currentChannel) { socket.emit("viewer-leave", currentChannel); currentChannel=null; }
  teardown();
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  $("tvVideo").srcObject=null;
  $("scanSection").classList.remove("hidden");
  $("tvSection").classList.add("hidden");
  setStatus(false,"AGUARDANDO...");
}

function showTV(ch) {
  $("scanSection").classList.add("hidden");
  $("tvSection").classList.remove("hidden");
  $("tunedChannel").textContent = "▸ "+ch.toUpperCase();
  $("tvOverlay").classList.add("hidden");
  setStatus(false,"CONECTANDO...");
}

socket.on("signal", async ({from, data}) => {
  if (!pc||!currentChannel) return;
  try {
    if (data.type==="offer") {
      bcSocketId=from;
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("signal",{to:from,data:ans});
      // flush queued out candidates
      while(pendingOut.length) socket.emit("signal",{to:from,data:{candidate:pendingOut.shift()}});
      // flush queued in candidates
      while(pendingIn.length) await pc.addIceCandidate(pendingIn.shift());
    } else if (data.candidate) {
      const c = new RTCIceCandidate(data.candidate);
      if (!pc.remoteDescription) pendingIn.push(c);
      else await pc.addIceCandidate(c);
    }
  } catch(e) { console.error(e); }
});

async function tuneChannel(ch) {
  teardown();
  if (mediaStream) { mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }

  mediaStream = new MediaStream();
  $("tvVideo").srcObject = mediaStream;
  $("tvVideo").volume = $("volControl").value;

  pc = new RTCPeerConnection(ICE);

  pc.ontrack = ev => {
    mediaStream.addTrack(ev.track);
    $("tvOverlay").classList.add("hidden");
    $("tvVideo").play().catch(()=>{});
    setStatus(true,"AO VIVO · "+ch.toUpperCase());
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (pc.iceConnectionState==="failed") {
      $("tvOverlayMsg").textContent="FALHA NA CONEXÃO";
      $("tvOverlay").classList.remove("hidden");
      setStatus(false,"ERRO DE CONEXÃO");
    } else if (pc.iceConnectionState==="disconnected") {
      setStatus(false,"SINAL INSTÁVEL...");
    }
  };

  pc.onicecandidate = ev => {
    if (!ev.candidate) return;
    if (bcSocketId) socket.emit("signal",{to:bcSocketId,data:{candidate:ev.candidate}});
    else pendingOut.push(ev.candidate);
  };

  currentChannel = ch;
  showTV(ch);
  socket.emit("viewer-join", ch);
}

$("btnBack").onclick = () => showScan();
