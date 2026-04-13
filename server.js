const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use("/broadcaster", express.static(path.join(__dirname, "public", "broadcaster")));
app.use("/client",      express.static(path.join(__dirname, "public", "client")));
app.get("/broadcaster", (req, res) => res.sendFile(path.join(__dirname, "public", "broadcaster", "index.html")));
app.get("/client",      (req, res) => res.sendFile(path.join(__dirname, "public", "client", "index.html")));

const channelBroadcasters = new Map();
const broadcasterChannels = new Map();
const viewerChannels = new Map();

function listLiveChannels() { return Array.from(channelBroadcasters.keys()); }

io.on("connection", (socket) => {
  socket.emit("channels-updated", listLiveChannels());

  socket.on("broadcaster-register", (channelId, ack) => {
    const id = String(channelId || "").trim().slice(0, 64) || "canal-1";
    if (channelBroadcasters.has(id) && channelBroadcasters.get(id) !== socket.id) {
      if (typeof ack === "function") ack({ ok: false, error: "Canal já está no ar." });
      return;
    }
    channelBroadcasters.set(id, socket.id);
    broadcasterChannels.set(socket.id, id);
    socket.join(`broadcaster:${id}`);
    io.emit("channels-updated", listLiveChannels());
    if (typeof ack === "function") ack({ ok: true, channelId: id });
  });

  socket.on("broadcaster-unregister", () => {
    const ch = broadcasterChannels.get(socket.id);
    if (ch) {
      channelBroadcasters.delete(ch);
      broadcasterChannels.delete(socket.id);
      io.emit("channels-updated", listLiveChannels());
      io.to(`viewers:${ch}`).emit("broadcaster-left");
    }
  });

  socket.on("viewer-join", (channelId) => {
    const id = String(channelId || "").trim();
    const bcId = channelBroadcasters.get(id);
    if (!bcId) { socket.emit("viewer-error", { message: "Canal indisponível" }); return; }
    socket.join(`viewers:${id}`);
    viewerChannels.set(socket.id, id);
    io.to(bcId).emit("viewer-ready", { viewerId: socket.id, channelId: id });
  });

  socket.on("viewer-leave", (channelId) => {
    const id = String(channelId || "").trim();
    socket.leave(`viewers:${id}`);
    viewerChannels.delete(socket.id);
    const bcId = channelBroadcasters.get(id);
    if (bcId) io.to(bcId).emit("viewer-gone", { viewerId: socket.id });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    const ch = broadcasterChannels.get(socket.id);
    if (ch) {
      channelBroadcasters.delete(ch);
      broadcasterChannels.delete(socket.id);
      io.emit("channels-updated", listLiveChannels());
      io.to(`viewers:${ch}`).emit("broadcaster-left");
      return;
    }
    const vc = viewerChannels.get(socket.id);
    if (vc) {
      viewerChannels.delete(socket.id);
      const bcId = channelBroadcasters.get(vc);
      if (bcId) io.to(bcId).emit("viewer-gone", { viewerId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Porta ${PORT} já está em uso. Encerre o processo anterior.\n`);
    process.exit(1);
  } else throw err;
});

server.listen(PORT, () => {
  console.log(`\n✅  http://localhost:${PORT}`);
  console.log(`📡  Emissora:  http://localhost:${PORT}/broadcaster/`);
  console.log(`📺  Cliente:   http://localhost:${PORT}/client/\n`);
});
