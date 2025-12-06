const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PickupDatabase = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let db;
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active WebSocket connections by class
const classConnections = new Map();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'subscribe') {
                // Subscribe to a specific class
                const { year, className } = data;
                const classKey = `year${year}-${className}`;

                if (!classConnections.has(classKey)) {
                    classConnections.set(classKey, new Set());
                }
                classConnections.get(classKey).add(ws);

                ws.classKey = classKey;
                console.log(`Client subscribed to ${classKey}`);

                // Send current pending pickups for this class
                const pendingPickups = await db.getPendingPickupsByClass(year, className);
                ws.send(JSON.stringify({
                    type: 'initial',
                    pickups: pendingPickups
                }));
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        // Remove connection from class subscriptions
        if (ws.classKey && classConnections.has(ws.classKey)) {
            classConnections.get(ws.classKey).delete(ws);
            console.log(`Client unsubscribed from ${ws.classKey}`);
        }
    });

    // Send heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
    }, 30000);

    ws.on('close', () => clearInterval(heartbeat));
});

// Broadcast pickup to specific class
function broadcastToClass(year, className, data) {
    const classKey = `year${year}-${className}`;
    const connections = classConnections.get(classKey);

    if (connections) {
        const message = JSON.stringify(data);
        connections.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
        console.log(`Broadcasted to ${classKey}: ${connections.size} clients`);
    }
}

// API Routes

// Get all students
app.get('/api/students', async (req, res) => {
    try {
        const students = await db.getAllStudents();
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get students by class
app.get('/api/students/:year/:class', async (req, res) => {
    try {
        const { year, class: className } = req.params;
        const students = await db.getStudentsByClass(parseInt(year), className);
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all years
app.get('/api/years', async (req, res) => {
    try {
        const years = await db.getYears();
        res.json(years);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get classes for a year
app.get('/api/classes/:year', async (req, res) => {
    try {
        const { year } = req.params;
        const classes = await db.getClassesByYear(parseInt(year));
        res.json(classes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new pickup
app.post('/api/pickups', async (req, res) => {
    try {
        const { student_id, student_name, year, class: className } = req.body;

        const pickupData = {
            id: uuidv4(),
            student_id,
            student_name,
            year,
            class: className,
            timestamp: Date.now()
        };

        await db.addPickup(pickupData);

        // Broadcast to the specific class
        broadcastToClass(year, className, {
            type: 'new_pickup',
            pickup: pickupData
        });

        res.json({ success: true, pickup: pickupData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all pending pickups
app.get('/api/pickups/pending', async (req, res) => {
    try {
        const pickups = await db.getPendingPickups();
        res.json(pickups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get pending pickups for a class
app.get('/api/pickups/pending/:year/:class', async (req, res) => {
    try {
        const { year, class: className } = req.params;
        const pickups = await db.getPendingPickupsByClass(parseInt(year), className);
        res.json(pickups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Acknowledge a pickup
app.post('/api/pickups/:id/acknowledge', async (req, res) => {
    try {
        const { id } = req.params;

        // Get pickup details before acknowledging
        const allPickups = await db.getPendingPickups();
        const pickup = allPickups.find(p => p.id === id);

        if (!pickup) {
            return res.status(404).json({ error: 'Pickup not found' });
        }

        await db.acknowledgePickup(id);

        // Broadcast acknowledgment to the class
        broadcastToClass(pickup.year, pickup.class, {
            type: 'pickup_acknowledged',
            pickupId: id
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get pickup history
app.get('/api/pickups/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const history = await db.getPickupHistory(limit);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add a new student
app.post('/api/students', async (req, res) => {
    try {
        const { name, year, class: className } = req.body;
        const result = await db.addStudent(name, year, className);
        res.json({ success: true, id: result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Batch add students
app.post('/api/students/batch', async (req, res) => {
    try {
        const { names, year, class: className } = req.body;

        // Validate input
        if (!names || !Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'Names array is required and must not be empty' });
        }

        if (!year || !className) {
            return res.status(400).json({ error: 'Year and class are required' });
        }

        // Prepare student objects
        const students = names
            .filter(name => name && name.trim()) // Filter out empty names
            .map(name => ({
                name: name.trim(),
                year: parseInt(year),
                class: className
            }));

        if (students.length === 0) {
            return res.status(400).json({ error: 'No valid student names provided' });
        }

        // Add students in batch
        const count = await db.addStudentsBatch(students);

        res.json({
            success: true,
            count: count,
            message: `Successfully added ${count} student${count !== 1 ? 's' : ''}`
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a student
app.put('/api/students/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, year, class: className } = req.body;
        await db.updateStudent(id, name, year, className);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a student
app.delete('/api/students/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.deleteStudent(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete all students
app.delete('/api/students', async (req, res) => {
    try {
        const count = await db.deleteAllStudents();
        res.json({ success: true, count: count, message: `Deleted ${count} students` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Clear old pickups (run daily)
setInterval(async () => {
    try {
        await db.clearOldPickups();
        console.log('Cleared old acknowledged pickups');
    } catch (error) {
        console.error('Error clearing old pickups:', error);
    }
}, 24 * 60 * 60 * 1000);

// Initialize database and start server
async function startServer() {
    try {
        // Initialize database
        db = new PickupDatabase();
        await db.initializeTables();

        // Start server
        server.listen(PORT, () => {
            console.log(`\n🚀 Student Pickup System running on http://localhost:${PORT}`);
            console.log(`\n📍 Access points:`);
            console.log(`   Reception: http://localhost:${PORT}/reception.html`);
            console.log(`   Display:   http://localhost:${PORT}/display.html?year=7&class=blue`);
            console.log(`   Admin:     http://localhost:${PORT}/admin.html`);
            console.log(`\n✅ Database initialized and connected`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await db.close();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Start the application
startServer();
