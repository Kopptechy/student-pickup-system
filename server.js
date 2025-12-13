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

                // Send current pending pickups for this class (including merged source classes)
                const pendingPickups = await db.getPendingPickupsForDisplay(year, className);

                // Also get merge info to send to the display
                const sourceClasses = await db.getSourceClasses(year, className);

                ws.send(JSON.stringify({
                    type: 'initial',
                    pickups: pendingPickups,
                    mergedClasses: sourceClasses,
                    serverTime: Date.now() // For time synchronization
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

// Broadcast pickup to class AND any host class it's merged into
// Broadcast pickup to class AND any host class it's merged into
async function broadcastToClassWithMerge(year, className, data) {
    // First broadcast to the original class
    broadcastToClass(year, className, data);

    // Check if this class is merged into a host class
    const hostInfo = await db.getHostClass(year, className);
    if (hostInfo) {
        // Also broadcast to the host class display
        broadcastToClass(hostInfo.host_year, hostInfo.host_class, data);
        console.log(`Also broadcasted to host class: year${hostInfo.host_year}-${hostInfo.host_class}`);
    }
}

// Broadcast merge update to affected displays
function broadcastMergeUpdate(year, hostClass, sourceClasses) {
    const classKey = `year${year}-${hostClass}`;
    const connections = classConnections.get(classKey);

    if (connections) {
        const message = JSON.stringify({
            type: 'merge_update',
            mergedClasses: sourceClasses
        });
        connections.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
        console.log(`Sent merge update to ${classKey}`);
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

// Get all students in a year
app.get('/api/students/year/:year', async (req, res) => {
    try {
        const { year } = req.params;
        const students = await db.getStudentsByYear(parseInt(year));
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

        // Broadcast to the specific class (and host class if merged)
        await broadcastToClassWithMerge(year, className, {
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
        // Workaround: Delete pickups first to avoid foreign key constraint
        await db.pool.query('DELETE FROM pickups WHERE student_id = $1', [id]);
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

// ==================== CLASS MERGE API ROUTES ====================

// Get all active merges
app.get('/api/merges', async (req, res) => {
    try {
        const merges = await db.getActiveMerges();
        res.json(merges);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get merges where source is in a specific year (for UI filtering)
app.get('/api/merges/:year', async (req, res) => {
    try {
        const { year } = req.params;
        const merges = await db.getMergesForYear(parseInt(year));
        res.json(merges);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new merge
app.post('/api/merges', async (req, res) => {
    try {
        const { sourceYear, sourceClass, hostYear, hostClass } = req.body;

        // Validation: cannot merge same class to itself
        if (sourceYear === hostYear && sourceClass === hostClass) {
            return res.status(400).json({ error: 'Source and host class cannot be the same' });
        }

        // Check if source is already merged
        const existingSource = await db.isSourceClass(sourceYear, sourceClass);
        if (existingSource) {
            return res.status(400).json({ error: `${sourceClass} (Year ${sourceYear}) is already merged` });
        }

        // Check if source is being used as a host
        const sourceIsHost = await db.isHostClass(sourceYear, sourceClass);
        if (sourceIsHost) {
            return res.status(400).json({ error: `${sourceClass} (Year ${sourceYear}) is hosting and cannot be merged` });
        }

        // Check if host is merged elsewhere (optional, but prevents chains/loops)
        const hostIsSource = await db.isSourceClass(hostYear, hostClass);
        if (hostIsSource) {
            return res.status(400).json({ error: `Host class ${hostClass} (Year ${hostYear}) is already merged elsewhere` });
        }

        const merge = await db.createMerge(sourceYear, sourceClass, hostYear, hostClass);

        // Notify the host display
        // We need to fetch any existing pending pickups from the source class to show on the host
        const sourcePickups = await db.getPendingPickupsByClass(sourceYear, sourceClass);

        // Notify host about the new merge and send current pickups
        const hostClassKey = `year${hostYear}-${hostClass}`;
        const connections = classConnections.get(hostClassKey);

        if (connections) {
            // Send update to refresh header
            const allSources = await db.getSourceClasses(hostYear, hostClass);
            const updateMsg = JSON.stringify({
                type: 'merge_update',
                mergedClasses: allSources
            });

            connections.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(updateMsg);

                    // Also send the existing pickups from the source class
                    sourcePickups.forEach(pickup => {
                        client.send(JSON.stringify({
                            type: 'new_pickup',
                            pickup: pickup
                        }));
                    });
                }
            });
        }

        res.json({ success: true, merge });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete a merge (un-merge)
app.delete('/api/merges/:sourceYear/:sourceClass', async (req, res) => {
    try {
        const { sourceYear, sourceClass } = req.params;

        // Get the host before deleting so we can notify them
        const hostInfo = await db.getHostClass(parseInt(sourceYear), sourceClass);

        const deleted = await db.deleteMerge(parseInt(sourceYear), sourceClass);

        // Notify the host display that merge is removed
        if (hostInfo) {
            const { host_year, host_class } = hostInfo;
            const remainingSourceClasses = await db.getSourceClasses(host_year, host_class);
            broadcastMergeUpdate(host_year, host_class, remainingSourceClasses);
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SCHEDULED TASKS ====================

// Clear old pickups (run daily)
setInterval(async () => {
    try {
        await db.clearOldPickups();
        console.log('Cleared old acknowledged pickups');
    } catch (error) {
        console.error('Error clearing old pickups:', error);
    }
}, 24 * 60 * 60 * 1000);

// Auto-clear merges at 6 PM Nigerian time (WAT = UTC+1)
// Check every minute if it's 6 PM
let lastMergeClearDate = null;
setInterval(async () => {
    try {
        const now = new Date();
        // Nigerian time is UTC+1
        const nigerianHour = (now.getUTCHours() + 1) % 24;
        const today = now.toDateString();

        // Clear at 6 PM (18:00) Nigerian time, once per day
        if (nigerianHour === 18 && lastMergeClearDate !== today) {
            const count = await db.clearAllMerges();
            lastMergeClearDate = today;
            console.log(`[6 PM Nigerian time] Auto-cleared ${count} class merges`);

            // Broadcast to all connected displays that merges are cleared
            classConnections.forEach((connections, classKey) => {
                const message = JSON.stringify({
                    type: 'merge_update',
                    mergedClasses: []
                });
                connections.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
            });
        }
    } catch (error) {
        console.error('Error auto-clearing merges:', error);
    }
}, 60 * 1000); // Check every minute

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
