// server.js - Fighting Game Multiplayer Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Game state management
const lobbies = new Map();
const players = new Map();

// Lobby class for better organization
class GameLobby {
    constructor(id, hostId) {
        this.id = id;
        this.hostId = hostId;
        this.players = new Map();
        this.readyPlayers = new Set();
        this.gameState = 'waiting';
        this.maxPlayers = 2;
        this.createdAt = Date.now();
        this.gameData = {
            timer: 60,
            scores: { [hostId]: 0 }
        };
    }

    addPlayer(playerId, socket) {
        if (this.players.size >= this.maxPlayers) {
            return { success: false, error: 'Lobby is full' };
        }

        this.players.set(playerId, {
            id: playerId,
            socket: socket,
            isHost: playerId === this.hostId,
            ready: false,
            connected: true
        });

        if (this.players.size === 1) {
            this.gameData.scores[playerId] = 0;
        }

        return { success: true };
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        this.readyPlayers.delete(playerId);
        
        if (playerId === this.hostId && this.players.size > 0) {
            const newHost = this.players.keys().next().value;
            this.hostId = newHost;
            this.players.get(newHost).isHost = true;
        }
    }

    setPlayerReady(playerId, ready) {
        const player = this.players.get(playerId);
        if (player) {
            player.ready = ready;
            if (ready) {
                this.readyPlayers.add(playerId);
            } else {
                this.readyPlayers.delete(playerId);
            }
        }
    }

    canStartGame() {
        return this.players.size === this.maxPlayers && 
               this.readyPlayers.size === this.maxPlayers;
    }

    broadcastToLobby(event, data, excludePlayer = null) {
        this.players.forEach((player, playerId) => {
            if (playerId !== excludePlayer && player.connected) {
                player.socket.emit(event, data);
            }
        });
    }

    getLobbyState() {
        const playerList = Array.from(this.players.values()).map(p => ({
            id: p.id,
            isHost: p.isHost,
            ready: p.ready,
            connected: p.connected
        }));

        return {
            id: this.id,
            playerCount: this.players.size,
            maxPlayers: this.maxPlayers,
            players: playerList,
            gameState: this.gameState,
            canStart: this.canStartGame()
        };
    }
}

// Generate 4-digit lobby code
function generateLobbyCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (lobbies.has(code));
    return code;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    players.set(socket.id, {
        id: socket.id,
        socket: socket,
        lobbyId: null,
        lastSeen: Date.now()
    });

    // Create lobby
    socket.on('create_lobby', (data) => {
        const lobbyId = generateLobbyCode();
        const lobby = new GameLobby(lobbyId, socket.id);
        
        const result = lobby.addPlayer(socket.id, socket);
        if (result.success) {
            lobbies.set(lobbyId, lobby);
            players.get(socket.id).lobbyId = lobbyId;
            
            socket.join(lobbyId);
            socket.emit('lobby_created', {
                lobbyId: lobbyId,
                isHost: true,
                lobbyState: lobby.getLobbyState()
            });
            
            console.log(`Lobby created: ${lobbyId} by ${socket.id}`);
        }
    });

    // Join lobby
    socket.on('join_lobby', (data) => {
        const { lobbyId } = data;
        const lobby = lobbies.get(lobbyId);
        
        if (!lobby) {
            socket.emit('lobby_error', { error: 'Lobby not found' });
            return;
        }

        const result = lobby.addPlayer(socket.id, socket);
        if (result.success) {
            players.get(socket.id).lobbyId = lobbyId;
            socket.join(lobbyId);
            
            socket.emit('lobby_joined', {
                lobbyId: lobbyId,
                isHost: false,
                lobbyState: lobby.getLobbyState()
            });
            
            lobby.broadcastToLobby('lobby_updated', lobby.getLobbyState());
            
            console.log(`Player ${socket.id} joined lobby ${lobbyId}`);
        } else {
            socket.emit('lobby_error', result);
        }
    });

    // Player ready/unready
    socket.on('player_ready', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;

        lobby.setPlayerReady(socket.id, data.ready);
        lobby.broadcastToLobby('lobby_updated', lobby.getLobbyState());
        
        if (lobby.canStartGame()) {
            lobby.gameState = 'fighting';
            lobby.broadcastToLobby('game_start', {
                players: Array.from(lobby.players.keys()),
                gameData: lobby.gameData
            });
            
            console.log(`Game starting in lobby ${lobby.id}`);
        }
    });

    // Game input handling
    socket.on('game_input', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || lobby.gameState !== 'fighting') return;

        const inputData = {
            ...data,
            playerId: socket.id,
            serverTimestamp: Date.now()
        };

        lobby.broadcastToLobby('game_input', inputData, socket.id);
    });

    // Game state updates
    socket.on('game_update', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || lobby.gameState !== 'fighting') return;

        if (data.health !== undefined) {
            lobby.gameData.playerHealth = lobby.gameData.playerHealth || {};
            lobby.gameData.playerHealth[socket.id] = data.health;
        }

        lobby.broadcastToLobby('game_update', {
            ...data,
            playerId: socket.id,
            serverTimestamp: Date.now()
        }, socket.id);
    });

    // Game over
    socket.on('game_over', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;

        lobby.gameState = 'finished';
        lobby.broadcastToLobby('game_over', {
            winner: data.winner,
            stats: data.stats,
            serverTimestamp: Date.now()
        });

        setTimeout(() => {
            if (lobby.players.size > 0) {
                lobby.gameState = 'waiting';
                lobby.readyPlayers.clear();
                lobby.players.forEach(p => p.ready = false);
                lobby.broadcastToLobby('lobby_updated', lobby.getLobbyState());
            }
        }, 5000);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const player = players.get(socket.id);
        if (player && player.lobbyId) {
            const lobby = lobbies.get(player.lobbyId);
            if (lobby) {
                lobby.removePlayer(socket.id);
                
                if (lobby.players.size === 0) {
                    lobbies.delete(player.lobbyId);
                    console.log(`Lobby ${player.lobbyId} deleted (empty)`);
                } else {
                    lobby.broadcastToLobby('player_disconnected', {
                        playerId: socket.id,
                        lobbyState: lobby.getLobbyState()
                    });
                }
            }
        }
        
        players.delete(socket.id);
    });

    // Heartbeat
    socket.on('ping', () => {
        socket.emit('pong');
        const player = players.get(socket.id);
        if (player) {
            player.lastSeen = Date.now();
        }
    });
});

// API endpoints
app.get('/api/stats', (req, res) => {
    res.json({
        connectedPlayers: players.size,
        activeLobbies: lobbies.size,
        lobbies: Array.from(lobbies.values()).map(lobby => ({
            id: lobby.id,
            playerCount: lobby.players.size,
            gameState: lobby.gameState,
            createdAt: lobby.createdAt
        }))
    });
});

app.get('/api/lobby/:id', (req, res) => {
    const lobby = lobbies.get(req.params.id);
    if (lobby) {
        res.json(lobby.getLobbyState());
    } else {
        res.status(404).json({ error: 'Lobby not found' });
    }
});

// Cleanup old lobbies
setInterval(() => {
    const now = Date.now();
    const oldLobbies = [];
    
    lobbies.forEach((lobby, id) => {
        if (lobby.players.size === 0 && (now - lobby.createdAt) > 3600000) {
            oldLobbies.push(id);
        }
    });
    
    oldLobbies.forEach(id => {
        lobbies.delete(id);
        console.log(`Cleaned up old lobby: ${id}`);
    });
}, 300000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Fighting Game Server running on port ${PORT}`);
    console.log(`📊 Stats available at http://localhost:${PORT}/api/stats`);
});