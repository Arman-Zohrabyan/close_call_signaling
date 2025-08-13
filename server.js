const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.get('/', (req, res) => res.send('Signaling Server Running'));

const rooms = new Map();

function removeUserFromRoom(userId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.users.delete(userId);
  
  if (room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty)`);
    return;
  }

  if (room.host === userId) {
    const newHost = Array.from(room.users)[0];
    room.host = newHost;
    io.to(roomId).emit('new-host', newHost);
    console.log(`New host for room ${roomId}: ${newHost}`);
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (data) => {
    const { roomId, settings } = data;
    
    if (rooms.has(roomId)) {
      socket.emit('room-error', 'Room already exists');
      return;
    }

    const room = {
      id: roomId,
      host: socket.id,
      users: new Set([socket.id]),
      settings: settings,
      gameStarted: false,
      createdAt: Date.now()
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.currentRoom = roomId;
    
    console.log(`Room ${roomId} created by ${socket.id}`);
    socket.emit('room-created', true);
    socket.emit('existing-users', []);
  });

  socket.on('join-room', (roomId) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('room-error', 'Room not exist');
      return;
    }

    if (room.gameStarted) {
      socket.emit('room-error', 'Room is in progress');
      return;
    }

    if (room.users.size >= room.settings.maxUsers) {
      socket.emit('room-error', 'Room is full');
      return;
    }

    socket.join(roomId);
    socket.currentRoom = roomId;
    room.users.add(socket.id);
    
    const existingUsers = Array.from(room.users).filter(id => id !== socket.id);
    socket.emit('room-joined', {
      settings: room.settings,
      gameStarted: room.gameStarted
    });
    socket.emit('existing-users', existingUsers);
    socket.to(roomId).emit('user-joined', socket.id);
    
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('leave-room', () => {
    if (socket.currentRoom) {
      removeUserFromRoom(socket.id, socket.currentRoom);
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }
  });

  socket.on('start-game', () => {
    if (socket.currentRoom) {
      const room = rooms.get(socket.currentRoom);
      if (room && room.host === socket.id && !room.gameStarted) {
        room.gameStarted = true;
        socket.to(socket.currentRoom).emit('game-started');
        console.log(`Game started in room ${socket.currentRoom}`);
      }
    }
  });

  socket.on('offer', (data) => {
    socket.to(data.target).emit('offer', {
      sdp: data.sdp,
      sender: socket.id
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.target).emit('answer', {
      sdp: data.sdp,
      sender: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });

  socket.on('game-event', (data) => {
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit('game-event', data);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.currentRoom) {
      removeUserFromRoom(socket.id, socket.currentRoom);
      io.to(socket.currentRoom).emit('user-left', socket.id);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  rooms.forEach((room, roomId) => {
    if (now - room.createdAt > oneHour) {
      rooms.delete(roomId);
      console.log(`Cleaned up old room: ${roomId}`);
    }
  });
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
