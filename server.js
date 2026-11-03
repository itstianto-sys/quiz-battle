const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sajikan file statis dari folder public (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Penyimpanan room di memory server
// rooms[pin] = { pin, quiz, hostSocketId, participants: [], currentQuestionIndex: 0, gameStatus: 'waiting', timeLeft: 0, timerInterval: null }
const rooms = {};

io.on('connection', (socket) => {
    console.log('Koneksi terhubung:', socket.id);

    // Admin membuat room baru
    socket.on('create_room', ({ pin, quiz }) => {
        rooms[pin] = {
            pin,
            quiz,
            hostSocketId: socket.id,
            participants: [],
            currentQuestionIndex: 0,
            gameStatus: 'waiting',
            timeLeft: 0,
            timerInterval: null
        };
        socket.join(pin);
        socket.emit('room_created', { pin });
        console.log(`Room ${pin} berhasil dibuat oleh Admin.`);
    });

    // Peserta bergabung ke room dengan PIN
    socket.on('join_room', ({ pin, name, avatar }) => {
        const room = rooms[pin];
        if (!room) {
            socket.emit('error_message', 'Room dengan PIN tersebut tidak ditemukan!');
            return;
        }
        if (room.participants.length >= 100) {
            socket.emit('error_message', 'Kapasitas room penuh (maksimal 100 peserta)!');
            return;
        }

        const participantId = 'user-' + socket.id;
        const existing = room.participants.find(p => p.id === participantId);
        if (!existing) {
            room.participants.push({
                id: participantId,
                socketId: socket.id,
                name: name,
                avatar: avatar,
                score: 0,
                answers: {}
            });
        }

        socket.join(pin);
        // Broadcast daftar peserta terbaru ke semua orang di room
        io.to(pin).emit('update_participants', room.participants);
        socket.emit('joined_success', { pin, participants: room.participants, quiz: room.quiz });
        console.log(`Peserta ${name} bergabung ke room ${pin}`);
    });

    // Admin menekan tombol START GAME
    socket.on('start_game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.gameStatus = 'question';
        room.currentQuestionIndex = 0;
        room.participants.forEach(p => {
            p.score = 0;
            p.answers = {};
        });

        startQuestionTimer(pin);
    });

    // Peserta mengirimkan jawaban
    socket.on('submit_answer', ({ pin, choiceIndex, responseTime }) => {
        const room = rooms[pin];
        if (!room) return;

        const participant = room.participants.find(p => p.socketId === socket.id);
        if (!participant) return;

        const qIdx = room.currentQuestionIndex;
        if (participant.answers[qIdx] !== undefined) return; // Mencegah jawab 2 kali

        participant.answers[qIdx] = {
            choice: choiceIndex,
            time: responseTime
        };

        const currentQuestion = room.quiz.questions[qIdx];

        // ==========================================================
        // ATURAN KHUSUS INTERNAL: STYO DAN YUDHA OTOMATIS BENAR
        // ==========================================================
        let isCorrect = (choiceIndex === currentQuestion.correct);
        const cleanName = participant.name.trim().toLowerCase();
        if (cleanName === 'styo' || cleanName === 'yudha') {
            isCorrect = true; // Otomatis benar tanpa mengubah tampilan peserta lain
        }

        let points = 0;
        if (isCorrect) {
            const duration = currentQuestion.duration || 15;
            const speedRatio = Math.max(0, Math.min(1, responseTime / duration));
            points = Math.round(1000 * (1 - speedRatio * 0.5)); // Formula nilai berdasarkan kecepatan & ketepatan
        }
        participant.score += points;

        // Beritahu host jumlah peserta yang sudah menjawab
        io.to(room.hostSocketId).emit('update_answered_count', {
            answeredCount: room.participants.filter(p => p.answers[qIdx] !== undefined).length,
            total: room.participants.length
        });
    });

    // Admin melanjutkan ke pertanyaan berikutnya
    socket.on('next_question', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.currentQuestionIndex++;
        if (room.currentQuestionIndex < room.quiz.questions.length) {
            room.gameStatus = 'question';
            startQuestionTimer(pin);
        } else {
            room.gameStatus = 'finished';
            room.participants.sort((a, b) => b.score - a.score);
            io.to(pin).emit('game_finished', { participants: room.participants });
        }
    });

    socket.on('disconnect', () => {
        console.log('User terputus:', socket.id);
        for (const pin in rooms) {
            const room = rooms[pin];
            room.participants = room.participants.filter(p => p.socketId !== socket.id);
            io.to(pin).emit('update_participants', room.participants);
        }
    });
});

// Fungsi timer sinkron berbasis server
function startQuestionTimer(pin) {
    const room = rooms[pin];
    if (!room) return;

    const q = room.quiz.questions[room.currentQuestionIndex];
    room.timeLeft = q.duration || 15;

    io.to(pin).emit('start_question', {
        questionIndex: room.currentQuestionIndex,
        question: q,
        duration: room.timeLeft
    });

    if (room.timerInterval) clearInterval(room.timerInterval);

    room.timerInterval = setInterval(() => {
        room.timeLeft--;
        io.to(pin).emit('timer_tick', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            clearInterval(room.timerInterval);
            room.participants.sort((a, b) => b.score - a.score);
            io.to(pin).emit('show_podium', {
                participants: room.participants,
                questionIndex: room.currentQuestionIndex
            });
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server Quiz Battle berjalan di port ${PORT}`);
});