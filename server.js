// SanusX Modern Signaling Server (server.js)

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const PORT = process.env.PORT || 4000; // Port for the signaling server

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for now, restrict in production
        methods: ["GET", "POST"]
    }
});

// In-memory data stores (for simplicity, consider a DB for production)
let onlineUsers = {}; // { userId: { socketId, displayName, currentRoomId }, ... }
let rooms = {};       // { roomId: { id, name, ownerId, participants: { userId: socketId } }, ... }

console.log("Server.js: Initializing modules...");

// --- ConnectionManager (Basic Implementation) ---
io.on("connection", (socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.on("register_user", (data) => {
        if (data && data.userId && data.displayName) {
            onlineUsers[data.userId] = {
                socketId: socket.id,
                displayName: data.displayName,
                currentRoomId: null
            };
            socket.userId = data.userId; // Associate userId with the socket for easier lookup
            console.log(`User registered: ${data.displayName} (ID: ${data.userId}, Socket: ${socket.id})`);
            broadcastPresenceUpdate();
            socket.emit("registration_successful", { userId: data.userId, socketId: socket.id });
        } else {
            console.log(`Invalid registration data from socket ${socket.id}`);
            socket.emit("registration_failed", { message: "Invalid user data for registration." });
        }
    });

    // --- RoomManager (Basic Implementation) ---
    socket.on("create_room", (data) => {
        if (!socket.userId) return socket.emit("error_message", "User not registered.");
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        rooms[roomId] = {
            id: roomId,
            name: data.roomName || `Mentoria de ${onlineUsers[socket.userId]?.displayName || socket.userId}`,
            ownerId: socket.userId,
            participants: {}
        };
        console.log(`Room created: ${roomId} by ${socket.userId}`);
        joinRoom(socket, roomId);
    });

    socket.on("join_room", (data) => {
        if (!socket.userId) return socket.emit("error_message", "User not registered.");
        if (rooms[data.roomId]) {
            joinRoom(socket, data.roomId);
        } else {
            socket.emit("error_message", "Sala não encontrada.");
        }
    });

    socket.on("leave_room", (data) => {
        if (socket.currentRoomId) {
            leaveRoom(socket, socket.currentRoomId);
        }
    });

    // --- WebRTCHandler (Signaling messages) ---
    socket.on("webrtc_offer", (data) => {
        // data = { targetUserId, roomId, sdp }
        console.log(`Offer from ${socket.userId} to ${data.targetUserId} in room ${data.roomId}`);
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_offer", { 
                senderUserId: socket.userId, 
                sdp: data.sdp,
                roomId: data.roomId
            });
        }
    });

    socket.on("webrtc_answer", (data) => {
        // data = { targetUserId, roomId, sdp }
        console.log(`Answer from ${socket.userId} to ${data.targetUserId} in room ${data.roomId}`);
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_answer", { 
                senderUserId: socket.userId, 
                sdp: data.sdp,
                roomId: data.roomId
            });
        }
    });

    socket.on("webrtc_ice_candidate", (data) => {
        // data = { targetUserId, roomId, candidate }
        // console.log(`ICE Candidate from ${socket.userId} to ${data.targetUserId} in room ${data.roomId}`);
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_ice_candidate", { 
                senderUserId: socket.userId, 
                candidate: data.candidate,
                roomId: data.roomId
            });
        }
    });

    // --- ChatManager (Basic Implementation) ---
    socket.on("chat_message", (data) => {
        // data = { roomId, messageText }
        if (!socket.userId || !data.roomId || !rooms[data.roomId]) return;
        if (rooms[data.roomId].participants[socket.userId]) { // User must be in the room
            const messagePayload = {
                senderUserId: socket.userId,
                senderDisplayName: onlineUsers[socket.userId]?.displayName,
                messageText: data.messageText,
                timestamp: Date.now()
            };
            // Broadcast to all participants in the room including sender
            Object.values(rooms[data.roomId].participants).forEach(participantSocketId => {
                io.to(participantSocketId).emit("chat_message", messagePayload);
            });
            console.log(`Chat in room ${data.roomId} by ${socket.userId}: ${data.messageText}`);
        }
    });
    
    // --- Mentor Controls ---
    socket.on("mentor_mute_participant", (data) => { // { roomId, targetUserId }
        if (!socket.userId || !rooms[data.roomId] || !onlineUsers[socket.userId] || rooms[data.roomId].ownerId !== socket.userId) {
            return socket.emit("error_message", "Ação não permitida.");
        }
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId && rooms[data.roomId].participants[data.targetUserId]) {
            io.to(targetSocketId).emit("force_mute", { by: socket.userId });
            console.log(`Mentor ${socket.userId} muted ${data.targetUserId} in room ${data.roomId}`);
        }
    });

    socket.on("mentor_remove_participant", (data) => { // { roomId, targetUserId }
         if (!socket.userId || !rooms[data.roomId] || !onlineUsers[socket.userId] || rooms[data.roomId].ownerId !== socket.userId) {
            return socket.emit("error_message", "Ação não permitida.");
        }
        const targetSocket = io.sockets.sockets.get(onlineUsers[data.targetUserId]?.socketId);
        if (targetSocket && rooms[data.roomId].participants[data.targetUserId]) {
            targetSocket.emit("removed_from_room", { roomId: data.roomId, by: socket.userId });
            leaveRoom(targetSocket, data.roomId); // Make the user leave the room on server-side too
            console.log(`Mentor ${socket.userId} removed ${data.targetUserId} from room ${data.roomId}`);
        }
    });


    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id} (User ID: ${socket.userId})`);
        if (socket.userId) {
            if (socket.currentRoomId) {
                leaveRoom(socket, socket.currentRoomId);
            }
            delete onlineUsers[socket.userId];
            broadcastPresenceUpdate();
        }
    });
});

function joinRoom(socket, roomId) {
    if (!rooms[roomId] || !onlineUsers[socket.userId]) return;
    if (Object.keys(rooms[roomId].participants).length >= 20) {
        return socket.emit("error_message", "A sala está cheia.");
    }

    // Leave previous room if any
    if (socket.currentRoomId && socket.currentRoomId !== roomId) {
        leaveRoom(socket, socket.currentRoomId);
    }

    socket.join(roomId); // Socket.io room feature
    rooms[roomId].participants[socket.userId] = socket.id;
    onlineUsers[socket.userId].currentRoomId = roomId;
    socket.currentRoomId = roomId;

    console.log(`User ${socket.userId} joined room ${roomId}`);
    socket.emit("joined_room_successfully", { 
        roomId: roomId, 
        roomName: rooms[roomId].name,
        participants: getRoomParticipantDetails(roomId) 
    });

    // Notify other participants in the room
    socket.to(roomId).emit("participant_joined", {
        userId: socket.userId,
        displayName: onlineUsers[socket.userId]?.displayName,
        socketId: socket.id
    });
    // No need to call broadcastRoomUpdate for join, participant_joined handles it for others
}

function leaveRoom(socket, roomId) {
    if (!rooms[roomId] || !onlineUsers[socket.userId] || !rooms[roomId].participants[socket.userId]) return;

    socket.leave(roomId);
    delete rooms[roomId].participants[socket.userId];
    onlineUsers[socket.userId].currentRoomId = null;
    socket.currentRoomId = null;

    console.log(`User ${socket.userId} left room ${roomId}`);
    socket.emit("left_room_successfully", { roomId: roomId });

    // Notify other participants in the room
    io.to(roomId).emit("participant_left", { 
        userId: socket.userId,
        displayName: onlineUsers[socket.userId]?.displayName 
    });

    if (Object.keys(rooms[roomId].participants).length === 0) {
        console.log(`Room ${roomId} is empty, deleting.`);
        delete rooms[roomId];
    }
}

function getRoomParticipantDetails(roomId) {
    if (!rooms[roomId]) return {};
    const participantDetails = {};
    for (const userId in rooms[roomId].participants) {
        participantDetails[userId] = {
            displayName: onlineUsers[userId]?.displayName,
            socketId: onlineUsers[userId]?.socketId
            // Add more details if needed
        };
    }
    return participantDetails;
}

function broadcastPresenceUpdate() {
    const presenceData = {};
    for (const userId in onlineUsers) {
        presenceData[userId] = {
            displayName: onlineUsers[userId].displayName,
            isOnline: true, // Basic presence
            currentRoomId: onlineUsers[userId].currentRoomId
        };
    }
    io.emit("presence_update", presenceData);
    console.log("Broadcasted presence update:", Object.keys(presenceData).length, "users online.");
}

server.listen(PORT, () => {
    console.log(`Signaling server listening on port ${PORT}`);
});

// Basic health check endpoint (optional with Express)
app.get("/health", (req, res) => {
    res.status(200).send("Signaling Server is healthy.");
});

