// ============================================================
//  WebSocket-сервер для мультиплеера Змейки
//  Запуск: npm start (или node server.js)
// ============================================================

const WebSocket = require('ws');

const PORT = 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log('🎮 WebSocket сервер запущен на ws://localhost:' + PORT);

// ============================================================
//  Состояние игры
// ============================================================
const GRID = 20;              // размер клетки в игре
const COLS = 20;              // ширина поля (клеток)
const ROWS = 20;              // высота поля
const TICK_MS = 120;          // частота обновления (мс)

// Комнаты: { roomId: { players: [ws1, ws2], state: {...}, interval } }
const rooms = {};

// ============================================================
//  Создание игры в комнате
// ============================================================
function createGameState() {
    return {
        snakes: [
            {
                body: [{ x: 5, y: 10 }, { x: 4, y: 10 }, { x: 3, y: 10 }],
                dir: { x: 1, y: 0 },
                nextDir: { x: 1, y: 0 },
                color: '#00f0f0',
                score: 0,
                alive: true
            },
            {
                body: [{ x: 15, y: 10 }, { x: 16, y: 10 }, { x: 17, y: 10 }],
                dir: { x: -1, y: 0 },
                nextDir: { x: -1, y: 0 },
                color: '#ff5577',
                score: 0,
                alive: true
            }
        ],
        food: generateFood([
            { x: 5, y: 10 }, { x: 15, y: 10 }
        ]),
        gameOver: false,
        winner: null,
        tick: 0
    };
}

function generateFood(occupied) {
    let food;
    do {
        food = {
            x: Math.floor(Math.random() * COLS),
            y: Math.floor(Math.random() * ROWS)
        };
    } while (occupied.some(p => p.x === food.x && p.y === food.y));
    return food;
}

// ============================================================
//  Тик игры — вызывается каждые TICK_MS
// ============================================================
function tickRoom(roomId) {
    const room = rooms[roomId];
    if (!room || !room.state) return;

    const state = room.state;
    if (state.gameOver) return;

    const occupied = [];

    // Двигаем обе змейки
    state.snakes.forEach((snake, idx) => {
        if (!snake.alive) return;

        snake.dir = snake.nextDir;

        const head = {
            x: snake.body[0].x + snake.dir.x,
            y: snake.body[0].y + snake.dir.y
        };

        // Стены
        if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
            snake.alive = false;
            return;
        }

        // Столкновение с собой
        if (snake.body.some(s => s.x === head.x && s.y === head.y)) {
            snake.alive = false;
            return;
        }

        // Столкновение с другой змейкой
        const other = state.snakes[1 - idx];
        if (other.alive && other.body.some(s => s.x === head.x && s.y === head.y)) {
            snake.alive = false;
            return;
        }

        snake.body.unshift(head);

        // Еда
        if (head.x === state.food.x && head.y === state.food.y) {
            snake.score += 10;
            state.food = generateFood(snake.body);
        } else {
            snake.body.pop();
        }
    });

    // Проверка конца игры
    const alive = state.snakes.filter(s => s.alive);
    if (alive.length < 2) {
        state.gameOver = true;
        state.winner = alive.length === 1
            ? state.snakes.indexOf(alive[0])
            : -1;   // ничья
    }

    state.tick++;

    // Рассылаем состояние обоим игрокам
    const payload = JSON.stringify({
        type: 'state',
        state: {
            snakes: state.snakes.map(s => ({
                body: s.body,
                color: s.color,
                score: s.score,
                alive: s.alive
            })),
            food: state.food,
            gameOver: state.gameOver,
            winner: state.winner,
            cols: COLS,
            rows: ROWS
        }
    });

    room.players.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });

    // Если игра закончилась — остановить цикл через 3 секунды
    if (state.gameOver) {
        clearInterval(room.interval);
        room.interval = null;

        setTimeout(() => {
            if (room.players.length === 2) {
                // Автостарт новой игры
                startGame(roomId);
            }
        }, 3000);
    }
}

// ============================================================
//  Старт игры в комнате
// ============================================================
function startGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.state = createGameState();

    // Сообщаем игрокам о старте
    room.players.forEach((ws, idx) => {
        ws.send(JSON.stringify({
            type: 'start',
            playerIndex: idx,
            cols: COLS,
            rows: ROWS
        }));
    });

    // Запускаем игровой цикл
    if (room.interval) clearInterval(room.interval);
    room.interval = setInterval(() => tickRoom(roomId), TICK_MS);
}

// ============================================================
//  Подключение клиента
// ============================================================
wss.on('connection', ws => {
    console.log('👤 Клиент подключился');
    ws.roomId = null;

    ws.on('message', raw => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }

        // -------- Создать комнату --------
        if (msg.type === 'create') {
            const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            rooms[roomId] = {
                players: [ws],
                state: null,
                interval: null
            };
            ws.roomId = roomId;

            ws.send(JSON.stringify({
                type: 'created',
                roomId: roomId
            }));

            console.log(`🏠 Комната ${roomId} создана`);
        }

        // -------- Войти в комнату --------
        else if (msg.type === 'join') {
            const roomId = msg.roomId.toUpperCase();
            const room = rooms[roomId];

            if (!room) {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
                return;
            }

            if (room.players.length >= 2) {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' }));
                return;
            }

            room.players.push(ws);
            ws.roomId = roomId;

            ws.send(JSON.stringify({
                type: 'joined',
                roomId: roomId
            }));

            console.log(`👥 Игрок вошёл в комнату ${roomId} (${room.players.length}/2)`);

            // Если оба на месте — старт
            if (room.players.length === 2) {
                startGame(roomId);
            }
        }

        // -------- Управление --------
        else if (msg.type === 'input') {
            const room = rooms[ws.roomId];
            if (!room || !room.state) return;

            const playerIdx = room.players.indexOf(ws);
            if (playerIdx === -1) return;

            const snake = room.state.snakes[playerIdx];
            if (!snake || !snake.alive) return;

            const d = msg.dir;
            // Нельзя развернуться на 180°
            if (d.x === -snake.dir.x && d.y === -snake.dir.y) return;

            snake.nextDir = d;
        }
    });

    ws.on('close', () => {
        console.log('👋 Клиент отключился');

        const roomId = ws.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        room.players = room.players.filter(p => p !== ws);

        // Если игрок вышел — игра останавливается
        if (room.interval) {
            clearInterval(room.interval);
            room.interval = null;
        }

        // Уведомляем второго игрока
        room.players.forEach(p => {
            if (p.readyState === WebSocket.OPEN) {
                p.send(JSON.stringify({
                    type: 'opponentLeft'
                }));
            }
        });

        // Если комната пуста — удаляем
        if (room.players.length === 0) {
            delete rooms[roomId];
            console.log(`🗑 Комната ${roomId} удалена`);
        }
    });
});