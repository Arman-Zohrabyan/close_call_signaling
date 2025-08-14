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
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.get('/', (req, res) => res.send('Signaling Server Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

const rooms = new Map();
const userRooms = new Map();
const activeNicknames = new Map(); // Map deviceId -> nickname
const socketToUser = new Map(); // Map socketId -> {nickname, deviceId}

function removeUserFromRoom(socketId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.users.delete(socketId);
  userRooms.delete(socketId);
  
  if (room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty)`);
    return;
  }

  if (room.host === socketId) {
    const newHost = Array.from(room.users)[0];
    room.host = newHost;
    io.to(roomId).emit('new-host', newHost);
    console.log(`New host for room ${roomId}: ${newHost}`);
  }
}

function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const { maxUsers, answerTime, questionCount, isPrivate, password, roomName } = settings;
  
  if (!Number.isInteger(maxUsers) || maxUsers < 2 || maxUsers > 10) return false;
  if (!Number.isInteger(answerTime) || answerTime < 5 || answerTime > 60) return false;
  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) return false;
  if (typeof isPrivate !== 'boolean') return false;
  if (!roomName || typeof roomName !== 'string' || roomName.length < 3 || roomName.length > 30) return false;
  if (isPrivate && (!password || typeof password !== 'string' || password.length !== 5)) return false;
  
  return true;
}

io.on('connection', (socket) => {
  const userAuth = socket.handshake.auth;
  
  if (!userAuth || !userAuth.nickname || !userAuth.deviceId) {
    socket.emit('room-error', 'Invalid user credentials');
    socket.disconnect();
    return;
  }

  const { nickname, deviceId } = userAuth;
  
  // Check if nickname is already taken by a different device
  const existingNickname = activeNicknames.get(deviceId);
  if (existingNickname && existingNickname !== nickname) {
    // Same device, different nickname - update it
    activeNicknames.set(deviceId, nickname);
  } else {
    // Check if nickname is taken by another device
    const nicknameInUse = Array.from(activeNicknames.values()).includes(nickname);
    if (nicknameInUse) {
      socket.emit('nickname-taken', `Nickname "${nickname}" is already in use. Please choose another one.`);
      socket.disconnect();
      return;
    }
    activeNicknames.set(deviceId, nickname);
  }

  socketToUser.set(socket.id, { nickname, deviceId });
  
  console.log('User connected:', socket.id, 'Nickname:', nickname);
  
  socket.on('ping', (callback) => {
    if (typeof callback === 'function') {
      callback('pong');
    }
  });

  socket.on('create-room', (data) => {
    try {
      if (!data || typeof data !== 'object') {
        socket.emit('room-error', 'Invalid room data');
        return;
      }

      const { settings, roomId } = data;
      
      if (!validateSettings(settings)) {
        socket.emit('room-error', 'Invalid game settings');
        return;
      }

      let finalRoomId = roomId;
      if (finalRoomId) {
        if (!/^\d{6}$/.test(finalRoomId)) {
          socket.emit('room-error', 'Room ID must be exactly 6 digits');
          return;
        }
        if (rooms.has(finalRoomId)) {
          socket.emit('room-error', 'Room ID already exists');
          return;
        }
      } else {
        let attempts = 0;
        do {
          finalRoomId = generateRoomId();
          attempts++;
        } while (rooms.has(finalRoomId) && attempts < 10);
      }

      const room = {
        id: finalRoomId,
        host: socket.id,
        users: new Set([socket.id]),
        settings: settings,
        gameStarted: false,
        createdAt: Date.now()
      };

      rooms.set(finalRoomId, room);
      userRooms.set(socket.id, finalRoomId);
      socket.join(finalRoomId);
      
      console.log(`Room ${finalRoomId} created by ${socket.id} (${nickname})`);
      socket.emit('room-created', { success: true, roomId: finalRoomId });
      socket.emit('existing-users', []);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('room-error', 'Failed to create room');
    }
  });

  socket.on('join-room', (data) => {
    try {
      let roomId, password;
      
      if (typeof data === 'string') {
        roomId = data;
      } else if (data && typeof data === 'object') {
        roomId = data.roomId;
        password = data.password;
      }

      if (!roomId || typeof roomId !== 'string' || !/^\d{6}$/.test(roomId)) {
        socket.emit('room-error', 'Invalid room ID. Must be 6 digits.');
        return;
      }

      const room = rooms.get(roomId);
      
      if (!room) {
        socket.emit('room-error', 'Room does not exist');
        return;
      }

      if (room.settings.isPrivate) {
        if (!password) {
          socket.emit('password-required', roomId);
          return; 
        }
        if (room.settings.password !== password) {
          socket.emit('room-error', 'Incorrect password');
          return;
        }
      }

      if (room.gameStarted) {
        socket.emit('room-error', 'Game already in progress');
        return;
      }

      if (room.users.size >= room.settings.maxUsers) {
        socket.emit('room-error', 'Room is full');
        return;
      }

      if (room.users.has(socket.id)) {
        socket.emit('room-error', 'Already in room');
        return;
      }

      socket.join(roomId);
      userRooms.set(socket.id, roomId);
      room.users.add(socket.id);
      
      // Send existing users with their info
      const existingUsers = Array.from(room.users)
        .filter(id => id !== socket.id)
        .map(id => {
          const user = socketToUser.get(id);
          return {
            id,
            nickname: user?.nickname || 'Unknown',
            deviceId: user?.deviceId || ''
          };
        });

      socket.emit('room-joined', {
        settings: room.settings,
        gameStarted: room.gameStarted,
        host: room.host,
        roomId: roomId
      });
      socket.emit('existing-users', existingUsers);
      
      // Notify others about the new user
      socket.to(roomId).emit('user-joined', {
        id: socket.id,
        nickname,
        deviceId
      });
      
      console.log(`User ${socket.id} (${nickname}) joined room ${roomId} (${room.users.size}/${room.settings.maxUsers})`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('room-error', 'Failed to join room');
    }
  });

  socket.on('get-public-rooms', () => {
    try {
      const publicRooms = [];
      rooms.forEach((room, roomId) => {
        if (!room.settings.isPrivate && !room.gameStarted) {
          publicRooms.push({
            id: roomId,
            name: room.settings.roomName,
            playerCount: room.users.size,
            maxPlayers: room.settings.maxUsers,
            settings: {
              maxUsers: room.settings.maxUsers,
              answerTime: room.settings.answerTime,
              questionCount: room.settings.questionCount
            }
          });
        }
      });
      socket.emit('public-rooms', publicRooms);
    } catch (error) {
      console.error('Error getting public rooms:', error);
      socket.emit('room-error', 'Failed to get public rooms');
    }
  });

  socket.on('leave-room', () => {
    try {
      const roomId = userRooms.get(userIdentifier);
      if (roomId) {
        removeUserFromRoom(userIdentifier, roomId);
        socket.leave(roomId);
        socket.to(roomId).emit('user-left', userIdentifier);
        console.log(`User ${userIdentifier} left room ${roomId}`);
      }
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  });

  socket.on('start-game', () => {
    try {
      const roomId = userRooms.get(userIdentifier);
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room || room.host !== userIdentifier || room.gameStarted) {
        socket.emit('room-error', 'Cannot start game');
        return;
      }

      if (room.users.size < 2) {
        socket.emit('room-error', 'Need at least 2 players');
        return;
      }

      room.gameStarted = true;
      socket.to(roomId).emit('game-started');
      console.log(`Game started in room ${roomId} by ${userIdentifier}`);
    } catch (error) {
      console.error('Error starting game:', error);
      socket.emit('room-error', 'Failed to start game');
    }
  });

  socket.on('offer', (data) => {
    try {
      if (!data || !data.target || !data.sdp) {
        console.warn('Invalid offer data');
        return;
      }

      socket.to(data.target).emit('offer', {
        sdp: data.sdp,
        sender: userIdentifier
      });
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  });

  socket.on('answer', (data) => {
    try {
      if (!data || !data.target || !data.sdp) {
        console.warn('Invalid answer data');
        return;
      }

      socket.to(data.target).emit('answer', {
        sdp: data.sdp,
        sender: userIdentifier
      });
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  });

  socket.on('ice-candidate', (data) => {
    try {
      if (!data || !data.target || !data.candidate) {
        console.warn('Invalid ICE candidate data');
        return;
      }

      socket.to(data.target).emit('ice-candidate', {
        candidate: data.candidate,
        sender: userIdentifier
      });
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  });

  socket.on('game-event', (data) => {
    try {
      const roomId = userRooms.get(userIdentifier);
      if (roomId && data) {
        socket.to(roomId).emit('game-event', {
          ...data,
          sender: userIdentifier,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Error handling game event:', error);
    }
  });

  socket.on('disconnect', (reason) => {
    const userData = socketToUser.get(socket.id);
    console.log('User disconnected:', socket.id, userData?.nickname, 'Reason:', reason);
    
    try {
      const roomId = userRooms.get(socket.id);
      if (roomId) {
        removeUserFromRoom(socket.id, roomId);
        socket.to(roomId).emit('user-left', socket.id);
      }
      
      if (userData) {
        activeNicknames.delete(userData.deviceId);
      }
      socketToUser.delete(socket.id);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', socket.id, error);
  });
});

setInterval(() => {
  try {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let cleanedRooms = 0;
    
    rooms.forEach((room, roomId) => {
      if (now - room.createdAt > oneHour) {
        room.users.forEach(userId => userRooms.delete(userId));
        rooms.delete(roomId);
        cleanedRooms++;
      }
    });
    
    if (cleanedRooms > 0) {
      console.log(`Cleaned up ${cleanedRooms} old rooms`);
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}, 10 * 60 * 1000);

io.engine.on('connection_error', (err) => {
  console.error('Connection error:', err.req.url, err.code, err.message, err.context);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
