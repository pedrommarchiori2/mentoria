// SanusX Modern Signaling Server (server.js)

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");

const PORT = process.env.PORT || 4000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for now, restrict in production
        methods: ["GET", "POST"]
    }
});

let onlineUsers = {}; // { userId: { socketId, displayName, isMentor }, ... }
const defaultMentoriaRoomId = "default_mentoria_room";

// Structure for mentoria rooms
let mentoriaRooms = {
    [defaultMentoriaRoomId]: {
        id: defaultMentoriaRoomId,
        name: "Sala de Mentoria Principal",
        mentorId: null, // The first registered mentor claims this room or a designated one
        participants: {}, // { userId: { socketId, displayName, status: 'joined'/'pending_approval' } }
        pendingRequests: {}, // { userId: { socketId, displayName } }
        invitedUsers: {} // { userId: inviterId }
    }
};

console.log("Server.js: Initializing...");

io.on("connection", (socket) => {
    console.log(`New client connected: ${socket.id}`);

    socket.on("register_user", (data) => {
        if (data && data.userId && data.displayName) {
            onlineUsers[data.userId] = {
                socketId: socket.id,
                displayName: data.displayName,
                isMentor: data.isMentor || false // Client now sends this
            };
            socket.userId = data.userId;
            socket.isMentor = data.isMentor || false;
            console.log(`User registered: ${data.displayName} (ID: ${data.userId}, Mentor: ${socket.isMentor}, Socket: ${socket.id})`);
            
            // If this is the first mentor, assign them to the default mentoria room
            if (socket.isMentor && !mentoriaRooms[defaultMentoriaRoomId].mentorId) {
                mentoriaRooms[defaultMentoriaRoomId].mentorId = socket.userId;
                console.log(`Mentor ${socket.userId} assigned to default mentoria room.`);
            }
            
            socket.emit("registration_successful", { userId: data.userId, socketId: socket.id });
            broadcastPresenceUpdate(); // General presence update
        } else {
            socket.emit("registration_failed", { message: "Invalid user data." });
        }
    });

    // --- Mentoria Access Control ---
    socket.on("mentoria_check_access_status", (data) => {
        if (!socket.userId || !data.roomId) return;
        const room = mentoriaRooms[data.roomId];
        if (!room) return socket.emit("error_message", "Sala de mentoria não encontrada.");

        if (room.participants[socket.userId] && room.participants[socket.userId].status === 'joined') {
            socket.emit("mentoria_access_status", { status: "approved" });
        } else if (room.pendingRequests[socket.userId]) {
            socket.emit("mentoria_access_status", { status: "pending_approval" });
        } else if (room.invitedUsers[socket.userId]) {
            // If invited but not yet joined, could prompt to accept again or auto-join
            socket.emit("mentoria_access_status", { status: "invited_pending_join" }); 
        } else {
            socket.emit("mentoria_access_status", { status: "not_joined" });
        }
    });

    socket.on("mentoria_request_join", (data) => {
        if (!socket.userId || !data.roomId || !onlineUsers[socket.userId]) return;
        const room = mentoriaRooms[data.roomId];
        if (!room) return socket.emit("error_message", "Sala de mentoria não encontrada.");
        if (room.participants[socket.userId]) return socket.emit("error_message", "Você já está na sala ou sua solicitação está pendente.");

        room.pendingRequests[socket.userId] = { 
            socketId: socket.id, 
            displayName: onlineUsers[socket.userId].displayName 
        };
        console.log(`User ${socket.userId} requested to join room ${data.roomId}`);
        socket.emit("mentoria_access_status", { status: "pending_approval" });

        // Notify mentor
        const mentorSocketId = room.mentorId ? onlineUsers[room.mentorId]?.socketId : null;
        if (mentorSocketId) {
            io.to(mentorSocketId).emit("mentoria_join_request_to_mentor", {
                requestingUserId: socket.userId,
                requestingUserDisplayName: onlineUsers[socket.userId].displayName,
                roomId: data.roomId
            });
        }
    });

    socket.on("mentoria_invite_user", (data) => {
        if (!socket.isMentor || !data.roomId || !data.targetUserId || !onlineUsers[data.targetUserId]) return socket.emit("error_message", "Ação não permitida ou usuário não encontrado.");
        const room = mentoriaRooms[data.roomId];
        if (!room || room.mentorId !== socket.userId) return socket.emit("error_message", "Você não é o mentor desta sala.");

        room.invitedUsers[data.targetUserId] = socket.userId; // Store who invited
        const targetSocketId = onlineUsers[data.targetUserId].socketId;
        io.to(targetSocketId).emit("mentoria_invitation_received", {
            roomId: data.roomId,
            inviterId: socket.userId,
            inviterName: onlineUsers[socket.userId].displayName
        });
        console.log(`Mentor ${socket.userId} invited ${data.targetUserId} to room ${data.roomId}`);
    });

    socket.on("mentoria_accept_invitation", (data) => {
        if (!socket.userId || !data.roomId) return;
        const room = mentoriaRooms[data.roomId];
        if (!room || !room.invitedUsers[socket.userId] || room.invitedUsers[socket.userId] !== data.inviterId) {
            return socket.emit("error_message", "Convite inválido ou expirado.");
        }
        delete room.invitedUsers[socket.userId];
        addUserToMentoriaRoom(socket, data.roomId, onlineUsers[socket.userId].displayName, "invited_joined");
    });

    socket.on("mentoria_approve_request", (data) => {
        if (!socket.isMentor || !data.roomId || !data.targetUserId) return socket.emit("error_message", "Ação não permitida.");
        const room = mentoriaRooms[data.roomId];
        if (!room || room.mentorId !== socket.userId || !room.pendingRequests[data.targetUserId]) return socket.emit("error_message", "Solicitação não encontrada ou você não é o mentor.");

        const targetUserSocketId = room.pendingRequests[data.targetUserId].socketId;
        const targetUserDisplayName = room.pendingRequests[data.targetUserId].displayName;
        delete room.pendingRequests[data.targetUserId];
        
        // Find the actual socket of the target user to add them
        const targetSocket = io.sockets.sockets.get(targetUserSocketId);
        if (targetSocket) {
             addUserToMentoriaRoom(targetSocket, data.roomId, targetUserDisplayName, "approved");
        } else {
            console.error("Socket do usuário aprovado não encontrado:", targetUserSocketId);
            // User might have disconnected, handle this case
        }
    });

    socket.on("mentoria_deny_request", (data) => {
        if (!socket.isMentor || !data.roomId || !data.targetUserId) return socket.emit("error_message", "Ação não permitida.");
        const room = mentoriaRooms[data.roomId];
        if (!room || room.mentorId !== socket.userId || !room.pendingRequests[data.targetUserId]) return socket.emit("error_message", "Solicitação não encontrada ou você não é o mentor.");

        const targetSocketId = room.pendingRequests[data.targetUserId].socketId;
        delete room.pendingRequests[data.targetUserId];
        io.to(targetSocketId).emit("mentoria_access_status", { status: "denied" });
        console.log(`Mentor ${socket.userId} denied request from ${data.targetUserId} for room ${data.roomId}`);
    });

    socket.on("mentoria_user_ready_for_webrtc", (data) => {
        if (!socket.userId || !data.roomId) return;
        const room = mentoriaRooms[data.roomId];
        if (!room || !room.participants[socket.userId] || room.participants[socket.userId].status !== 'joined') {
            return socket.emit("error_message", "Usuário não autorizado ou não está na sala para iniciar WebRTC.");
        }
        console.log(`Usuário ${socket.userId} está pronto para WebRTC na sala ${data.roomId}. Notificando outros.`);
        // Notify other participants to initiate/receive WebRTC connections
        Object.keys(room.participants).forEach(participantId => {
            if (participantId !== socket.userId && room.participants[participantId].status === 'joined') {
                const participantSocketId = room.participants[participantId].socketId;
                // This client (socket.userId) should now offer to existing participants
                io.to(socket.id).emit("mentoria_initiate_webrtc_with_peer", { peerUserId: participantId });
                // Existing participants should now offer to this new client
                io.to(participantSocketId).emit("mentoria_initiate_webrtc_with_peer", { peerUserId: socket.userId });
            }
        });
        broadcastMentoriaRoomParticipants(data.roomId);
    });

    socket.on("mentoria_leave_room", (data) => {
        if (socket.userId && data.roomId) {
            removeUserFromMentoriaRoom(socket, data.roomId);
        }
    });

    // --- WebRTCHandler (Signaling messages for Mentoria and Checklist) ---
    socket.on("webrtc_offer", (data) => {
        if (!socket.userId || !data.targetUserId || !data.sdp) return;
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_offer", { 
                senderUserId: socket.userId, 
                sdp: data.sdp,
                roomId: data.roomId // roomId is crucial for mentoria context
            });
        }
    });

    socket.on("webrtc_answer", (data) => {
        if (!socket.userId || !data.targetUserId || !data.sdp) return;
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_answer", { 
                senderUserId: socket.userId, 
                sdp: data.sdp,
                roomId: data.roomId // roomId is crucial for mentoria context
            });
        }
    });

    socket.on("webrtc_ice_candidate", (data) => {
        if (!socket.userId || !data.targetUserId || !data.candidate) return;
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("webrtc_ice_candidate", { 
                senderUserId: socket.userId, 
                candidate: data.candidate,
                roomId: data.roomId // roomId is crucial for mentoria context
            });
        }
    });

    // --- ChatManager (Mentoria) ---
    socket.on("chat_message", (data) => {
        if (!socket.userId || !data.roomId || !mentoriaRooms[data.roomId] || !data.messageText) return;
        const room = mentoriaRooms[data.roomId];
        if (room.participants[socket.userId] && room.participants[socket.userId].status === 'joined') {
            const messagePayload = {
                roomId: data.roomId,
                senderUserId: socket.userId,
                senderDisplayName: onlineUsers[socket.userId]?.displayName,
                messageText: data.messageText,
                timestamp: Date.now()
            };
            Object.keys(room.participants).forEach(participantId => {
                if (room.participants[participantId].status === 'joined') {
                    io.to(room.participants[participantId].socketId).emit("chat_message", messagePayload);
                }
            });
            console.log(`Chat in room ${data.roomId} by ${socket.userId}: ${data.messageText}`);
        }
    });

    // --- 1x1 Call (Checklist) ---
    socket.on("end_call_1x1", (data) => {
        if (!socket.userId || !data.targetUserId) return;
        const targetSocketId = onlineUsers[data.targetUserId]?.socketId;
        if (targetSocketId) {
            io.to(targetSocketId).emit("call_ended_notification", { senderUserId: socket.userId });
        }
        console.log(`User ${socket.userId} ended 1x1 call with ${data.targetUserId}`);
    });

    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id} (User ID: ${socket.userId})`);
        if (socket.userId) {
            // If user was in a mentoria room, remove them
            const room = Object.values(mentoriaRooms).find(r => r.participants[socket.userId]);
            if (room) {
                removeUserFromMentoriaRoom(socket, room.id);
            }
            delete onlineUsers[socket.userId];
            broadcastPresenceUpdate();
        }
    });
});

function addUserToMentoriaRoom(socket, roomId, displayName, joinStatus) {
    const room = mentoriaRooms[roomId];
    if (!room || !socket.userId) return;

    // Prevent adding if already a participant (unless status changes)
    if (room.participants[socket.userId] && room.participants[socket.userId].status === 'joined') {
        console.log(`User ${socket.userId} already joined in room ${roomId}.`);
        return;
    }

    socket.join(roomId); // Socket.IO room feature
    room.participants[socket.userId] = {
        socketId: socket.id,
        displayName: displayName,
        status: 'joined' // Mark as fully joined
    };
    socket.currentRoomId = roomId; // For easier tracking on the socket object itself

    console.log(`User ${displayName} (ID: ${socket.userId}) ${joinStatus} room ${roomId}`);
    socket.emit("mentoria_access_status", { status: joinStatus }); // Inform the user
    
    // Let the user know they are ready for WebRTC (client will then emit 'mentoria_user_ready_for_webrtc')
    // This is slightly different from emitting 'mentoria_user_ready_for_webrtc' directly from server
    // The client, upon receiving 'approved' or 'invited_joined', should then emit 'mentoria_user_ready_for_webrtc'
    // For now, let's assume the client handles this upon receiving the access status.

    broadcastMentoriaRoomParticipants(roomId);
}

function removeUserFromMentoriaRoom(socket, roomId) {
    const room = mentoriaRooms[roomId];
    if (!room || !socket.userId || !room.participants[socket.userId]) return;

    console.log(`User ${socket.userId} leaving room ${roomId}`);
    socket.leave(roomId);
    delete room.participants[socket.userId];
    if (socket.currentRoomId === roomId) socket.currentRoomId = null;

    // If mentor leaves, need a strategy (e.g., end room, promote new mentor)
    // For now, just remove.
    if (room.mentorId === socket.userId) {
        console.log(`Mentor ${socket.userId} left room ${roomId}. Room may need new mentor or close.`);
        // room.mentorId = null; // Or handle closing the room
    }

    broadcastMentoriaRoomParticipants(roomId);
    socket.emit("mentoria_access_status", { status: "not_joined" }); // Update user's own status
}

function broadcastMentoriaRoomParticipants(roomId) {
    const room = mentoriaRooms[roomId];
    if (!room) return;

    const participantDetails = [];
    Object.keys(room.participants).forEach(userId => {
        if (room.participants[userId].status === 'joined') {
            participantDetails.push({
                userId: userId,
                displayName: room.participants[userId].displayName
            });
        }
    });

    console.log(`Broadcasting participants for room ${roomId}:`, participantDetails);
    // Send to all sockets that are *currently joined* in this Socket.IO room
    io.to(roomId).emit("mentoria_room_participants_update", participantDetails);
}

function broadcastPresenceUpdate() {
    const presenceData = {};
    for (const userId in onlineUsers) {
        presenceData[userId] = {
            displayName: onlineUsers[userId].displayName,
            isOnline: true,
            isMentor: onlineUsers[userId].isMentor
        };
    }
    io.emit("presence_update", presenceData);
}

server.listen(PORT, () => {
    console.log(`Signaling server listening on port ${PORT}`);
});

app.get("/health", (req, res) => {
    res.status(200).send("Signaling Server is healthy.");
});

